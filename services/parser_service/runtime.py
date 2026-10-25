"""Persistent single-worker queue, resource checks and isolated OCR subprocesses."""
from __future__ import annotations

import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import queue
import re
import shutil
import signal
import subprocess
import threading
import time
import uuid

from . import ENGINE, VERSION
from .exporter import save_json, zip_result

GIB = 1024 ** 3
TERMINAL = {"completed", "failed", "cancelled"}


def atomic_json(path, value):
    path = Path(path)
    temporary = path.with_name(path.name + ".tmp")
    save_json(temporary, value)
    os.replace(temporary, path)


def parser_build():
    files = {path.name: hashlib.sha256(path.read_bytes()).hexdigest()
             for path in sorted(Path(__file__).parent.glob("*.py"))}
    return {"files": files, "sha256": hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()}


def model_artifact(path):
    ignored_parts = {".locks", ".cache", ".git", ".no_exist", "__pycache__", "logs", "runs", "tmp"}
    return not any(part in ignored_parts for part in path.parts) and path.suffix.lower() not in {".lock", ".log", ".tmp", ".pyc", ".pyo", ".incomplete"}


def resource_snapshot(base, gpu_index=0):
    available = 0
    if Path("/proc/meminfo").exists():
        mem = {line.split(":")[0]: int(line.split()[1]) * 1024 for line in Path("/proc/meminfo").read_text().splitlines()}
        available = mem.get("MemAvailable", 0)
        cgroup = Path("/sys/fs/cgroup")
        try:
            limit = (cgroup / "memory.max").read_text().strip()
            if limit != "max":
                available = min(available, max(0, int(limit) - int((cgroup / "memory.current").read_text())))
        except OSError:
            pass
    result = {"epoch": time.time(), "memory_available_bytes": available, "disk_free_bytes": shutil.disk_usage(base).free, "gpu_index": gpu_index, "gpu": [], "compute_processes": []}
    try:
        query = subprocess.run(["nvidia-smi", "--query-gpu=index,memory.used,memory.free", "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=10, check=True)
        result["gpu"] = [dict(zip(["index", "used_mib", "free_mib"], [int(s.strip()) for s in line.split(",")])) for line in query.stdout.strip().splitlines() if line.strip()]
        query = subprocess.run(["nvidia-smi", "--query-compute-apps=gpu_uuid,pid,process_name,used_memory", "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=10, check=True)
        result["compute_processes"] = [line for line in query.stdout.strip().splitlines() if line.strip()]
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        result["gpu_error"] = type(error).__name__
    return result


def check_resources(snapshot):
    gpu = next((g for g in snapshot["gpu"] if g["index"] == snapshot["gpu_index"]), None)
    if gpu is None:
        raise RuntimeError("GPU unavailable: nvidia-smi did not report the configured device")
    if snapshot["compute_processes"]:
        raise RuntimeError("GPU busy: external compute processes detected")
    if snapshot["memory_available_bytes"] < 32 * GIB:
        raise RuntimeError("Resource preflight failed: available RAM below 32 GiB")
    if gpu["free_mib"] < 16 * 1024:
        raise RuntimeError("Resource preflight failed: available VRAM below 16 GiB")
    if snapshot["disk_free_bytes"] < 5 * GIB:
        raise RuntimeError("Resource preflight failed: available disk below 5 GiB")


def pdf_page_count(path, max_pages=256):
    import pdfplumber
    with pdfplumber.open(path) as document:
        count = len(document.pages)
        if not 0 < count <= max_pages:
            raise ValueError(f"PDF page count must be between 1 and {max_pages}")
        return count


def validate_raw(engine, path, pages):
    value = json.loads(Path(path).read_text())
    if engine == "glm":
        entries = value.get("pages") if isinstance(value, dict) else value
        if not isinstance(entries, list) or len(entries) != pages:
            raise ValueError("GLM raw page coverage mismatch")
        for entry in entries:
            blocks = entry.get("blocks") if isinstance(entry, dict) else entry
            if not isinstance(blocks, list):
                raise ValueError("GLM raw invalid blocks")
    else:
        entries = value.get("pages", [])
        if not value.get("is_full_document") or [p.get("page_idx") for p in entries] != list(range(pages)):
            raise ValueError("MinerU raw page coverage mismatch")
        if any(not isinstance(p.get("blocks"), list) for p in entries):
            raise ValueError("MinerU raw invalid blocks")
    return value


def raw_assets_manifest(json_path):
    root = Path(json_path).parent
    extensions = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".svg"}
    return {str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(root.rglob("*"))
            if path.is_file() and path.suffix.lower() in extensions}


def descendant_pids(pid):
    parents = {}
    for entry in Path("/proc").glob("[0-9]*/stat"):
        try:
            raw = entry.read_text()
            parents[int(entry.parent.name)] = int(raw[raw.rfind(")") + 2:].split()[1])
        except (OSError, ValueError, IndexError):
            pass
    descendants, pending = [], [pid]
    while pending:
        parent = pending.pop()
        children = [child for child, ppid in parents.items() if ppid == parent]
        descendants.extend(children)
        pending.extend(children)
    return descendants


def process_identity(pid):
    try:
        raw = Path(f"/proc/{pid}/stat").read_text()
        fields = raw[raw.rfind(")") + 2:].split()
        return None if fields[0] == "Z" else fields[19]
    except (OSError, IndexError):
        return None


def capture_owned(process, owned):
    for pid in [process.pid] + (descendant_pids(process.pid) if Path("/proc").exists() else []):
        identity = process_identity(pid)
        if identity:
            owned[pid] = identity


def stop_process(process, owned=None):
    owned = owned if owned is not None else {}
    capture_owned(process, owned)
    def alive():
        return [pid for pid, identity in owned.items() if process_identity(pid) == identity]
    def send(signum):
        for pid in reversed(alive()):
            try:
                os.kill(pid, signum)
            except ProcessLookupError:
                pass
        # macOS test/runtime fallback has no procfs; the live Popen identity owns
        # its original session, so only that live session can be signalled.
        if not Path("/proc").exists() and process.poll() is None:
            try:
                os.killpg(process.pid, signum)
            except ProcessLookupError:
                pass
    if process.poll() is not None and not alive():
        return
    send(signal.SIGTERM)
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline and (process.poll() is None or alive()):
        threading.Event().wait(.1)
    send(signal.SIGKILL)
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        raise RuntimeError("Owned parser process did not stop")


class JobCancelled(Exception):
    pass


class Runtime:
    def __init__(self, config, processor=None, start_worker=True):
        self.config = dict(config)
        self.base = Path(config["base"]).resolve()
        self.base.mkdir(parents=True, exist_ok=True)
        self.runs = self.base / "runs/parser-service"
        self.cache = self.base / "cache/parser-service"
        self.runs.mkdir(parents=True, exist_ok=True)
        self.cache.mkdir(parents=True, exist_ok=True)
        self.lock_file = (self.runs / "service.lock").open("a+")
        import fcntl
        try:
            fcntl.flock(self.lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self.lock_file.close()
            raise RuntimeError("Another parser service already owns this run directory")
        self.jobs = {}
        self.guard = threading.RLock()
        self.queue = queue.Queue()
        self.cancel_events = {}
        self.closed = threading.Event()
        self.current = None
        self.current_owned = {}
        self._default_processor = processor is None
        self.processor = self.process if self._default_processor else processor
        self.python = str(config.get("python") or self.base / "conda/envs/guzi-scholar/bin/python")
        self.protocol = self.model_protocol()
        self.build = parser_build()
        for path in sorted(self.runs.glob("*/state.json")):
            state = json.loads(path.read_text())
            job_id = path.parent.name
            if not re.fullmatch(r"[a-f0-9]{32}", job_id):
                continue
            if state.get("status") == "running":
                state.update(status="failed", stage="interrupted", error="Service restarted while the job was running", finished_epoch=time.time())
                atomic_json(path, state)
            self.jobs[job_id] = state
            self.cancel_events[job_id] = threading.Event()
            if state.get("status") == "queued":
                self.queue.put(job_id)
        self.worker = threading.Thread(target=self.work, name="guzi-parser-worker", daemon=True) if start_worker else None
        if self.worker:
            self.worker.start()

    def model_protocol(self):
        versions = {}
        for name in ["torch", "transformers", "vllm", "mineru", "glmocr"]:
            try:
                versions[name] = importlib.metadata.version(name)
            except importlib.metadata.PackageNotFoundError:
                versions[name] = "unavailable"
        scripts = {}
        script_paths = {self.base / name for name in ["scripts/run_glm_job.py", "models/glm-models.json", "models/mineru4/config.yaml", "mineru4/config.yaml"]}
        for folder in ["scripts/glm", "scripts/mineru"]:
            root = self.base / folder
            script_paths.update(path for path in root.rglob("*") if path.is_file() and path.suffix.lower() in {".py", ".sh", ".json", ".yaml", ".yml"})
        for path in sorted(script_paths):
            scripts[str(path.relative_to(self.base))] = hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else "missing"
        model_files = []
        for folder in self.config.get("model_directories", ["models"]):
            root = (self.base / folder).resolve()
            if not Path(folder).is_absolute() and not root.is_relative_to(self.base):
                raise ValueError("External model directory must be an explicit absolute path")
            for path in sorted(root.rglob("*")):
                if path.is_file() and model_artifact(path.relative_to(root)):
                    stat = path.stat()
                    name = path.relative_to(self.base) if path.is_relative_to(self.base) else path
                    model_files.append([str(name), stat.st_size, stat.st_mtime_ns])
        protocol = {"revision": self.config.get("model_protocol_revision", "glm-native16384-mineru4-standard-v1"), "packages": versions, "scripts": scripts, "model_files": model_files, "glm": {"rotary_native": 1, "max_model_len": 16384, "gpu_memory_utilization": .15}, "mineru": {"mode": "standard"}}
        protocol["sha256"] = hashlib.sha256(json.dumps(protocol, sort_keys=True).encode()).hexdigest()
        return protocol

    def environment(self, cpu=False):
        env = os.environ.copy()
        env["BASE"] = str(self.base)
        cache = self.base / "cache/fav1"
        temporary = self.base / "tmp/fav1"
        cache.mkdir(parents=True, exist_ok=True)
        temporary.mkdir(parents=True, exist_ok=True)
        env.update({"XDG_CACHE_HOME": str(cache), "HF_HOME": str(self.base / "cache/huggingface"), "HF_HUB_CACHE": str(self.base / "cache/huggingface/hub"), "HUGGINGFACE_HUB_CACHE": str(self.base / "cache/huggingface/hub"), "TRANSFORMERS_CACHE": str(self.base / "cache/huggingface/hub"), "GLM_VENV": str(Path(self.python).parent.parent), "MINERU4_VENV": str(Path(self.python).parent.parent), "TORCH_HOME": str(cache / "torch"), "TORCHINDUCTOR_CACHE_DIR": str(cache / "torchinductor"), "TORCH_EXTENSIONS_DIR": str(cache / "torch-extensions"), "CUDA_CACHE_PATH": str(cache / "cuda"), "TRITON_CACHE_DIR": str(cache / "triton"), "TRITON_HOME": str(cache / "triton"), "TRITON_DUMP_DIR": str(cache / "triton-dump"), "TRITON_OVERRIDE_DIR": str(cache / "triton-override"), "FLASHINFER_WORKSPACE_BASE": str(cache / "flashinfer"), "VLLM_CACHE_ROOT": str(cache / "vllm"), "NUMBA_CACHE_DIR": str(cache / "numba"), "MPLCONFIGDIR": str(cache / "matplotlib"), "TMPDIR": str(temporary), "TEMP": str(temporary), "TMP": str(temporary), "GLM_ROTARY_NATIVE": "1", "GLM_MAX_MODEL_LEN": "16384", "GLM_GPU_MEMORY_UTILIZATION": "0.15", "CUDA_VISIBLE_DEVICES": str(self.config.get("gpu_index", 0)), "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "HF_DATASETS_OFFLINE": "1", "PYTHONUNBUFFERED": "1", "PYTHONDONTWRITEBYTECODE": "1"})
        for key in ["GLM_DISABLE_MTP", "GLM_DIAGNOSTICS"]:
            env.pop(key, None)
        overlay = str(self.config.get("cpu_dependencies") or self.base / "envs/fusion-auto-cpu")
        env["PYTHONPATH"] = os.pathsep.join([str(self.base), overlay]) if cpu else str(self.base)
        return env

    def path(self, job_id):
        if not re.fullmatch(r"[a-f0-9]{32}", job_id):
            raise KeyError(job_id)
        return self.runs / job_id

    def update(self, job_id, **changes):
        with self.guard:
            self.jobs[job_id].update(changes)
            atomic_json(self.path(job_id) / "state.json", self.jobs[job_id])
            return dict(self.jobs[job_id])

    def get(self, job_id):
        self.path(job_id)
        with self.guard:
            if job_id not in self.jobs:
                raise KeyError(job_id)
            return dict(self.jobs[job_id])

    def submit(self, data, filename, client_id=None):
        if not data.startswith(b"%PDF-"):
            raise ValueError("Upload must be a PDF")
        with self.guard:
            if sum(s["status"] not in TERMINAL for s in self.jobs.values()) >= int(self.config.get("max_queue", 32)):
                raise RuntimeError("Queue is full")
            job_id = uuid.uuid4().hex
            directory = self.path(job_id)
            directory.mkdir()
            (directory / "source.pdf").write_bytes(data)
            pages = pdf_page_count(directory / "source.pdf", int(self.config.get("max_pages", 256)))
            sha = hashlib.sha256(data).hexdigest()
            state = {"id": job_id, "status": "queued", "stage": "queued", "progress": 0, "created_epoch": time.time(), "source_filename": filename, "source_sha256": sha, "page_count": pages, "client_job_id": client_id, "result_url": f"/v1/jobs/{job_id}/result", "execution": "single-gpu-sequential", "model_protocol_sha256": self.protocol["sha256"], "stages": []}
            state["parser_build_sha256"] = self.build["sha256"]
            self.jobs[job_id] = state
            self.cancel_events[job_id] = threading.Event()
            atomic_json(directory / "state.json", state)
            atomic_json(directory / "model-protocol.json", self.protocol)
            self.queue.put(job_id)
            return dict(state)

    def cancel(self, job_id):
        with self.guard:
            state = self.get(job_id)
            if state["status"] in TERMINAL:
                return state
            self.cancel_events[job_id].set()
            if state["status"] == "queued":
                return self.update(job_id, status="cancelled", stage="cancelled", finished_epoch=time.time())
            return self.update(job_id, cancellation_requested=True)

    def missing_dependencies(self):
        if not self._default_processor:
            return []
        required = ["scripts/run_glm_job.py", "scripts/glm/serve_glm.sh", "scripts/glm/run_glm.py",
                    "scripts/mineru/env.sh", "scripts/mineru/run_mineru.sh", "scripts/mineru/record_run.py",
                    "scripts/mineru/timed_command.py", "scripts/mineru/export_and_check.py",
                    "models/glm-models.json", "mineru4/config.yaml"]
        missing = [name for name in required if not (self.base / name).is_file()]
        if shutil.which(self.python) is None:
            missing.append("python")
        return missing

    def health(self):
        with self.guard:
            statuses = [s["status"] for s in self.jobs.values()]
            missing = self.missing_dependencies()
            return {"status": "ok", "engine": ENGINE, "version": VERSION, "ready": not missing and not self.closed.is_set() and bool(self.worker and self.worker.is_alive()), "missing_dependencies": missing, "queue": {"queued": statuses.count("queued"), "running": statuses.count("running"), "completed": statuses.count("completed"), "failed": statuses.count("failed")}, "model_loading": "on-demand", "execution": "single-gpu-sequential", "model_protocol_sha256": self.protocol["sha256"]}

    def work(self):
        while not self.closed.is_set():
            try:
                job_id = self.queue.get(timeout=.2)
            except queue.Empty:
                continue
            try:
                if self.cancel_events[job_id].is_set():
                    continue
                started = time.monotonic()
                self.update(job_id, status="running", stage="initial_checks", started_epoch=time.time())
                try:
                    self.processor(job_id)
                    if self.cancel_events[job_id].is_set():
                        raise JobCancelled()
                    self.update(job_id, status="completed", stage="completed", progress=1, finished_epoch=time.time(), total_seconds=time.monotonic()-started)
                except JobCancelled:
                    self.update(job_id, status="cancelled", stage="cancelled", finished_epoch=time.time(), total_seconds=time.monotonic()-started)
                except Exception as error:
                    self.update(job_id, status="failed", error=str(error), error_type=type(error).__name__, finished_epoch=time.time(), total_seconds=time.monotonic()-started)
            finally:
                self.queue.task_done()

    def run_stage(self, job_id, name, command, gpu=False):
        if not gpu:
            return self._run_stage(job_id, name, command, gpu=False)
        import fcntl
        with (self.base / "runs/gpu.lock").open("a+") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                atomic_json(self.path(job_id) / f"{name}-gpu-lock.json", {"acquired": False, "epoch": time.time()})
                raise RuntimeError("GPU busy: shared runs/gpu.lock is owned by another task")
            atomic_json(self.path(job_id) / f"{name}-gpu-lock.json", {"acquired": True, "epoch": time.time(), "service_pid": os.getpid()})
            try:
                return self._run_stage(job_id, name, command, gpu=True)
            finally:
                fcntl.flock(lock, fcntl.LOCK_UN)

    def _run_stage(self, job_id, name, command, gpu=False):
        event = self.cancel_events[job_id]
        if event.is_set() or self.closed.is_set():
            raise JobCancelled()
        directory = self.path(job_id)
        before = resource_snapshot(self.base, int(self.config.get("gpu_index", 0))) if gpu else {"epoch": time.time(), "disk_free_bytes": shutil.disk_usage(self.base).free}
        atomic_json(directory / f"{name}-preflight.json", before)
        if gpu:
            check_resources(before)
        started = time.monotonic()
        entry = {"id": name, "command": list(map(str, command)), "started_epoch": time.time(), "status": "running", "gpu": gpu, "cache_hit": False}
        self.update(job_id, stage=name, progress={"glm": .05, "mineru": .35, "fusion": .7, "export": .85}[name], stages=self.get(job_id)["stages"]+[entry])
        with (directory / f"{name}.log").open("w") as log:
            process = subprocess.Popen(list(map(str, command)), env=self.environment(cpu=not gpu), cwd=self.base, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            self.current = process
            owned = {}
            self.current_owned = owned
            capture_owned(process, owned)
            atomic_json(directory / f"{name}-process.json", {"pid": process.pid, "pgid": os.getpgid(process.pid), "command": entry["command"], "started_epoch": time.time()})
            deadline = time.monotonic() + int(self.config.get("stage_timeout_seconds", 10800))
            try:
                while process.poll() is None:
                    capture_owned(process, owned)
                    if event.wait(.2) or self.closed.is_set():
                        raise JobCancelled()
                    if time.monotonic() > deadline:
                        raise TimeoutError(f"{name} exceeded stage timeout")
                if process.returncode:
                    raise RuntimeError(f"{name} exited with {process.returncode}; see {name}.log")
            finally:
                stop_process(process, owned)
                atomic_json(directory / f"{name}-owned-processes.json", {"process_start_times": owned, "remaining": [pid for pid, identity in owned.items() if process_identity(pid) == identity]})
                self.current = None
                self.current_owned = {}
                entry.update(seconds=time.monotonic()-started, exit_code=process.returncode, status="completed" if process.returncode == 0 and not event.is_set() else "failed")
                state = self.get(job_id)
                state["stages"][-1] = entry
                self.update(job_id, stages=state["stages"])
        if gpu:
            after = resource_snapshot(self.base, int(self.config.get("gpu_index", 0)))
            atomic_json(directory / f"{name}-after.json", after)
            if after["compute_processes"]:
                raise RuntimeError(f"{name}: GPU processes remain after stage exit")

    def cache_path(self, sha, engine):
        return self.cache / sha / self.protocol["sha256"] / f"{engine}.json"

    def raw(self, job_id, engine):
        started = time.monotonic()
        state, directory = self.get(job_id), self.path(job_id)
        marker = self.cache_path(state["source_sha256"], engine)
        if marker.exists():
            cached = json.loads(marker.read_text())
            source = Path(cached["json"])
            if cached["model_protocol_sha256"] != self.protocol["sha256"] or cached["source_sha256"] != state["source_sha256"]:
                raise ValueError("Raw cache identity mismatch")
            if not source.resolve().is_relative_to(self.base):
                raise ValueError("Raw cache outside base")
            if hashlib.sha256(source.read_bytes()).hexdigest() != cached["json_sha256"]:
                raise ValueError("Raw cache changed since validation")
            validate_raw(engine, source, state["page_count"])
            if raw_assets_manifest(source) != cached.get("asset_sha256", {}):
                raise ValueError("Raw cache image assets changed since validation")
            self.update(job_id, stages=state["stages"]+[{"id": engine, "cache_hit": True, "cache_source": str(marker), "raw_source": str(source), "original_inference_seconds": cached.get("inference_seconds"), "seconds": time.monotonic()-started, "status": "completed"}])
            return source
        pdf = directory / "source.pdf"
        if engine == "glm":
            command = [self.python, self.base / "scripts/run_glm_job.py", pdf, directory / "glm", "--base", self.base]
            path = directory / "glm/output/source/source.json"
        else:
            command = ["bash", self.base / "scripts/mineru/run_mineru.sh", pdf, directory / "mineru", "standard", str(state["page_count"])]
            path = directory / "mineru/extracted/structured_content.json"
        self.run_stage(job_id, engine, command, gpu=True)
        validate_raw(engine, path, state["page_count"])
        marker.parent.mkdir(parents=True, exist_ok=True)
        atomic_json(marker, {"source_sha256": state["source_sha256"], "model_protocol_sha256": self.protocol["sha256"], "page_count": state["page_count"], "engine": engine, "json": str(path), "json_sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "asset_sha256": raw_assets_manifest(path), "source_job": job_id, "inference_seconds": self.get(job_id)["stages"][-1]["seconds"], "validated_epoch": time.time()})
        return path

    def process(self, job_id):
        if parser_build() != self.build:
            raise RuntimeError("Parser files changed; restart the service before processing")
        directory = self.path(job_id)
        state = self.get(job_id)
        glm, mineru = self.raw(job_id, "glm"), self.raw(job_id, "mineru")
        self.run_stage(job_id, "fusion", [self.python, "-m", "services.parser_service.fusion", "--pdf", directory / "source.pdf", "--glm-json", glm, "--mineru-json", mineru, "--glm-assets", glm.parent, "--mineru-assets", mineru.parent, "--output", directory / "fusion"])
        self.run_stage(job_id, "export", [self.python, "-m", "services.parser_service.exporter", "--pdf", directory / "source.pdf", "--fusion-dir", directory / "fusion", "--output", directory / "result", "--title", state["source_filename"], "--job-id", job_id])
        provenance = {"source_sha256": state["source_sha256"], "model_protocol": self.protocol, "stages": self.get(job_id)["stages"], "execution": "single-gpu-sequential", "total_seconds_before_zip": time.time()-self.get(job_id)["started_epoch"]}
        provenance["parser_build"] = self.build
        atomic_json(directory / "result/provenance.json", provenance)
        zip_result(directory / "result", directory / "result.zip.tmp")
        os.replace(directory / "result.zip.tmp", directory / "result.zip")

    def close(self):
        self.closed.set()
        with self.guard:
            for job_id, state in self.jobs.items():
                if state["status"] == "running":
                    self.cancel_events[job_id].set()
        if self.worker:
            self.worker.join(timeout=20)
        if self.current is not None:
            stop_process(self.current, self.current_owned)
        self.lock_file.close()


def seed_raw_cache(config, pdf, run_dir, protocol_path):
    """Import evidence only if its recorded protocol and original PDF SHA agree."""
    runtime = Runtime(config, start_worker=False)
    try:
        run_dir, pdf = Path(run_dir).resolve(), Path(pdf).resolve()
        if not run_dir.is_relative_to(runtime.base) or not pdf.is_relative_to(runtime.base):
            raise ValueError("Seed inputs must be inside base")
        actual_protocol = json.loads(Path(protocol_path).read_text())
        if actual_protocol != runtime.protocol:
            raise ValueError("Model protocol does not exactly match current runtime")
        pipeline = json.loads((run_dir / "pipeline.json").read_text())
        sha = hashlib.sha256(pdf.read_bytes()).hexdigest()
        if pipeline.get("pdf_sha256") != sha or pipeline.get("status") not in {"success", "completed"}:
            raise ValueError("Seed pipeline must have succeeded with this exact PDF")
        pages = pdf_page_count(pdf, int(config.get("max_pages", 256)))
        results = []
        for engine, path in [("glm", run_dir / "glm/output" / pdf.stem / (pdf.stem+".json")), ("mineru", run_dir / "mineru/extracted/structured_content.json")]:
            validate_raw(engine, path, pages)
            stage = next((s for s in pipeline.get("stages", []) if s.get("id") == engine), {})
            if stage.get("status") not in {"success", "completed"}:
                raise ValueError(f"Seed {engine} stage did not succeed")
            marker = runtime.cache_path(sha, engine)
            marker.parent.mkdir(parents=True, exist_ok=True)
            evidence = {"source_sha256": sha, "model_protocol_sha256": runtime.protocol["sha256"], "page_count": pages, "engine": engine, "json": str(path), "json_sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "asset_sha256": raw_assets_manifest(path), "source_run": str(run_dir), "source_protocol": str(protocol_path), "inference_seconds": stage.get("seconds"), "validated_epoch": time.time()}
            atomic_json(marker, evidence)
            results.append(evidence)
        return results
    finally:
        runtime.close()
