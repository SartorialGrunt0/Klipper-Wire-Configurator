"""PR #43 round-2 review: facade / cap / registry-honesty fixes.

Contract pinned here, by finding id:

A-F4  No-invocation law on BOTH surfaces. A params dict the caller never
      declared must not make an EMPTY parameter authoritative: the engine
      turns every undeclared param read into param-dependent INFO, never
      a fabricated 'renders EMPTY' error. An explicitly declared call
      (even a bare `params={}`) stays authoritative.
A-F8  Traditional letter commands: 'M26 S10' DECLARES S under Klipper's
      args_r pairing (gcode.py:198-215), so the required-param presence
      test must accept the letter form — the NAME=-only test fabricated
      "missing required parameter 'S='" for a line the printer accepts.
      A line with no S at all must still warn; extended NAME= unchanged.
A-F9  A missing/corrupt command-registry artifact is REPORTED (one info
      finding per call + an explicit "Shape checks SKIPPED" verdict),
      never a silent "Findings: none — every rendered command matched"
      measured against an empty registry.
A-R1  Rendered lines are capped per scenario with an honest elision
      line — never a silent truncation (F17 doctrine).
OT-1  Expected-effect lines are path-tagged when the body renders more
      than one path, matching the rendered lines above them.
OT-2  When the section inventory falls back to THIS HOST's config
      mirror, the output says so; mux-target verdicts then describe the
      host, not necessarily the project under discussion.
COV   'gcode: G28' plus indented continuation lines is ONE option value
      (configparser continuation), so the checked body must include them.
T-2   The Execution trace's geometry provenance is DISCLOSED: with an
      empty working overlay the bounds/home come from this host's
      config mirror, so REFUSED/limit verdicts describe the host — the
      header says so and the OT-2 note's scope covers motion verdicts.
T-3   validate_macro treats a params_*-derived default as a DECLARED
      DEFAULT (params=None), never as an authoritative bare invocation:
      both surfaces must report the same INFO param-dependent verdict.
T-6   Presence for traditional letters is the whole-line args_r split
      ('M26 S 10' supplies S='10'), identical to the render engine's
      splitter; an empty value ('M26 S') is still a missing parameter.
T-8   The Execution trace is capped per scenario with an honest elision
      line, same doctrine as the rendered lines above it.
T-9   A FAILED command-registry load is never cached: the next call
      retries, so a returning artifact re-enables the shape checks.
"""
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

import pytest  # noqa: E402

import mcp_server  # noqa: E402
import services.gcode_registry as gcode_registry  # noqa: E402
from mcp_server import McpServer  # noqa: E402
from parser import macro_render  # noqa: E402
from parser.macro_render import simulate_macro_uncached  # noqa: E402


def _validate(macro_text):
    return McpServer()._handle_validate_macro({"macro_text": macro_text})


def _call(**args):
    return McpServer()._handle_simulate_macro(args)


@pytest.fixture(autouse=True)
def _fresh_render_cache():
    """The engine caches by input tuple; a neutered-registry result must
    never be served to (or reused by) another test."""
    macro_render._render_cache.clear()
    yield
    macro_render._render_cache.clear()


def _raise_missing(*_a, **_kw):
    raise FileNotFoundError("no gcode registry artifact")


# ── A-F4: no declared invocation is not an empty invocation ───────────────

_PARAM_MACRO = ("[gcode_macro SETTEMP]\n"
                "description: set the hotend\n"
                "gcode:\n"
                "  M104 S{params.S}\n")


def test_validate_macro_undeclared_invocation_is_not_authoritative():
    """validate_macro declares no invocation when the section has no
    params_* defaults. Passing {} anyway made the empty S authoritative
    and fabricated a hard ERROR ('renders EMPTY') about a line Klipper
    would only error on if the caller really passed nothing."""
    out = _validate(_PARAM_MACRO)
    assert "renders EMPTY" not in out, out
    assert "has no declared value and no invocation was given" in out, out


