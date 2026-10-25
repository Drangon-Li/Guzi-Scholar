#!/usr/bin/env python3
"""Assemble the Windows x64 runtime on a Windows x64 build host."""

import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import struct
import subprocess
import sys
import urllib.request
import zipfile


APP = Path(__file__).resolve().parents[1]
REPO = APP.parents[1]
LOCK = json.loads((REPO / "platforms/windows/runtime-dependencies.json").read_text())
BUILD = APP / "build"
RUNTIME = BUILD / "windows-runtime"
CACHE = BUILD / "windows-downloads"
ENV = BUILD / "windows-pyinstaller-env"
JAVA_MODULES = "java.base,java.compiler,java.desktop,java.management,java.sql"


def run(command, **kwargs):
    print("+", subprocess.list2cmdline([str(part) for part in command]), flush=True)
    return subprocess.run([str(part) for part in command], check=True, **kwargs)


def require_x64_pe(filename):
    with Path(filename).open("rb") as stream:
        if stream.read(2) != b"MZ":
            raise RuntimeError(f"Windows PE executable required: {filename}")
        stream.seek(0x3C)
        offset = stream.read(4)
        if len(offset) != 4:
            raise RuntimeError(f"Invalid PE header: {filename}")
        stream.seek(struct.unpack("<I", offset)[0])
        if stream.read(6) != b"PE\0\0\x64\x86":
            raise RuntimeError(f"Windows x64 executable required: {filename}")


def verify_hash(filename, expected):
    actual = hashlib.sha256(Path(filename).read_bytes()).hexdigest()
    if actual != expected:
        raise RuntimeError(f"SHA-256 mismatch for {filename}: {actual}")


def download(url, filename, expected=None):
    filename.parent.mkdir(parents=True, exist_ok=True)
    if not filename.exists():
        temporary = filename.with_suffix(filename.suffix + ".download")
        try:
            with urllib.request.urlopen(url, timeout=300) as response, temporary.open("wb") as output:
                shutil.copyfileobj(response, output)
            if expected:
                verify_hash(temporary, expected)
            temporary.replace(filename)
        finally:
            temporary.unlink(missing_ok=True)
    if expected:
        verify_hash(filename, expected)
    return filename


def extract_file(archive, member, output):
    output.parent.mkdir(parents=True, exist_ok=True)
    with archive.open(member) as source, output.open("wb") as destination:
        shutil.copyfileobj(source, destination)


def prepare_toolchain():
    pandoc = LOCK["pandoc"]
    archive = download(pandoc["url"], CACHE / Path(pandoc["url"]).name, pandoc["sha256"])
    with zipfile.ZipFile(archive) as bundle:
        executable = [name for name in bundle.namelist() if Path(name).name == "pandoc.exe"]
        if len(executable) != 1:
            raise RuntimeError("Pandoc archive must contain exactly one pandoc.exe")
        extract_file(bundle, executable[0], RUNTIME / "pandoc/pandoc.exe")
    copying = download(
        f"https://raw.githubusercontent.com/jgm/pandoc/{pandoc['version']}/COPYING.md",
        CACHE / f"pandoc-{pandoc['version']}-COPYING.md",
    )
    if "GNU GENERAL PUBLIC LICENSE" not in copying.read_text(encoding="utf-8"):
        raise RuntimeError("Pandoc COPYING.md is missing the GPL license")
    (RUNTIME / "licenses/pandoc").mkdir(parents=True, exist_ok=True)
    shutil.copy2(copying, RUNTIME / "licenses/pandoc/COPYING.md")

    odl = LOCK["opendataloader"]
    archive = download(odl["url"], CACHE / Path(odl["url"]).name, odl["sha256"])
    jar = RUNTIME / "opendataloader-pdf-cli-0.0.0.jar"
    with zipfile.ZipFile(archive) as bundle:
        extract_file(bundle, f"opendataloader-pdf-cli-{odl['version']}.jar", jar)
        for name in bundle.namelist():
            if name in {"LICENSE", "NOTICE", "README.md"} or name.startswith("THIRD_PARTY/"):
                relative = Path(name)
                if relative.is_absolute() or ".." in relative.parts:
                    raise RuntimeError(f"Unsafe archive member: {name}")
                if not name.endswith("/"):
                    extract_file(bundle, name, RUNTIME / "licenses/opendataloader-pdf" / relative)
    verify_hash(jar, odl["jarSha256"])
    for name in ("LICENSE", "NOTICE"):
        if not (RUNTIME / "licenses/opendataloader-pdf" / name).is_file():
            raise RuntimeError(f"OpenDataLoader archive is missing {name}")


