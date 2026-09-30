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
  pin format/prefix, requires-missing (bed_mesh -> probe),
  sensorless-homing conflict all stay WARNING.

UPDATE 2026-09-30: unknown_param was on the NOT-promoted list; it is now
promoted CONDITIONALLY (only when KWC can ground the claim — see
test_unknown_param_in_known_section_is_error and the guard tests below, and
.hermes/plans/2026-09-29_230500-unknown-param-escalation.md). The premise of
the old entry ("Klipper silently ignores unknown params") was false:
configfile.py check_unused (424-441) fails the load on any unread option.
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

def test_unknown_param_in_known_section_is_error():
    # 2026-09-30 flip: an unrecognized option in a section KWC GROUNDS (a
    # coverage record derived from the bundled Klipper snapshot + docs) is a
    # Klipper load failure — configfile.py check_unused (424-441), called at
    # klippy.py:127 — and must be un-acknowledgeable. Warnings were being
    # ignored in the editor AND applied by the AI chat edit path (warnings
    # are advisory there), shipping configs klippy refuses to load.
    result = validate_config(parse_config(
        "[idle_timeout]\n"
        "timeout: 300\n"
        "gcode: G28\n"
        "not_a_real_param: 1\n",
        "printer.cfg"))
    findings = [e for e in result.errors if e.code == "unknown_param"]
    assert findings, "expected an unknown_param finding"
    assert all(e.severity == "error" for e in findings), \
        f"grounded unknown_param must be an error: {[(e.severity, e.message) for e in findings]}"


def test_unknown_param_in_unmodeled_section_stays_warning():
    # Guard 2: sdcard_loop's SectionDef has params=[] — KWC makes NO claim
    # about the section, so it must not block on it even though klippy owns
    # the type.
    result = validate_config(parse_config(
        "[sdcard_loop]\nlocation: 10\nheight: 0.2\nbogus_option: 1\n",
        "printer.cfg"))
    findings = [e for e in result.errors if e.code == "unknown_param"]
    assert findings and all(e.severity == "warning" for e in findings)


def test_unknown_param_in_section_without_coverage_record_stays_warning():
    # Guard 3: update_manager is Moonraker-owned — no Klipper module and no
    # Config_Reference.md record, so KWC has no ground truth to escalate on.
    result = validate_config(parse_config(
        "[update_manager my_ext]\npath: ~/kiauh\nbogus_option: 1\n",
        "printer.cfg"))
    findings = [e for e in result.errors if e.code == "unknown_param"]
    if not findings:
        # update_manager resolved with bogus_option unknown only if the type
        # itself is recognized; either way an ERROR is what must not appear.
        return
    assert all(e.severity == "warning" for e in findings), \
        f"ungrounded section must not escalate: {[(e.severity, e.message) for e in findings]}"


def test_unknown_param_matching_wildcard_is_clean():
    # Guard 4: keys matched by a SectionDef wildcard are known params, not
    # findings at all. (Plan deviation, deliberate: the plan's fixture used
    # [tmc2209] driver_custom, but the UART drivers deliberately enumerate
    # every real register WITHOUT a driver_* wildcard — klipper reads only
    # known field names (tmc.py:55), so a bogus register on tmc2209 is a
    # genuine load failure and SHOULD escalate, see the next test.)
    result = validate_config(parse_config(
        "[gcode_macro X]\nvariable_whatever: 1\ngcode: G28\n",
        "printer.cfg"))
    assert not [e for e in result.errors if e.code == "unknown_param"]
    # tmc2130 models driver_* (KWC's over-permissive SPI stance — kept as-is;
    # wildcard match short-circuits before the escalation guard)
    result = validate_config(parse_config(
        "[tmc2130 stepper_x]\nrun_current: 0.8\nsense_resistor: 0.110\n"
        "driver_who_knows: 1\n",
        "printer.cfg"))
    assert not [e for e in result.errors if e.code == "unknown_param"]


def test_unknown_driver_register_on_uart_tmc_escalates():
    # tmc2209 enumerates all real driver registers and has a coverage
    # record: a hallucinated register the chip does not define is exactly
    # the AI-chat-edit failure this flip exists to block.
    result = validate_config(parse_config(
        "[tmc2209 stepper_x]\nrun_current: 0.8\ndriver_custom: 1\n",
        "printer.cfg"))
    findings = [e for e in result.errors
                if e.code == "unknown_param" and e.param == "driver_custom"]
    assert findings and all(e.severity == "error" for e in findings)


def test_unknown_section_params_stay_warning():
    # Guard 1: unknown section types keep their own unknown_section warning
    # and never reach the param loop — plugin sections load fine.
    result = validate_config(parse_config(
        "[my_plugin_thing]\nwhatever: 1\n",
        "printer.cfg"))
    assert not [e for e in result.errors if e.code == "unknown_param"]
    assert [e for e in result.errors if e.code == "unknown_section"
            and e.severity == "warning"]


def test_bulk_ack_cannot_silence_escalated_unknown_param(monkeypatch, tmp_path):
    # Errors are structurally outside the identity store
    # (_suppress_acknowledged_warning_identities is warning-only), but pin
    # it against the exact escalation shape: an ack written for the pre-flip
    # warning must not hide the error.
    monkeypatch.setenv("KWC_LAYOUT_DIR", str(tmp_path))
    from services.warning_acknowledgments import (
        acknowledge_warning_identities, finding_identity,
    )
    acknowledge_warning_identities([
        finding_identity("printer.cfg", "unknown_param", "idle_timeout",
                         "not_a_real_param"),
    ])
    result = validate_config(parse_config(
        "[idle_timeout]\n"
        "timeout: 300\n"
        "gcode: G28\n"
        "not_a_real_param: 1\n",
        "printer.cfg"))
    findings = [e for e in result.errors
                if e.code == "unknown_param" and e.param == "not_a_real_param"]
    assert findings and all(e.severity == "error" for e in findings), \
        "an escalated unknown_param must survive a bulk ack of its old identity"


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