def test_validate_macro_empty_params_default_keeps_its_hard_error():
    """Guard against over-fixing: a params_* default that IS declared and
    IS empty stays a real error (params_X rides every invocation)."""
    out = _validate("[gcode_macro TOGGLE_LEDS]\n"
                    "description: leds\n"
                    "params_red:\n"
                    "gcode:\n"
                    "    SET_LED LED=stealthburner RED={params.red}\n")
    assert "renders EMPTY" in out, out


def test_simulate_tool_undeclared_invocation_is_not_fabricated():
    out = _call(macro_text=_PARAM_MACRO)
    assert "renders EMPTY" not in out, out
    assert "has no declared value and no invocation was given" in out, out
    # the assumption echo must not claim a call the caller never declared
    assert "Declared: params: none" in out, out


def test_simulate_tool_explicit_empty_params_stays_authoritative():
    """An explicit bare invocation ({}) IS a Klipper call: the empty S is
    then a real run-time error and must stay one."""
    out = _call(macro_text=_PARAM_MACRO, params={})
    assert "Declared: params: {}" in out, out
    assert "renders EMPTY" in out, out


def test_simulate_tool_scenario_list_is_a_declared_call():
    """A listed scenario IS an invocation (Klipper always passes a params
    dict on a call) — the bare-scenario abort class stays visible."""
    out = _call(macro_text=_PARAM_MACRO, scenarios=[{"name": "bare"}])
    assert "Declared: params: {}" in out, out
    assert "renders EMPTY" in out, out


# ── A-F8: traditional letter params declare themselves ────────────────────

def test_letter_param_value_satisfies_a_required_param():
    out = _validate("[gcode_macro SDCARD_RESUME]\n"
                    "description: resume\n"
                    "gcode:\n"
                    "  M26 S10\n")
    assert "missing required parameter" not in out, out


def test_letter_param_negative_and_decimal_values_are_values():
    for value in ("S-5", "S.25"):
        out = _validate("[gcode_macro SDCARD_RESUME]\n"
                        "description: resume\n"
                        f"gcode:\n  M26 {value}\n")
        assert "missing required parameter" not in out, (value, out)


def test_letter_param_absent_still_warns():
    """No S at all is still a verdict — the fix must only teach the
    presence test the letter FORM, never make a required param optional."""
    out = _validate("[gcode_macro SDCARD_RESUME]\n"
                    "description: resume\n"
                    "gcode:\n"
                    "  M26\n")
    assert "missing required parameter" in out, out


def test_extended_param_presence_is_unchanged():
    ok = _validate("[gcode_macro LEDS]\n"
                   "description: leds\n"
                   "gcode:\n"
                   "  SET_LED LED=chamber RED=1\n")
    assert "missing required parameter" not in ok, ok
    bad = _validate("[gcode_macro LEDS]\n"
                    "description: leds\n"
                    "gcode:\n"
                    "  SET_LED RED=1\n")
    assert "missing required parameter LED" in bad, bad


# ── A-F9: an unavailable registry is never a clean verdict ────────────────

def test_registry_unavailable_is_one_info_finding(monkeypatch):
    monkeypatch.setattr(gcode_registry, "load_registry", _raise_missing)
    result = simulate_macro_uncached("M106 S255", {})
    gaps = [f for f in result.findings
            if f.code == "gcode_registry_unavailable"]
    assert len(gaps) == 1, result.findings
    assert gaps[0].severity == "info"
    assert "not checked" in gaps[0].message or "skipped" in gaps[0].message


def test_simulate_tool_never_claims_a_clean_shape_check(monkeypatch):
    monkeypatch.setattr(gcode_registry, "load_registry", _raise_missing)
    out = _call(macro_text="[gcode_macro FAN]\n"
                           "description: fan\n"
                           "gcode:\n"
                           "    M106 S255\n")
    assert "Shape checks SKIPPED - command registry unavailable" in out, out
    assert "Findings: none — every rendered command matched" not in out, out
    # the finding itself must survive to the output, not just the verdict
    assert "registry could not be loaded" in out, out


