"""
4.1: bulk warning acknowledgment by stable finding identity.

The individual-ack path covers exactly two codes (unknown_section snippet
store, project_duplicate type store). "Acknowledge all of these warnings"
in the save gate needs ONE store that can express ANY warning: one line per
finding, identity = file|code|section|param|extra, where extra is a
code-specific discriminator (missing_include -> the include spec; empty for
all other codes today).

Suppression rules (plan 4.1):
  - warnings only: errors are NEVER acked (override is per-save), neither
    is info;
  - the store is machine-global like the other two (v1 scope decision);
  - surviving a param edit is deliberate (contrast: snippet store).
"""
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from fastapi.testclient import TestClient  # noqa: E402

from main import app  # noqa: E402
from parser.config_parser import parse_config  # noqa: E402
from parser.validator import validate_config, validate_project_configs  # noqa: E402


client = TestClient(app)


def _layout_dir():
    return tempfile.TemporaryDirectory()


def _unknown_param_project():
    text = (
        "[idle_timeout]\n"
        "timeout: 300\n"
        "gcode: G28\n"
        "not_a_real_param: 1\n"
    )
    return {
        "printer.cfg": parse_config(text, "printer.cfg"),
        "other.cfg": parse_config("[gcode_macro X]\ngcode: G28\n", "other.cfg"),
    }


def _unknown_param_findings(results) -> list:
    out = []
    for fr in results.values():
        for e in fr.errors:
            if e.code == "unknown_param":
                out.append(e)
    return out


# --- identity + store round-trip --------------------------------------------

def test_store_roundtrip(monkeypatch, tmp_path):
    monkeypatch.setenv("KWC_LAYOUT_DIR", str(tmp_path))
    from services.warning_acknowledgments import (
        acknowledge_warning_identities,
        load_acknowledged_warning_identities,
        warning_identity,
    )
    ident = warning_identity(
        "printer.cfg", "unknown_param", "idle_timeout", "not_a_real_param", "")
    assert ident == "printer.cfg|unknown_param|idle_timeout|not_a_real_param|"
    path = acknowledge_warning_identities([ident])
    assert Path(path).name == "acknowledged_warning_identities.txt"
    assert Path(path).exists()
    assert load_acknowledged_warning_identities() == {ident}


def test_store_idempotent_append(monkeypatch, tmp_path):
    monkeypatch.setenv("KWC_LAYOUT_DIR", str(tmp_path))
    from services.warning_acknowledgments import (
        acknowledge_warning_identities,
        load_acknowledged_warning_identities,
    )
    a = "printer.cfg|unknown_param|idle_timeout|p1|"
    b = "other.cfg|unknown_param|idle_timeout|p2|"
    acknowledge_warning_identities([a, b])
    acknowledge_warning_identities([a, b])  # re-ack: no duplicates
    lines = [
        line for line in
        (tmp_path / "acknowledged_warning_identities.txt").read_text(
            encoding="utf-8").splitlines() if line
    ]
    assert sorted(lines) == sorted([a, b]), f"duplicate lines: {lines}"
    assert load_acknowledged_warning_identities() == {a, b}


def test_extra_discriminator_is_part_of_identity():
    from services.warning_acknowledgments import warning_identity
    plain = warning_identity("f.cfg", "missing_include", "include a.cfg", "", "")
    extra = warning_identity("f.cfg", "missing_include", "include a.cfg", "", "a.cfg")
    assert plain != extra


# --- validator suppression ---------------------------------------------------

def test_validator_suppresses_acknowledged_warning(monkeypatch, tmp_path):
    monkeypatch.setenv("KWC_LAYOUT_DIR", str(tmp_path))
    from services.warning_acknowledgments import acknowledge_warning_identities
    configs = _unknown_param_project()
    results = validate_project_configs(configs)
    before = _unknown_param_findings(results)
    assert len(before) == 1, \
        f"expected one unknown_param, got: {[e.message for e in before]}"

    from services.warning_acknowledgments import finding_identity
    acknowledge_warning_identities([
        finding_identity("printer.cfg", "unknown_param", "idle_timeout",
                         "not_a_real_param"),
    ])
    after = _unknown_param_findings(validate_project_configs(configs))
    assert not after, "acknowledged warning must be suppressed"


