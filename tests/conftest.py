"""Suite-wide guard: the native-tools delta probe must never fire in tests.

The probe is a REAL fire-and-forget HTTP pair against the request's
endpoint; inside the suite that endpoint is a scripted fake, so a probe
would (a) consume scripted replies and (b) race the TestClient loop
shutdown. Tests of the probe/spawn machinery itself patch the spawn (or
the probe) explicitly — every other test gets the no-op here. Same
discipline as never letting platform checks into the request path.
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

import api.ai_routes as ai_routes  # noqa: E402


@pytest.fixture(autouse=True)
def _no_native_tools_probes(monkeypatch):
    monkeypatch.setattr(ai_routes, '_spawn_native_tools_probe',
                        lambda *a, **k: None)