def test_available_registry_keeps_the_positive_verdict():
    out = _call(macro_text="[gcode_macro FAN]\n"
                           "description: fan\n"
                           "gcode:\n"
                           "    M106 S255\n")
    assert "Findings: none — every rendered command matched" in out, out
    assert "Shape checks SKIPPED" not in out, out


# ── A-R1: emitted render lines are capped, honestly ───────────────────────

def test_rendered_lines_are_capped_and_the_elision_is_announced():
    body = "\n".join(f"    M117 line{i}" for i in range(250))
    out = _call(macro_text="[gcode_macro MANY]\ngcode:\n" + body + "\n")
    assert out.count("M117 line") == 200, out.count("M117 line")
    assert "50 further lines elided from 250 rendered" in out, out
    assert "read the config for the full expansion" in out, out


# ── OT-1: effect lines follow the render paths ────────────────────────────

_BRANCHING_FAN = ("[gcode_macro BR]\n"
                  "description: branch\n"
                  "gcode:\n"
                  "  {% if printer.foo %}\n"
                  "  M106 S255\n"
                  "  {% else %}\n"
                  "  M107\n"
                  "  {% endif %}\n")


def _effect_lines(out):
    return [ln for ln in out.splitlines()
            if "part-cooling fan" in ln and "commanded" in ln]


def test_effect_lines_are_path_tagged_when_the_body_branches():
    out = _call(macro_text=_BRANCHING_FAN)
    assert "Rendered (2 path(s))" in out, out
    effects = _effect_lines(out)
    assert any(e.endswith("[path 0]") and "100%" in e for e in effects), out
    assert any(e.endswith("[path 1]") and "0%" in e for e in effects), out


def test_single_path_effect_lines_stay_untagged():
    out = _call(macro_text="[gcode_macro P]\ngcode:\n    M106 S255\n")
    effects = _effect_lines(out)
    assert effects, out
    assert all("[path" not in e for e in effects), effects


# ── OT-2: the host-config fallback is announced ───────────────────────────

def test_host_sections_fallback_is_announced(monkeypatch, tmp_path):
    monkeypatch.setattr(mcp_server, "_working_scan_items", lambda: [])
    cfgdir = tmp_path / "cfgs"
    cfgdir.mkdir()
    (cfgdir / "printer.cfg").write_text(
        "[fan_generic aux]\n[printer]\nmax_velocity: 300\n",
        encoding="utf-8")
    monkeypatch.setattr(mcp_server, "LOCAL_CONFIGS_DIR", cfgdir)
    monkeypatch.setattr(mcp_server, "_system_config_path",
                        lambda: tmp_path / "absent")
    out = _call(macro_text="[gcode_macro F]\ngcode:\n    M106 S255\n")
    assert "working overlay was empty" in out, out
    assert "HOST" in out, out
    assert "M106 S255" in out, out  # the section data itself is untouched


def test_overlay_sections_do_not_get_the_host_caveat(monkeypatch):
    monkeypatch.setattr(mcp_server, "_working_scan_items", lambda: [
        ("printer.cfg", "[fan_generic aux]\n[printer]\nmax_velocity: 300\n"),
    ])
    out = _call(macro_text="[gcode_macro F]\ngcode:\n    M106 S255\n")
    assert "working overlay was empty" not in out, out


# ── COV: an inline 'gcode:' value keeps its continuation lines ────────────

def test_inline_gcode_value_keeps_its_indented_continuation():
    """configparser: the indented line after 'gcode: M117 resuming' is
    part of the SAME option value, so Klipper runs it — the checked body
    must contain it too (the facade's same-line dedupe may report the
    rendered twin instead of the static 2b warning; either wording
    proves the line was scanned, line 2 proves it came from the
    continuation)."""
    out = _validate("[gcode_macro RESUME_ANY]\n"
                    "description: resume\n"
                    "gcode: M117 resuming\n"
                    "  M26\n")
    assert "missing required parameter S" in out, out
    assert "Line 2:" in out, out