def test_validator_keeps_warning_with_different_param(monkeypatch, tmp_path):
    monkeypatch.setenv("KWC_LAYOUT_DIR", str(tmp_path))
    from services.warning_acknowledgments import (
        acknowledge_warning_identities, finding_identity,
    )
    acknowledge_warning_identities([
        finding_identity("printer.cfg", "unknown_param", "idle_timeout",
                         "different_param"),
    ])
    results = validate_project_configs(_unknown_param_project())
    assert len(_unknown_param_findings(results)) == 1, \
        "a different param must not be suppressed"


def test_validator_never_suppresses_error(monkeypatch, tmp_path):
    monkeypatch.setenv("KWC_LAYOUT_DIR", str(tmp_path))
    from services.warning_acknowledgments import acknowledge_warning_identities
    # unclosed_section_header is an error — acking its identity must not
    # hide it (errors are never acknowledged).
    acknowledge_warning_identities([
        "printer.cfg|unclosed_section_header|mcu||",
    ])
    result = validate_config(parse_config("[mcu\nserial: x\n", "printer.cfg"))
    errors = [e for e in result.errors if e.code == "unclosed_section_header"]
    assert len(errors) == 1, "error must survive an ack of the same identity"


def test_validator_never_suppresses_info(monkeypatch, tmp_path):
    monkeypatch.setenv("KWC_LAYOUT_DIR", str(tmp_path))
    from services.warning_acknowledgments import acknowledge_warning_identities
    acknowledge_warning_identities([
        "printer.cfg|project_duplicate|stepper_z||",
    ])
    text = (
        "[stepper_z]\n"
        "step_pin: gpio11\n"
        "dir_pin: gpio10\n"
        "enable_pin: !gpio9\n"
        "microsteps: 16\n"
        "rotation_distance: 40\n"
        "\n"
        "[stepper_z]\n"
        "step_pin: gpio21\n"
        "dir_pin: gpio20\n"
        "enable_pin: !gpio19\n"
        "microsteps: 16\n"
        "rotation_distance: 40\n"
    )
    result = validate_config(parse_config(text, "printer.cfg"))
    infos = [e for e in result.errors if e.severity == "info"]
    assert infos, "info findings must survive an ack of the same identity"


def test_single_file_mode_suppression(monkeypatch, tmp_path):
    monkeypatch.setenv("KWC_LAYOUT_DIR", str(tmp_path))
    from services.warning_acknowledgments import acknowledge_warning_identities
    config = parse_config(
        "[idle_timeout]\n"
        "timeout: 300\n"
        "not_a_real_param: 1\n",
        "printer.cfg")
    assert any(e.code == "unknown_param" for e in validate_config(config).errors)
    from services.warning_acknowledgments import finding_identity
    acknowledge_warning_identities([
        finding_identity("printer.cfg", "unknown_param", "idle_timeout",
                         "not_a_real_param"),
    ])
    result = validate_config(config)
    assert not [e for e in result.errors if e.code == "unknown_param"]


# --- bulk endpoint -----------------------------------------------------------

def _bulk_payload() -> list[dict]:
    return [
        {
            "file": "printer.cfg",
            "code": "unknown_param",
            "section": "idle_timeout",
            "param": "not_a_real_param",
            "extra": "",
        },
    ]


def test_bulk_endpoint_acknowledges_and_writes_file(monkeypatch, tmp_path):
    monkeypatch.setenv("KWC_LAYOUT_DIR", str(tmp_path))
    response = client.post(
        "/api/warning-acknowledgements/bulk", json={"identities": _bulk_payload()})
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "acknowledged"
    assert body["count"] == 1
    assert Path(body["file"]).name == "acknowledged_warning_identities.txt"
    content = (tmp_path / "acknowledged_warning_identities.txt").read_text(
        encoding="utf-8")
    assert "printer.cfg|unknown_param|idle_timeout|not_a_real_param|" in content


