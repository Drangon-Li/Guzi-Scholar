import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import urllib.request

p=argparse.ArgumentParser()
p.add_argument('pdf')
p.add_argument('output')
p.add_argument('--base',required=True)
a=p.parse_args()
base=Path(a.base)
out=Path(a.output)
out.mkdir(parents=True,exist_ok=True)
env=os.environ.copy()
env.update({'BASE':str(base),'GLM_VENV':env.get('GLM_VENV',str(base/'conda/envs/guzi-scholar')),'GLM_PORT':'18080','GLM_GPU_MEMORY_UTILIZATION':'0.15','PYTHONUNBUFFERED':'1'})
server=None
client=None

def stop_group(process):
    if process is None:
        return
    try:
        os.killpg(process.pid,signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=20)
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(process.pid,signal.SIGKILL)
    except ProcessLookupError:
        pass
    process.wait()

def interrupted(signum,frame):
    stop_group(client)
    stop_group(server)
    raise SystemExit(128+signum)

signal.signal(signal.SIGTERM,interrupted)
signal.signal(signal.SIGINT,interrupted)
started=time.monotonic()
status={'server_host':'127.0.0.1','port':18080,'gpu_memory_utilization':0.15,'started':time.time()}
try:
    with (out/'service.log').open('w') as log:
        server=subprocess.Popen(['bash',str(base/'scripts/glm/serve_glm.sh')],stdout=log,stderr=subprocess.STDOUT,env=env,start_new_session=True)
        status['server_pid']=server.pid
        (out/'service-status.json').write_text(json.dumps(status,indent=2))
        ready=False
        while time.monotonic()-started<600:
            if server.poll() is not None: raise RuntimeError(f'vLLM exited with {server.returncode}; see service.log')
            try:
                with urllib.request.urlopen('http://127.0.0.1:18080/health',timeout=3) as r:
                    if r.status==200: ready=True; break
            except Exception: pass
            time.sleep(2)
        if not ready: raise TimeoutError('vLLM startup exceeded 600 seconds')
        status['service_startup_seconds']=time.monotonic()-started
        status['status']='warming'
        (out/'service-status.json').write_text(json.dumps(status,indent=2))
        warm_started=time.monotonic()
        warm_payload={'model':'glm-ocr','messages':[{'role':'user','content':'hello'}],'max_tokens':10,'temperature':0.1}
        warm_request=urllib.request.Request('http://127.0.0.1:18080/v1/chat/completions',data=json.dumps(warm_payload).encode(),headers={'Content-Type':'application/json'})
        with urllib.request.urlopen(warm_request,timeout=180) as response:
            warm_result=json.load(response)
        if not warm_result.get('choices'):
            raise RuntimeError('Generation warmup returned no choices')
        (out/'warmup-response.json').write_text(json.dumps(warm_result,ensure_ascii=False,indent=2))
        status['generation_warmup_seconds']=time.monotonic()-warm_started
        status['status']='recognizing'
        (out/'service-status.json').write_text(json.dumps(status,indent=2))
        client=subprocess.Popen([str(Path(env['GLM_VENV'])/'bin/python'),str(base/'scripts/glm/run_glm.py'),a.pdf,str(out/'output'),'--base',str(base),'--port','18080'],env=env,start_new_session=True)
        rc=client.wait()
        if rc: raise RuntimeError(f'GLM SDK exited with {rc}')
        status['status']='success'
finally:
    stop_group(client)
    stop_group(server)
    status['total_seconds_including_service_startup']=time.monotonic()-started
    status['server_exit_code']=None if server is None else server.poll()
    (out/'service-status.json').write_text(json.dumps(status,indent=2))
