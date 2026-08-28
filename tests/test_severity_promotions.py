"""
4.0: three mis-leveled warnings are Klipper config-LOAD failures and belong
at severity "error" (plan decision 2026-08-28, ground-truthed in source the
same day).

Yardstick (plan audit): error = Klipper throws during config load;
warning = loads but fails later / we can't be sure.

Ground truth:
  1. kinematics_stepper_missing — klippy/kinematics/corexy.py:12
     (and cartesian.py, delta.py, rotary_delta.py, deltesian.py, polar.py,
     winch.py): config.getsection('stepper_' + n) for the base rail; a
     missing section raises config_error at load.
  2. z_virtual_endstop without a probe — the 'probe:' pin chip is registered
     ONLY when a probe section loads (klippy/extras/probe.py:215). Without
     one, pins.py:81 raises "Unknown pin chip name 'probe'" during config
     load. Deterministic load failure.
  2b. probe:manually_set_z_virtual_endstop — value does not exist in current
     Klipper (repo-wide search: 0 hits). With a probe section present,
     HomingViaProbeHelper.setup_pin (probe.py:238-240) raises
     pins.error("Probe virtual endstop only useful as endstop pin") for any
     pin value other than exactly 'z_virtual_endstop' — also at load.
  3. missing include — klippy/configfile.py:187-189:
     raise error("Include file '%s' does not exist") at load; globs are
     exempt (glob.has_magic) — matches KWC's existing glob skip.

Explicitly NOT promoted (regression guards in the same file):
  unknown_param, pin format/prefix, requires-missing (bed_mesh -> probe),
  sensorless-homing conflict all stay WARNING.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from parser.config_parser import parse_config  # noqa: E402
from parser.validator import validate_config, validate_project_configs  # noqa: E402


def _project(files: dict[str, str]) -> dict:
    """Build a project: the main file gets [include] lines for the rest."""
    main = "printer.cfg" if "printer.cfg" in files else next(iter(files))
    includes = [f"[include {n}]" for n in files if n != main]
    configs = {n: parse_config(t, n) for n, t in files.items()}
    if includes:
        configs[main] = parse_config("\n".join(includes) + "\n" + files[main], main)
    return validate_project_configs(configs)


def _findings(results: dict, **match) -> list:
    out = []
    for fr in results.values():
        for e in fr.errors:
            if all(getattr(e, k) == v for k, v in match.items()):
                out.append(e)
    return out


# --- 1. kinematics stepper missing -> error ---------------------------------

def test_kinematics_stepper_missing_is_error():
    results = _project({
        "printer.cfg": (
            "[printer]\n"
            "kinematics: cartesian\n"
            "\n"
            "[stepper_x]\n"
            "step_pin: PB0\n"
            "dir_pin: PB1\n"
            "enable_pin: !PB2\n"
            "microsteps: 16\n"
            "rotation_distance: 40\n"
            "position_endstop: ^PA0\n"
            "position_max: 250\n"
            "position_min: 0\n"
            "homing_speed: 50\n"
            "\n"
            "[stepper_y]\n"
            "step_pin: PB3\n"
            "dir_pin: PB4\n"
            "enable_pin: !PB5\n"
            "microsteps: 16\n"
            "rotation_distance: 40\n"
            "position_endstop: ^PA1\n"
            "position_max: 250\n"
            "position_min: 0\n"
            "homing_speed: 50\n"
        ),
        "extras.cfg": "[gcode_macro X]\ngcode: G28\n",
    })
    findings = _findings(results, code="kinematics_stepper_missing")
    assert len(findings) == 1, f"expected one finding, got: {[e.message for e in findings]}"
    assert "stepper_z" in findings[0].message
    # Klipper raises config_error on this at load (corexy.py:12 getsection).
    assert findings[0].severity == "error"


# --- 2. z_virtual_endstop without probe -> error ----------------------------

_Z_SECTION = (
    "[stepper_z]\n"
    "step_pin: gpio11\n"
    "dir_pin: gpio10\n"
    "enable_pin: !gpio9\n"
    "microsteps: 16\n"
    "rotation_distance: 40\n"
)


def _z_project(extra_section: str) -> dict:
    return _project({
        "printer.cfg": (
            "[include z.cfg]\n"
            "[include extra.cfg]\n"
            "[printer]\n"
            "kinematics: cartesian\n"
            "\n"
            "[stepper_x]\n"
            "step_pin: PB0\n"
            "dir_pin: PB1\n"
            "enable_pin: !PB2\n"
            "microsteps: 16\n"
            "rotation_distance: 40\n"
            "position_endstop: ^PA0\n"
            "position_max: 250\n"
            "position_min: 0\n"
            "homing_speed: 50\n"
            "\n"
            "[stepper_y]\n"
            "step_pin: PB3\n"
            "dir_pin: PB4\n"
            "enable_pin: !PB5\n"
            "microsteps: 16\n"
            "rotation_distance: 40\n"
            "position_endstop: ^PA1\n"
            "position_max: 250\n"
            "position_min: 0\n"
            "homing_speed: 50\n"
        ),
        "z.cfg": _Z_SECTION + "endstop_pin: probe: z_virtual_endstop\n",
        "extra.cfg": extra_section,
    })


def test_z_virtual_endstop_without_probe_is_error():
    # No probe section anywhere: the 'probe:' pin chip never registers,
    # pins.py:81 raises at load.
    results = _z_project("[gcode_macro X]\ngcode: G28\n")
    findings = _findings(results, code="z_virtual_endstop_without_probe")
    assert len(findings) == 1, f"expected one finding, got: {[e.message for e in findings]}"
    assert findings[0].severity == "error"


def test_z_virtual_endstop_with_probe_not_flagged():
    # Regression guard: with a real probe section the pin chip registers and
    # the endstop is legal — no finding at all.
    results = _z_project(
        "[bltouch]\n"
        "pin: gpio12\n"
    )
    assert not _findings(results, code="z_virtual_endstop_without_probe"), \
        "probe present: z_virtual_endstop must not be flagged"


def test_manually_set_z_virtual_endstop_without_probe_is_error():
    results = _project({
        "printer.cfg": (
            "[include z.cfg]\n"
            "[printer]\n"
            "kinematics: cartesian\n"
            "\n"
            "[stepper_x]\n"
            "step_pin: PB0\n"
            "dir_pin: PB1\n"
            "enable_pin: !PB2\n"
            "microsteps: 16\n"
            "rotation_distance: 40\n"
            "position_endstop: ^PA0\n"
            "position_max: 250\n"
            "position_min: 0\n"
            "homing_speed: 50\n"
            "\n"
            "[stepper_y]\n"
            "step_pin: PB3\n"
            "dir_pin: PB4\n"
            "enable_pin: !PB5\n"
            "microsteps: 16\n"
            "rotation_distance: 40\n"
            "position_endstop: ^PA1\n"
            "position_max: 250\n"
            "position_min: 0\n"
            "homing_speed: 50\n"
        ),
        "z.cfg": _Z_SECTION + "endstop_pin: probe: manually_set_z_virtual_endstop\n",
    })
    findings = _findings(results, code="z_virtual_endstop_without_probe")
    assert len(findings) == 1, f"expected one finding, got: {[e.message for e in findings]}"
    assert findings[0].severity == "error"
    # Distinct message: the value itself is invalid, not just the missing probe.
    assert "only 'z_virtual_endstop' is accepted" in findings[0].message


def test_manually_set_z_virtual_endstop_with_probe_is_error():
    # The killer case: value is not in Klipper, so probe.py:238-240 raises
    # pins.error at load EVEN THOUGH a probe section exists.
    results = _project({
        "printer.cfg": (
            "[include z.cfg]\n"
            "[include probe.cfg]\n"
            "[printer]\n"
            "kinematics: cartesian\n"
            "\n"
            "[stepper_x]\n"
            "step_pin: PB0\n"
            "dir_pin: PB1\n"
            "enable_pin: !PB2\n"
            "microsteps: 16\n"
            "rotation_distance: 40\n"
            "position_endstop: ^PA0\n"
            "position_max: 250\n"
            "position_min: 0\n"
            "homing_speed: 50\n"
            "\n"
            "[stepper_y]\n"
            "step_pin: PB3\n"
            "dir_pin: PB4\n"
            "enable_pin: !PB5\n"
            "microsteps: 16\n"
            "rotation_distance: 40\n"
            "position_endstop: ^PA1\n"
            "position_max: 250\n"
            "position_min: 0\n"
            "homing_speed: 50\n"
        ),
        "z.cfg": _Z_SECTION + "endstop_pin: probe: manually_set_z_virtual_endstop\n",
        "probe.cfg": "[bltouch]\npin: gpio12\n",
    })
    findings = _findings(results, code="z_virtual_endstop_without_probe")
    assert len(findings) == 1, f"expected one finding, got: {[e.message for e in findings]}"
    assert findings[0].severity == "error"
    assert "only 'z_virtual_endstop' is accepted" in findings[0].message


# --- 3. missing include -> error + resolved path in message -----------------

def test_missing_plain_include_is_error_with_resolved_path():
    results = _project({
        "printer.cfg": "[include missing.cfg]\n[printer]\nkinematics: cartesian\n",
        "other.cfg": "[gcode_macro X]\ngcode: G28\n",
    })
    findings = _findings(results, code="missing_include")
    assert len(findings) == 1, f"expected one finding, got: {[e.message for e in findings]}"
    assert findings[0].severity == "error"
    # Message shows the resolved path (include resolved relative to the
    # directory of the including file, mirroring configfile.py:183-184) so
    # the user sees exactly where Klipper would have looked.
    assert "missing.cfg" in findings[0].message
    assert "Include file 'missing.cfg' was not found" in findings[0].message


def test_missing_include_from_subdir_resolves_relative_to_including_file():
    # Include in a subdir file resolves relative to THAT file's directory,
    # exactly like configfile.py:183-184.
    results = validate_project_configs({
        "macros/printer.cfg": parse_config(
            "[include missing.cfg]\n[printer]\nkinematics: cartesian\n",
            "macros/printer.cfg"),
        "macros/other.cfg": parse_config(
            "[gcode_macro X]\ngcode: G28\n", "macros/other.cfg"),
    })
    findings = _findings(results, code="missing_include")
    assert len(findings) == 1, f"expected one finding, got: {[e.message for e in findings]}"
    assert "macros/missing.cfg" in findings[0].message


def test_present_include_not_flagged():
    results = _project({
        "printer.cfg": "[include other.cfg]\n[printer]\nkinematics: cartesian\n",
        "other.cfg": "[gcode_macro X]\ngcode: G28\n",
    })
    assert not _findings(results, code="missing_include")


def test_glob_include_never_flagged():
    results = _project({
        "printer.cfg": (
            "[include macros/*.cfg]\n"
            "[include *.cfg]\n"
            "[printer]\n"
            "kinematics: cartesian\n"
        ),
    })
    assert not _findings(results, code="missing_include")


def test_single_file_mode_not_flagged():
    # File-local validation never sees the project — partial-import case.
    result = validate_config(parse_config(
        "[include missing.cfg]\n[printer]\nkinematics: cartesian\n", "printer.cfg"))
    assert not [e for e in result.errors if e.code == "missing_include"]


# --- non-promoted regressions: these stay warning ---------------------------

def test_unknown_param_stays_warning():
    result = validate_config(parse_config(
        "[idle_timeout]\n"
        "timeout: 300\n"
        "gcode: G28\n"
        "not_a_real_param: 1\n",
        "printer.cfg"))
    findings = [e for e in result.errors if e.code == "unknown_param"]
    assert findings, "expected an unknown_param finding"
    assert all(e.severity == "warning" for e in findings)


def test_bed_mesh_requires_probe_stays_warning():
    result = validate_config(parse_config(
        "[bed_mesh]\n"
        "mesh_min: 0, 0\n"
        "mesh_max: 200, 200\n"
        "probe_count: 3, 3\n",
        "printer.cfg"))
    findings = [
        e for e in result.errors
        if e.section == "bed_mesh" and "requires [probe]" in e.message
    ]
    assert findings, "expected a bed_mesh requires-probe finding"
    # probe.py start_probe: lookup_object fires at RUN time, not load.
    assert all(e.severity == "warning" for e in findings)
