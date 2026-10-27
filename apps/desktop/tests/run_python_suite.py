import argparse
from pathlib import Path
import unittest

parser = argparse.ArgumentParser()
mode = parser.add_mutually_exclusive_group()
mode.add_argument("--windows", action="store_true")
mode.add_argument("--all", action="store_true")
args = parser.parse_args()

suite = unittest.TestSuite()
for file in sorted(Path("tests").glob("test*.py")):
    windows = file.name.startswith("test_windows_")
    if args.all or windows == args.windows:
        suite.addTests(unittest.defaultTestLoader.discover("tests", pattern=file.name))

result = unittest.TextTestRunner(verbosity=2).run(suite)
raise SystemExit(not result.wasSuccessful())