# ── T-2: the trace's geometry provenance is disclosed ─────────────────────

_HOST_MIRROR_250 = (
    "[printer]\nkinematics: cartesian\n\n"
    "[stepper_x]\nposition_endstop: 0\nposition_max: 250\n\n"
    "[stepper_y]\nposition_endstop: 0\nposition_max: 250\n\n"
    "[stepper_z]\nposition_endstop: 0\nposition_max: 250\n")

_PARK_OUT_OF_BOUNDS = ("[gcode_macro PARK]\n"
                       "description: park\n"
                       "gcode:\n"
                       "  G28\n"
                       "  G1 X300 Y10\n")


def _trace_header(out):
    return next(ln for ln in out.splitlines()
                if ln.startswith("Execution trace"))


def test_host_mirror_geometry_is_disclosed_in_the_trace_header(monkeypatch,
                                                              tmp_path):
    """Empty overlay → _sim_motion_profile() derives the bounds from THIS
    HOST's config mirror. The trace then REFUSES a move the project never
    declared a limit for, so the header must name the geometry's source
    instead of claiming 'the machine geometry the project declares'."""
    monkeypatch.setattr(mcp_server, "_working_scan_items", lambda: [])
    cfgdir = tmp_path / "cfgs"
    cfgdir.mkdir()
    (cfgdir / "printer.cfg").write_text(_HOST_MIRROR_250, encoding="utf-8")
    monkeypatch.setattr(mcp_server, "LOCAL_CONFIGS_DIR", cfgdir)
    monkeypatch.setattr(mcp_server, "_system_config_path",
                        lambda: tmp_path / "absent")
    out = _call(macro_text=_PARK_OUT_OF_BOUNDS)
    # the verdict really did come from the host mirror's bounds...
    assert "beyond machine limit 0–250" in out, out
    header = _trace_header(out)
    assert "THIS HOST's config mirror" in header, header
    assert "the project declares" not in header, header
    # ...and the OT-2 note's scope covers motion/geometry verdicts too,
    # not only section/mux-target ones.
    note = next(ln for ln in out.splitlines()
                if ln.startswith("NOTE: hardware sections"))
    assert "geometry" in note, note


def test_overlay_geometry_keeps_the_project_header(monkeypatch):
    """When the project overlay DOES declare the stepper sections, the
    bounds are the project's and the existing header stays."""
    overlay = _HOST_MIRROR_250.replace("250", "300")
    monkeypatch.setattr(mcp_server, "_working_scan_items",
                        lambda: [("printer.cfg", overlay)])
    out = _call(macro_text=_PARK_OUT_OF_BOUNDS)
    header = _trace_header(out)
    assert "the machine geometry the project declares" in header, header
    assert "THIS HOST" not in header, header


# ── T-3: a params_* default is not an authoritative invocation ────────────

_PARAM_DEFAULT_MACRO = ("[gcode_macro HOT]\n"
                        "description: hot\n"
                        "params_S: 210\n"
                        "gcode:\n"
                        "  M104 S{params.S}\n"
                        "  M140 S{params.BED}\n")


def test_params_default_is_not_an_authoritative_invocation():
    """params_S declares a DEFAULT (the KWC simulation convention), not a
    caller invocation. Passing the derived dict as `params` made the
    undeclared BED read a hard 'renders EMPTY' ERROR on validate_macro
    while simulate_macro gave the honest INFO for the same text — the two
    surfaces must agree."""
    out = _validate(_PARAM_DEFAULT_MACRO)
    assert "renders EMPTY" not in out, out
    assert "param-dependent" in out, out
    sim = _call(macro_text=_PARAM_DEFAULT_MACRO)
    assert "renders EMPTY" not in sim, sim
    assert "param-dependent" in sim, sim
    assert "M104 S210" in sim, sim


# ── T-6: letter presence is the whole-line args_r split ───────────────────

