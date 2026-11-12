"""Make the suite collectable off the printer host.

backend/main.py refuses to import off Linux — that is the shipped startup
contract, and the start-dev scripts export KWC_FAKE_NATIVE for the app's own
process. But eighteen test modules do `from main import app` at module level,
so on the documented Windows/macOS dev machines collection would abort with
"KWC requires Linux" before a single test runs. The override here is scoped to
the pytest process only.

tests/test_native_startup.py strips KWC_FAKE_NATIVE from its subprocess
environment before asserting the refusal, so this cannot water down the
startup-contract tests. On Linux (CI, the printer host) is_native_platform()
is already true and the setdefault is a no-op.
"""
import os

os.environ.setdefault("KWC_FAKE_NATIVE", "1")