def prepare_python():
    python = ENV / "Scripts/python.exe"
    if python.exists():
        identity = run([python, "-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"],
                       capture_output=True, text=True).stdout.strip()
        if identity != LOCK["python"]:
            raise RuntimeError(f"Remove stale build environment {ENV}; Python {LOCK['python']} is required")
        require_x64_pe(python)
    else:
        run([sys.executable, "-m", "venv", ENV])
    run([python, "-m", "pip", "install", "--disable-pip-version-check", "--only-binary=:all:", *LOCK["pip"]])
    run([python, "-c", "import importlib.metadata as m, json, sys; "
         "pins=json.loads(sys.argv[1]); "
         "assert all(m.version(p.split('==')[0]) == p.split('==')[1] for p in pins)", json.dumps(LOCK["pip"])])
    ssl_policy = Path(run([python, "-c", "import ssl, pathlib; print(pathlib.Path(ssl.__file__).with_name('codex-rejected-cas.pem'))"],
                          capture_output=True, text=True).stdout.strip())
    args = [python, "-m", "PyInstaller", "--clean", "--noconfirm", "--onedir",
            "--python-option", "X utf8",
            "--name", "my-scholar-server", "--distpath", RUNTIME,
            "--workpath", BUILD / "windows-pyinstaller-work", "--specpath", BUILD,
            "--collect-binaries", "pymupdf", "--copy-metadata", "pymupdf",
            "--add-data", f"{APP / 'resources/licenses/pdf-runtime'}{os.pathsep}licenses/pdf-runtime"]
    if ssl_policy.is_file():
        args.extend(["--add-data", f"{ssl_policy}{os.pathsep}."])
    run([*args, APP / "server.py"], cwd=APP)
    ca = Path(run([python, "-c", "import certifi; print(certifi.where())"], capture_output=True, text=True).stdout.strip())
    shutil.copy2(ca, RUNTIME / "my-scholar-server/ca-certificates.crt")
    licenses = RUNTIME / "licenses/python"
    licenses.mkdir(parents=True, exist_ok=True)
    shutil.copy2(Path(sys.base_prefix) / "LICENSE.txt", licenses / "LICENSE.txt")
    run([python, "-c", "import importlib.metadata as m, pathlib, shutil, sys; "
         "out=pathlib.Path(sys.argv[1]); "
         "[(out / p).mkdir(parents=True, exist_ok=True) for p in ('certifi', 'pyinstaller')]; "
         "[(shutil.copy2(d.locate_file(f), out / p / pathlib.Path(f).name)) "
         "for p in ('certifi', 'pyinstaller') for d in [m.distribution(p)] "
         "for f in d.files if pathlib.Path(f).name.lower().startswith(('license', 'copying'))]", licenses])


def prepare_java(java_home):
    jar = RUNTIME / "opendataloader-pdf-cli-0.0.0.jar"
    renderer = RUNTIME / "pdf-renderer"
    renderer.mkdir(parents=True, exist_ok=True)
    run([java_home / "bin/javac.exe", "--release", "11", "-cp", jar, "-d", renderer,
         APP / "scripts/MyScholarPdfRenderer.java"])
    output = RUNTIME / "java"
    if output.exists():
        shutil.rmtree(output)
    run([java_home / "bin/jlink.exe", "--add-modules", JAVA_MODULES, "--strip-debug",
         "--no-header-files", "--no-man-pages", "--compress=zip-6", "--output", output])


def main():
    if sys.platform != "win32" or platform.machine().lower() not in {"amd64", "x86_64"} or struct.calcsize("P") != 8:
        raise RuntimeError("Windows runtime preparation requires native Windows x64 Python")
    identity = f"{sys.version_info.major}.{sys.version_info.minor}"
    if identity != LOCK["python"]:
        raise RuntimeError(f"Python {LOCK['python']} x64 required; got {identity}")
    java_home = Path(os.environ.get("MY_SCHOLAR_JAVA_HOME") or os.environ.get("JAVA_HOME") or "")
    for name in ("java.exe", "javac.exe", "jlink.exe"):
        require_x64_pe(java_home / "bin" / name)
    properties = run([java_home / "bin/java.exe", "-XshowSettings:properties", "-version"],
                     capture_output=True, text=True)
    settings = properties.stderr + properties.stdout
    if "java.specification.version = 21" not in settings or "os.arch = amd64" not in settings:
        raise RuntimeError("JDK 21 x64 is required (set JAVA_HOME or MY_SCHOLAR_JAVA_HOME)")
    if RUNTIME.exists():
        shutil.rmtree(RUNTIME)
    RUNTIME.mkdir(parents=True)
    prepare_toolchain()
    prepare_python()
    prepare_java(java_home)
    server = RUNTIME / "my-scholar-server/my-scholar-server.exe"
    java = RUNTIME / "java/bin/java.exe"
    pandoc = RUNTIME / "pandoc/pandoc.exe"
    for executable in (server, java, pandoc):
        require_x64_pe(executable)
    clean_environment = {key: value for key, value in os.environ.items()
                         if key.upper() not in {"PATH", "PYTHONHOME", "PYTHONPATH", "JAVA_HOME", "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS"}
                         and not key.upper().startswith("MY_SCHOLAR_")}
    clean_environment.update({"PATH": str(Path(os.environ["SystemRoot"]) / "System32"),
                              "SSL_CERT_FILE": str(RUNTIME / "my-scholar-server/ca-certificates.crt")})
    run([server, "--dependency-smoke"], env=clean_environment)
    run([java, "--list-modules"], env=clean_environment)
    version = run([pandoc, "--version"], env=clean_environment, capture_output=True, text=True).stdout
    if not version.startswith(f"pandoc {LOCK['pandoc']['version']}\n"):
        raise RuntimeError(f"Unexpected Pandoc version: {version}")
    print(f"Windows x64 runtime ready: {RUNTIME}")


if __name__ == "__main__":
    main()