def test_letter_param_with_a_space_before_its_value_is_present():
    """Klipper splits the WHOLE line with args_r (gcode.py:201,210-214),
    so 'M26 S 10' supplies S='10' and the printer RUNS it — the per-token
    presence test fabricated "missing required parameter 'S='"."""
    out = _validate("[gcode_macro SDCARD_RESUME]\n"
                    "description: resume\n"
                    "gcode:\n"
                    "  M26 S 10\n")
    assert "missing required parameter" not in out, out


def test_empty_letter_value_is_still_a_missing_parameter():
    """Guard against over-fixing: 'M26 S' declares nothing to parse, which
    is the same failure the PR already reported."""
    out = _validate("[gcode_macro SDCARD_RESUME]\n"
                    "description: resume\n"
                    "gcode:\n"
                    "  M26 S\n")
    assert "missing required parameter 'S='" in out, out
    assert "renders EMPTY" in out, out


def test_letter_presence_matches_the_render_engine_splitter():
    """Both surfaces must read the letter grammar identically: the same
    args_r split the render engine uses at its A-01 fix decides presence
    here too (a required letter is present when its run's remainder,
    stripped, is non-empty)."""
    from parser.macro_render import _KLIPPER_ARGS_R

    cases = [("M26 S10", True), ("M26 S 10", True), ("M106 S 100", True),
             ("M26 S.25", True), ("M26 S", False), ("M26", False)]
    for line, want in cases:
        parts = _KLIPPER_ARGS_R.split(line.upper())
        present = {parts[i]: parts[i + 1].strip()
                   for i in range(1, len(parts) - 1, 2)}
        assert bool(present.get("S")) == want, (line, present)
        assert McpServer._line_has_param(line, "S") == want, (line, want)


# ── T-8: the execution trace is capped, honestly ──────────────────────────

def test_execution_trace_is_capped_and_the_elision_is_announced():
    """A-R1 bounded the rendered list only: a 300-command body still
    streamed ~500 output lines because the trace emits one line per
    command. Cap it with the same announced-elision doctrine."""
    body = "  G28\n" + "\n".join(
        f"  G1 X{i % 100} Y{i % 50} F3000" for i in range(300))
    out = _call(macro_text="[gcode_macro MANY]\ngcode:\n" + body + "\n")
    trace = out.split("Execution trace", 1)[1]
    emitted = [ln for ln in trace.splitlines()
               if re.match(r"  L\d+\b", ln)
               or ln.startswith(("  Start:", "  Final state"))]
    assert len(emitted) <= 200, len(emitted)
    assert len(emitted) >= 199, len(emitted)
    match = re.search(r"\.\.\. (\d+) further trace lines elided", trace)
    assert match and int(match.group(1)) > 0, trace
    # the render cap above it is untouched
    assert "further lines elided from 301 rendered" in out, out


# ── T-9: a failed registry load is retried, never cached ──────────────────

@pytest.fixture()
def _fresh_registry_cache():
    mcp_server.McpServer._gcode_registry_cache = None
    yield
    mcp_server.McpServer._gcode_registry_cache = None


def test_failed_registry_load_is_not_cached(monkeypatch, _fresh_registry_cache):
    """The except branch used to assign the empty dict to the module cache,
    disabling required-param checks process-wide even after the artifact
    came back."""
    real_load = gcode_registry.load_registry
    monkeypatch.setattr(gcode_registry, "load_registry", _raise_missing)
    assert McpServer._gcode_command_registry() == {}
    assert getattr(mcp_server.McpServer, "_gcode_registry_cache", None) is None, (
        "the failed load was cached — shape checks stay off forever")
    # the artifact returns: the NEXT call must retry, not serve the failure
    monkeypatch.setattr(gcode_registry, "load_registry", real_load)
    assert McpServer._gcode_command_registry(), "the registry was never retried"
    assert list(McpServer._missing_required_params("M26")), (
        "required-param checks stayed disabled after the registry returned")
