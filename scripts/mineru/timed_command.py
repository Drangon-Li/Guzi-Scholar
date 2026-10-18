import json
import resource
import subprocess
import sys
import time
from pathlib import Path

output = Path(sys.argv[1])
started = time.monotonic()
completed = subprocess.run(sys.argv[2:])
usage = resource.getrusage(resource.RUSAGE_CHILDREN)
output.write_text(json.dumps({
    'elapsed_seconds': time.monotonic() - started,
    'returncode': completed.returncode,
    'children_user_seconds': usage.ru_utime,
    'children_system_seconds': usage.ru_stime,
    'children_max_rss_kib': usage.ru_maxrss,
}, indent=2), encoding='utf-8')
raise SystemExit(completed.returncode)
