"""Tests for the `staged_renders_clean` accuracy criterion kind (W2).

Grades the RUNTIME class the compiler cannot see: a staged macro that
compiles but renders a broken command at default invocation (e.g.
``SET_LED ... RED=`` from an empty ``params_`` default). The criterion
runs the shared render simulator over the staged artifact — the same
engine as the save gate and the validate_macro tool.

Harness loading mirrors scripts/validate_criteria_offline.py (the module
needs its sys.modules identity for dataclasses).
"""
import importlib.util
import pathlib
import sys

_ROOT = pathlib.Path(__file__).resolve().parents[1]

_spec = importlib.util.spec_from_file_location(
    "kwc_accuracy_harness_rc",
    _ROOT / "scripts" / "ai_chat_accuracy_test.py",
)
assert _spec is not None and _spec.loader is not None
_mod = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = _mod
_spec.loader.exec_module(_mod)

criterion_ok = _mod.criterion_ok

_TARGET = r"printer\.cfg"

# The repro shape: compiles clean, renders `SET_LED ... RED=` (empty value)
# at default invocation — unparsable by Klipper.
BROKEN = """[printer]
max_velocity: 200

[gcode_macro TOGGLE_LEDS]
params_RED:
params_GREEN:
params_BLUE:
gcode:
    SET_LED LED=Chamber_LEDs RED={params.RED} GREEN={params.GREEN} BLUE={params.BLUE}
"""

# The corrected shape: real defaults -> renders parseable values.
FIXED = """[printer]
max_velocity: 200

[gcode_macro TOGGLE_LEDS]
params_RED: 0.35
params_GREEN: 0.35
params_BLUE: 0.35
gcode:
    SET_LED LED=Chamber_LEDs RED={params.RED} GREEN={params.GREEN} BLUE={params.BLUE}
"""

# Legitimate live-state read: unknown at author time is INFO, never an
# error — a macro that renders fine must pass even though the simulator
# cannot resolve printer state.
VALID_STATE = """[printer]
max_velocity: 200

[gcode_macro WHERE_ARE_WE]
gcode:
    {% set pos = printer.toolhead.position %}
    RESPOND TYPE=echo MSG="X is {pos.x}"
"""

# Negative control: syntactically fine text staged to a non-target file.
OTHER_FILE = "[gcode_macro ANY]\ngcode:\n    G28\n"


def _edit(file: str, text: str, op: str = "modify") -> list:
    return [{"file": file, "newText": text, "op": op}]


def test_fails_on_runtime_empty_value() -> None:
    assert criterion_ok("staged_renders_clean", _TARGET, "irrelevant", pending_edits=_edit("printer.cfg", BROKEN)) is False


def test_passes_on_fixed_shape() -> None:
    assert criterion_ok("staged_renders_clean", _TARGET, "irrelevant", pending_edits=_edit("printer.cfg", FIXED)) is True


def test_info_findings_do_not_fail() -> None:
    assert criterion_ok("staged_renders_clean", _TARGET, "irrelevant", pending_edits=_edit("printer.cfg", VALID_STATE)) is True


def test_requires_artifact() -> None:
    assert criterion_ok("staged_renders_clean", _TARGET, "irrelevant", pending_edits=[]) is False


def test_negative_control_wrong_file_fails() -> None:
    # A clean macro staged to a file the criterion does not target is
    # still a missing artifact — word-presence must not carry it.
    assert criterion_ok("staged_renders_clean", _TARGET, "irrelevant", pending_edits=_edit("mainsail.cfg", OTHER_FILE)) is False


def test_create_op_treated_same_as_modify() -> None:
    assert criterion_ok(
        "staged_renders_clean", _TARGET, "irrelevant",
        _edit("printer.cfg", BROKEN, op="create"),
    ) is False


def test_unparseable_staged_text_fails() -> None:
    # Staged text that isn't even a parseable cfg cannot be certified clean.
    assert criterion_ok(
        "staged_renders_clean", _TARGET, "irrelevant",
        _edit("printer.cfg", "{{ this is not a config"),
    ) is False
