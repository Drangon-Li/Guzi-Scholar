"""Serve exclusively the synthetic reader UI fixture with a mock translator."""
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import server

data = Path(os.environ["MY_SCHOLAR_DATA_DIR"]).resolve()
descriptor = json.loads((data.parent / "fixture.json").read_text())
if descriptor.get("fixture_source") != "synthetic-reader-ui-v1" or Path(descriptor["data"]).resolve() != data:
    raise RuntimeError("Reader UI mock requires its isolated synthetic fixture")
server.translation_profile_id = lambda: "synthetic-mock"
server.translate_text = lambda text, **_kwargs: {"text": "Mock: " + text, "model": "synthetic-mock"}
if __name__ == "__main__":
    server.main()