def test_bulk_endpoint_idempotent(monkeypatch, tmp_path):
    monkeypatch.setenv("KWC_LAYOUT_DIR", str(tmp_path))
    for _ in range(2):
        response = client.post(
            "/api/warning-acknowledgements/bulk", json={"identities": _bulk_payload()})
        assert response.status_code == 200
    lines = [
        line for line in
        (tmp_path / "acknowledged_warning_identities.txt").read_text(
            encoding="utf-8").splitlines() if line
    ]
    assert len(lines) == 1, f"expected exactly one line, got: {lines}"


def test_bulk_endpoint_end_to_end_clears_warning(monkeypatch, tmp_path):
    monkeypatch.setenv("KWC_LAYOUT_DIR", str(tmp_path))
    configs = _unknown_param_project()
    results = validate_project_configs(configs)
    assert any(fr.has_warnings for fr in results.values()), \
        "setup: project must have a warning before the ack"

    response = client.post(
        "/api/warning-acknowledgements/bulk", json={"identities": _bulk_payload()})
    assert response.status_code == 200

    revalidated = validate_project_configs(_unknown_param_project())
    assert not any(fr.has_warnings for fr in revalidated.values()), \
        "after bulk-ack, the project must have no warnings"


def test_bulk_endpoint_rejects_empty_list(monkeypatch, tmp_path):
    monkeypatch.setenv("KWC_LAYOUT_DIR", str(tmp_path))
    response = client.post(
        "/api/warning-acknowledgements/bulk", json={"identities": []})
    assert response.status_code == 422


def test_finding_identity_missing_include_carries_spec():
    """missing_include identities carry the include spec as ``extra`` so two
    different missing includes in one file don't collide. (missing_include is
    an ERROR post-4.0 and never bulk-acked — the save gate's error path has
    no acknowledge button — but the derivation must stay correct: the id is
    part of the store format and the discriminator is forward-looking for
    warning codes that need it.)"""
    from services.warning_acknowledgments import finding_identity
    a = finding_identity(
        "printer.cfg", "missing_include", "include missing_a.cfg", "")
    b = finding_identity(
        "printer.cfg", "missing_include", "include missing_b.cfg", "")
    assert a == "printer.cfg|missing_include|include missing_a.cfg||missing_a.cfg"
    assert a != b, "different includes in one file must not collide"
    # Non-discriminator codes keep an empty extra (stable across edits).
    plain = finding_identity("printer.cfg", "unknown_param", "idle_timeout", "p")
    assert plain == "printer.cfg|unknown_param|idle_timeout|p|"


def test_endpoint_and_suppression_agree_on_warning_identity(monkeypatch, tmp_path):
    """Whatever the endpoint writes, the validator must recognize — the two
    halves share finding_identity() by construction."""
    monkeypatch.setenv("KWC_LAYOUT_DIR", str(tmp_path))
    from services.warning_acknowledgments import finding_identity
    config = parse_config(
        "[idle_timeout]\n"
        "timeout: 300\n"
        "not_a_real_param: 1\n",
        "printer.cfg")
    findings = [e for e in validate_config(config).errors if e.code == "unknown_param"]
    assert len(findings) == 1
    response = client.post("/api/warning-acknowledgements/bulk", json={
        "identities": [{
            "file": "printer.cfg",
            "code": "unknown_param",
            "section": "idle_timeout",
            "param": "not_a_real_param",
            "extra": "",
        }],
    })
    assert response.status_code == 200
    # The id written by the endpoint equals the validator's own identity:
    content = (tmp_path / "acknowledged_warning_identities.txt").read_text(
        encoding="utf-8")
    assert finding_identity(
        "printer.cfg", "unknown_param", "idle_timeout", "not_a_real_param"
    ) in content
    assert not [e for e in validate_config(config).errors if e.code == "unknown_param"]
