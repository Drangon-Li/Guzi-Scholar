import json
import os
from pathlib import Path
import tempfile
import sys
import threading
import time
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from unittest.mock import patch

from services.parser_service.app import make_server
from services.parser_service.runtime import Runtime, atomic_json, check_resources


class ServiceTests(unittest.TestCase):
    def test_missing_deployment_is_not_ready_and_reports_only_relative_names(self):
        with tempfile.TemporaryDirectory() as tmp:
            runtime = Runtime({'base': tmp})
            try:
                health = runtime.health()
                self.assertFalse(health['ready'])
                self.assertIn('scripts/run_glm_job.py', health['missing_dependencies'])
                self.assertIn('scripts/mineru/run_mineru.sh', health['missing_dependencies'])
                self.assertIn('models/glm-models.json', health['missing_dependencies'])
                self.assertIn('mineru4/config.yaml', health['missing_dependencies'])
                self.assertIn('python', health['missing_dependencies'])
                self.assertNotIn(tmp, json.dumps(health))
            finally:
                runtime.close()

    def test_injected_processor_is_ready_without_gpu_deployment(self):
        with tempfile.TemporaryDirectory() as tmp:
            runtime = Runtime({'base': tmp}, processor=lambda _job_id: None)
            try:
                self.assertTrue(runtime.health()['ready'])
                self.assertEqual(runtime.health()['missing_dependencies'], [])
            finally:
                runtime.close()

    def test_complete_deployment_is_ready_and_child_environment_uses_its_base(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            files = ['scripts/run_glm_job.py', 'scripts/glm/serve_glm.sh', 'scripts/glm/run_glm.py',
                     'scripts/mineru/env.sh', 'scripts/mineru/run_mineru.sh', 'scripts/mineru/record_run.py',
                     'scripts/mineru/timed_command.py', 'scripts/mineru/export_and_check.py',
                     'models/glm-models.json', 'mineru4/config.yaml']
            for name in files:
                path = base / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('{}' if path.suffix == '.json' else '')
            runtime = Runtime({'base': tmp, 'python': sys.executable})
            try:
                self.assertTrue(runtime.health()['ready'])
                self.assertEqual(runtime.health()['missing_dependencies'], [])
                with patch.dict(os.environ, {'BASE': '/unrelated/deployment'}):
                    self.assertEqual(runtime.environment()['BASE'], str(base.resolve()))
                (base / 'scripts/mineru/export_and_check.py').unlink()
                self.assertFalse(runtime.health()['ready'])
                self.assertEqual(runtime.health()['missing_dependencies'], ['scripts/mineru/export_and_check.py'])
                runtime.python = str(base / 'missing-python')
                self.assertIn('python', runtime.health()['missing_dependencies'])
            finally:
                runtime.close()

    def test_auth_queue_cancel_restart(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            gate = threading.Event()
            def process(job_id):
                gate.wait(2)
            with patch('services.parser_service.runtime.pdf_page_count', return_value=1):
                runtime = Runtime({'base':str(base)}, processor=process)
                server = make_server(runtime, 'a'*40, 0)
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                url = f'http://127.0.0.1:{server.server_port}'
                def request(path, data=None, token='a'*40, headers=None):
                    hdr = {'Authorization':'Bearer '+token, **(headers or {})}
                    with urlopen(Request(url+path, data=data, headers=hdr), timeout=5) as response:
                        return response.status, json.load(response)
                self.assertTrue(request('/health')[1]['ready'])
                with self.assertRaises(HTTPError) as error:
                    request('/v1/health', token='bad')
                self.assertEqual(error.exception.code, 401)
                status, first = request('/v1/jobs', b'%PDF-test', headers={'Content-Type':'application/pdf','X-Filename':'paper%20one.pdf'})
                self.assertEqual(status, 202)
                status, second = request('/v1/jobs', b'%PDF-test', headers={'Content-Type':'application/pdf'})
                self.assertEqual(request('/v1/jobs/'+second['id']+'/cancel', b'')[1]['status'],'cancelled')
                gate.set()
                for _ in range(100):
                    state = request('/v1/jobs/'+first['id'])[1]
                    if state['status'] == 'completed':
                        break
                    time.sleep(.01)
                self.assertEqual(state['status'], 'completed')
                self.assertEqual(state['source_filename'], 'paper one.pdf')
                with self.assertRaises(HTTPError):
                    request('/v1/jobs/../../outside')
                server.shutdown()
                server.server_close()
                runtime.close()
                runtime.jobs[first['id']]['status'] = 'running'
                atomic_json(runtime.path(first['id'])/'state.json', runtime.jobs[first['id']])
                recovered = Runtime({'base':str(base)}, processor=process)
                self.assertEqual(recovered.get(first['id'])['status'], 'failed')
                self.assertEqual(recovered.get(first['id'])['stage'], 'interrupted')
                recovered.close()

    def test_preflight_errors(self):
        base = {'gpu_index':0, 'gpu':[], 'compute_processes':[], 'memory_available_bytes':64*1024**3,'disk_free_bytes':20*1024**3}
        with self.assertRaisesRegex(RuntimeError,'GPU unavailable'):
            check_resources(base)
        base['gpu'] = [{'index':0,'free_mib':32768}]
        base['compute_processes'] = ['123, external']
        with self.assertRaisesRegex(RuntimeError,'GPU busy'):
            check_resources(base)
        base['compute_processes'] = []
        check_resources(base)


class CacheTests(unittest.TestCase):
    def test_seed_identity_and_asset_tamper(self):
        import hashlib
        from services.parser_service.runtime import seed_raw_cache
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            config = {'base':str(base)}
            pdf = base/'demo.pdf'
            pdf.write_bytes(b'%PDF-test')
            run = base/'runs/baseline'
            glm = run/'glm/output/demo/demo.json'
            mineru = run/'mineru/extracted/structured_content.json'
            glm.parent.mkdir(parents=True)
            mineru.parent.mkdir(parents=True)
            glm.write_text(json.dumps([[{'label':'text','content':'x'}]]))
            mineru.write_text(json.dumps({'is_full_document':True,'pages':[{'page_idx':0,'blocks':[]}]}))
            asset = glm.parent/'figure.png'
            asset.write_bytes(b'original image')
            sha = hashlib.sha256(pdf.read_bytes()).hexdigest()
            (run/'pipeline.json').write_text(json.dumps({'pdf_sha256':sha,'status':'success','stages':[{'id':'glm','status':'success','seconds':12},{'id':'mineru','status':'success','seconds':15}]}))
            runtime = Runtime(config, start_worker=False)
            protocol = base/'protocol.json'
            protocol.write_text(json.dumps(runtime.protocol))
            runtime.close()
            with patch('services.parser_service.runtime.pdf_page_count', return_value=1):
                imported = seed_raw_cache(config, pdf, run, protocol)
                self.assertEqual(len(imported), 2)
                runtime = Runtime(config, start_worker=False)
                state = runtime.submit(pdf.read_bytes(), 'demo.pdf')
                self.assertEqual(runtime.raw(state['id'], 'glm'), glm.resolve())
                self.assertTrue(runtime.get(state['id'])['stages'][0]['cache_hit'])
                asset.write_bytes(b'modified image')
                with self.assertRaisesRegex(ValueError, 'image assets changed'):
                    runtime.raw(state['id'], 'glm')
                runtime.close()
                bad = json.loads(protocol.read_text())
                bad['revision'] = 'incompatible'
                protocol.write_text(json.dumps(bad))
                with self.assertRaisesRegex(ValueError, 'protocol does not exactly match'):
                    seed_raw_cache(config, pdf, run, protocol)


class LifecycleTests(unittest.TestCase):
    def test_shared_gpu_lock_prevents_launch(self):
        import fcntl
        with tempfile.TemporaryDirectory() as tmp:
            runtime = Runtime({'base':tmp}, start_worker=False)
            try:
                with patch('services.parser_service.runtime.pdf_page_count', return_value=1):
                    state = runtime.submit(b'%PDF-test', 'test.pdf')
                with (Path(tmp)/'runs/gpu.lock').open('a+') as lock:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    with patch.object(runtime, '_run_stage') as launch:
                        with self.assertRaisesRegex(RuntimeError, 'GPU busy'):
                            runtime.run_stage(state['id'], 'glm', ['should-not-launch'], gpu=True)
                        launch.assert_not_called()
            finally:
                runtime.close()

    def test_cancel_stops_owned_process(self):
        import sys
        import os
        with tempfile.TemporaryDirectory() as tmp:
            def process(job_id):
                runtime.run_stage(job_id, 'fusion', [sys.executable, '-c', 'import time; time.sleep(30)'])
            runtime = Runtime({'base':tmp}, processor=process)
            try:
                with patch('services.parser_service.runtime.pdf_page_count', return_value=1):
                    state = runtime.submit(b'%PDF-test', 'test.pdf')
                pid_file = runtime.path(state['id'])/'fusion-process.json'
                for _ in range(200):
                    if pid_file.exists():
                        break
                    time.sleep(.01)
                self.assertTrue(pid_file.exists())
                pid = json.loads(pid_file.read_text())['pid']
                runtime.cancel(state['id'])
                for _ in range(500):
                    if runtime.get(state['id'])['status'] == 'cancelled':
                        break
                    time.sleep(.01)
                self.assertEqual(runtime.get(state['id'])['status'], 'cancelled')
                with self.assertRaises(ProcessLookupError):
                    os.kill(pid, 0)
            finally:
                runtime.close()


class ModelProtocolTests(unittest.TestCase):
    def test_external_model_changes_invalidate_cached_protocol(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / 'code'
            model = Path(tmp) / 'models'
            model.mkdir()
            weight = model / 'model.safetensors'
            weight.write_bytes(b'weight-v1')
            config = {'base': str(base), 'model_directories': [str(model)]}
            runtime = Runtime(config, start_worker=False)
            try:
                before = runtime.protocol
                self.assertEqual(before['model_files'][0][0], str(weight.resolve()))
                weight.write_bytes(b'changed-weight-v2')
                self.assertNotEqual(before['sha256'], runtime.model_protocol()['sha256'])
                runtime.config['model_directories'] = ['../models']
                with self.assertRaisesRegex(ValueError, 'explicit absolute path'):
                    runtime.model_protocol()
            finally:
                runtime.close()

    def test_running_locks_do_not_invalidate_real_models(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            model = base/'models/relevant'
            model.mkdir(parents=True)
            weight = model/'model.safetensors'
            weight.write_bytes(b'weight-v1')
            config_path = model/'config.json'
            config_path.write_text('{"model":"v1"}')
            def protocol():
                runtime = Runtime({'base':tmp,'model_directories':['models/relevant']}, start_worker=False)
                try:
                    return runtime.protocol
                finally:
                    runtime.close()
            before = protocol()
            for part, filename in [('.locks','model.lock'),('.cache','runtime.json'),('__pycache__','runtime.pyc'),('logs','parse.log')]:
                folder = model/part
                folder.mkdir()
                (folder/filename).write_text('transient')
            (model/'runtime.lock').write_text('owned')
            self.assertEqual(before, protocol())
            (model/'.locks/model.lock').write_text('different lock timestamp and content')
            self.assertEqual(before, protocol())
            weight.write_bytes(b'changed-weight-v2')
            after_weight = protocol()
            self.assertNotEqual(before['sha256'], after_weight['sha256'])
            config_path.write_text('{"model":"new-config-v3"}')
            self.assertNotEqual(after_weight['sha256'], protocol()['sha256'])


if __name__ == '__main__':
    unittest.main()
