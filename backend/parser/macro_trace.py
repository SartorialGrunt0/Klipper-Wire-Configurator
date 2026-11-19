"""Motion trace over RENDERED macro lines (P1 of the simulate trace).

WHY: syntax-correct macros can still DO the wrong thing — the "move to
front center" macro that renders clean and lands dead centre (dogfood,
Sir 2026-11-18). The model needs to watch the printer's state change
line by line, with each position annotated against the machine's own
declared geometry, so a wrong coordinate contradicts the request's words.

LAWS:
  * Rendering is untouched. Klipper renders the whole body before any
    line executes, so Jinja sees the invocation-time position — that is
    the backend's static overlay's job and it stays. This module runs
    over the RENDERED lines only: an execution-level model.
  * Never invent: bounds/home exist only if the project config declares
    them (no frontend drawing-defaults); a coordinate that did not
    resolve makes the position unresolved, never guessed.
  * A refused line aborts: an un-homed move or a soft-limit violation
    stops the trace exactly like the real macro aborts (virtual-printer
    law, 2026-11-15 — a refused line ABORTS; later lines never run).
  * Refusal wording describes Klipper's behaviour; the bundled
    reference checkout is too old for verbatim quoting, so nothing here
    pretends to be klippy's exact response text.

HOME/BOUNDARIES parity: frontend macroDesigner.ts createMachineProfile
(same derivation, minus its drawing defaults — the trace would rather
stay silent than assume 200mm). Round kinematics match both the frontend
DELTA_KINEMATICS and printer_memory_routes._ROUND_KINEMATICS.
"""
from __future__ import annotations

import math
import re
import shlex
from dataclasses import dataclass, field

from parser.macro_render import _is_traditional_gcode

_ROUND_KINEMATICS = {"delta", "rotary_delta"}

# "at the edge" tolerance for annotations (mm). 2mm is generous on
# purpose: a macro parking 1.5mm off the endstop IS at the edge.
EDGE_TOL = 2.0
# exact-centre tolerance
CENTRE_TOL = 1e-6

# commands that physically move Z in ways we do not model — the honest
# move is to make Z unresolved, not to pretend it stayed.
Z_MOVERS = {
    "PROBE", "PROBE_CALIBRATE", "PROBE_ACCURACY", "BED_MESH_CALIBRATE",
    "QUAD_GANTRY_LEVEL", "Z_TILT_ADJUST", "Z_TILT_CALIBRATE",
    "DELTA_CALIBRATE", "CALIBATE_Z", "SCREWS_TILT_CALCULATE", "G30", "G31",
}

_AXES = "xyz"


# ── machine profile ─────────────────────────────────────────────────────

@dataclass(frozen=True)
class MotionProfile:
    bounds: dict[str, tuple[float, float]] = field(default_factory=dict)
    home: dict[str, float] = field(default_factory=dict)
    radius: float | None = None   # round bed print radius


def _section_params(text: str, section: str) -> dict[str, str]:
    """First [section] block's key: value map (lowercased keys)."""
    out: dict[str, str] = {}
    wanted = section.lower()
    in_section = False
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("["):
            name = stripped[1:].split("]", 1)[0].strip().lower()
            if name == wanted or name.startswith(wanted + " "):
                in_section = True
                continue
            if in_section:
                break
            continue
        if in_section and ":" in stripped and not stripped.startswith("#"):
            key, _, value = stripped.partition(":")
            key = key.strip().lower()
            if key and key not in out:
                out[key] = value.split("#", 1)[0].strip()
    return out


def _num(value: str | None) -> float | None:
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def derive_motion_profile(config_texts: list[str]) -> MotionProfile:
    """Bounds + home the project config DECLARES. Partial data yields
    silence, never a wrong box (derive_machine_facts' conservatism)."""
    kinematics = ""
    for text in config_texts:
        if not text:
            continue
        printer = _section_params(text, "printer")
        if printer.get("kinematics"):
            kinematics = printer["kinematics"].strip().lower()
            break
    for text in config_texts:
        if not text:
            continue
        if kinematics in _ROUND_KINEMATICS:
            printer = _section_params(text, "printer")
            radius = _num(printer.get("print_radius")
                          or printer.get("delta_radius"))
            if radius is None:
                continue
            bounds = {"x": (-radius, radius), "y": (-radius, radius)}
            home: dict[str, float] = {"x": 0.0, "y": 0.0}
            sz = _section_params(text, "stepper_z")
            z_top = _num(sz.get("position_max"))
            zmin = _num(sz.get("position_min"))
            if z_top is not None:
                bounds["z"] = (zmin if zmin is not None else 0.0, z_top)
            zend = _num(sz.get("position_endstop"))
            if zend is not None:
                home["z"] = zend
            elif z_top is not None:
                home["z"] = z_top   # deltas home at the top
            return MotionProfile(bounds=bounds, home=home, radius=radius)
        sx = _section_params(text, "stepper_x")
        sy = _section_params(text, "stepper_y")
        sz = _section_params(text, "stepper_z")
        xmax, ymax, zmax = (_num(s.get("position_max"))
                            for s in (sx, sy, sz))
        if None in (xmax, ymax, zmax):
            continue   # this file has no complete stepper triple
        b: dict[str, tuple[float, float]] = {}
        h: dict[str, float] = {}
        for axis, sec, top in (("x", sx, xmax), ("y", sy, ymax),
                               ("z", sz, zmax)):
            bottom = _num(sec.get("position_min")) or 0.0
            b[axis] = (bottom, top)
            endstop = _num(sec.get("position_endstop"))
            h[axis] = endstop if endstop is not None else bottom
        return MotionProfile(bounds=b, home=h)
    return MotionProfile()


# ── state ───────────────────────────────────────────────────────────────

@dataclass
class MotionState:
    pos: dict[str, float | None]
    homed: set[str]
    abs_xyz: bool = True
    abs_e: bool = True
    # P2 (2026-11-18): commanded targets ride the same trace so runs=N
    # threads them between calls. Laws: D2 — TARGETS only, never a current
    # temperature or heating progress; D3 — an undeclared name is absent
    # (renders '—'), a commanded-but-unparseable one is present as None
    # (renders '?'). Keys: heaters name→°C, fans name→%, leds name→tuple |
    # 'effect <n>' | 'off'.
    heaters: dict[str, float | None] = field(default_factory=dict)
    fans: dict[str, float | None] = field(default_factory=dict)
    leds: dict[str, object] = field(default_factory=dict)

    def copy(self) -> "MotionState":
        return MotionState(dict(self.pos), set(self.homed),
                           self.abs_xyz, self.abs_e,
                           dict(self.heaters), dict(self.fans),
                           dict(self.leds))


_COORD_PATHS = ("toolhead.position", "gcode_move.gcode_position",
                "gcode_move.position", "motion_report.live_position")


def _flatten(state: dict, prefix: str = "") -> dict:
    out: dict = {}
    for k, v in (state or {}).items():
        key = f"{prefix}{str(k).lower()}"
        if isinstance(v, dict):
            out.update(_flatten(v, key + "."))
        else:
            out.setdefault(key, v)
    return out


def seed_state(printer_state: dict) -> tuple[MotionState, list[str]]:
    """Seed from the scenario's DECLARED printer_state — nothing else."""
    notes: list[str] = []
    flat = _flatten(printer_state)
    pos: dict[str, float | None] = {a: None for a in "xyze"}
    declared = False
    for path in _COORD_PATHS:
        raw = flat.get(path)
        values: list = []
        if isinstance(raw, (list, tuple)):
            values = list(raw)
            if len(values) < 4:              # Klipper Coord pads with 0
                values += [0.0] * (4 - len(values))
        elif isinstance(raw, dict):
            values = [raw.get(a) for a in "xyze"]
        nums = [_num(str(v)) if not isinstance(v, float) else v
                for v in values]
        if any(v is not None for v in nums[:3]):
            for axis, v in zip("xyze", nums):
                pos[axis] = v if isinstance(v, float) else None
            declared = True
            break
    homed: set[str] = set()
    for path in ("toolhead.homed_axes", "gcode_move.homed_axes"):
        raw = flat.get(path)
        if isinstance(raw, str):
            homed = {c for c in raw.lower() if c in _AXES}
            break
    if declared and not homed:
        homed = set(_AXES)
        notes.append("position was declared without homed_axes — "
                     "declaring a position asserts the machine knows it")
    # P2: heater/fan/LED state from DECLARED status keys only
    # (Moonraker status names: extruder.target, heater_generic chamber
    # .target, fan.speed, fan_generic myfan.speed, led strip.color_data).
    heaters: dict[str, float | None] = {}
    for key, raw in flat.items():
        if not key.endswith(".target"):
            continue
        base = key[:-len(".target")]
        if base in ("extruder", "heater_bed"):
            nm = base
        elif base.startswith("heater_generic "):
            nm = base.split(" ", 1)[1]
        else:
            continue
        v = _num(raw)
        if v is not None:
            heaters[nm] = v
    fans: dict[str, float | None] = {}
    for key, raw in flat.items():
        if not key.endswith(".speed"):
            continue
        base = key[:-len(".speed")]
        if base == "fan":
            nm = "fan"
        elif base.startswith(("fan_generic ", "heater_fan ",
                              "controller_fan ")):
            nm = base.split(" ", 1)[1]
        else:
            continue
        v = _num(raw)
        if v is not None:
            fans[nm] = round(v * 100.0, 1)
    leds: dict[str, object] = {}
    for key, raw in flat.items():
        if not key.endswith(".color_data") \
                or not isinstance(raw, (list, tuple)) or not raw:
            continue
        base = key[:-len(".color_data")]
        if not base.startswith("led ") or not isinstance(raw[0],
                                                         (list, tuple)):
            continue
        comps = [_num(c) for c in raw[0][:4]]
        if any(c is None for c in comps[:3]):
            continue
        leds[base.split(" ", 1)[1]] = tuple(
            c if c is not None else 0.0 for c in comps)
    return MotionState(pos, homed, heaters=heaters, fans=fans,
                       leds=leds), notes


# ── command parsing (mirrors the letter-vs-KEY=VALUE grammar of the
#    effect lines: traditional G/M codes split by letter, and '=' never
#    leaves a traditional value, live-proven .164) ──────────────────────

_LETTER_ARG = re.compile(r"([A-Z])([^A-Z]*)")


def parse_command(text: str) -> tuple[str, dict[str, str]] | None:
    text = text.split(";")[0].strip()
    if not text:
        return None
    token = text.split()[0].upper()
    rest = text[len(token):].upper()
    params: dict[str, str] = {}
    if _is_traditional_gcode(token):
        for key, value in _LETTER_ARG.findall(rest):
            params[key] = value.strip()
    else:
        try:
            lexer = shlex.shlex(rest, posix=True)
            lexer.whitespace_split = True
            for arg in lexer:
                key, sep, value = arg.partition("=")
                params[key.upper()] = value if sep else ""
        except ValueError:
            params = {}
    # normalise G00/G0 etc to two-char form for dispatch
    norm = token
    if token[:1] in "GM" and token[1:].isdigit():
        norm = token[0] + str(int(token[1:]))
    return norm, params


# ── annotations ─────────────────────────────────────────────────────────

def _fmt(v: float | None) -> str:
    return "?" if v is None else f"{v:g}"


def _fmt_temp(v: float | None) -> str:
    return "?" if v is None else f"{v:g}\u00b0C"


def _fmt_pct(v: float | None) -> str:
    return "?" if v is None else f"{v:g}%"


def _fmt_led(v) -> str:
    if isinstance(v, str):
        return v
    if v is None:
        return "?"
    if len(v) >= 4:
        return "rgbw(" + ", ".join(_fmt(c) for c in v[:4]) + ")"
    return "rgb(" + ", ".join(_fmt(c) for c in v[:3]) + ")"


def _state_suffix(state: "MotionState") -> str:
    """Declared-or-commanded heater/fan/LED state for Start and Final
    lines; groups stay absent until something puts a name in them."""
    out = ""
    if state.heaters:
        out += " \u00b7 targets: " + " ".join(
            f"{n} {_fmt_temp(v)}"
            for n, v in sorted(state.heaters.items()))
    if state.fans:
        out += " \u00b7 fans: " + " ".join(
            f"{n} {_fmt_pct(v)}" for n, v in sorted(state.fans.items()))
    if state.leds:
        out += " \u00b7 leds: " + " ".join(
            f"{n} {_fmt_led(v)}" for n, v in sorted(state.leds.items()))
    return out


def _before(store: dict, name: str, fmt) -> str:
    return fmt(store[name]) if name in store else "\u2014"


def _span(v: float, lo: float, hi: float, near_lo: str, near_hi: str) -> str:
    mid = (lo + hi) / 2.0
    # "at the edge" scales with the bed: 5mm off the endstop of a 250 bed
    # parks AT the edge; 5mm off a small bed's edge is not "at" anything.
    edge_tol = max(EDGE_TOL, 0.03 * (hi - lo))
    if abs(v - mid) <= CENTRE_TOL:
        return f"centre of {lo:g}\u2013{hi:g}"
    if v - lo <= edge_tol:
        return f"\u2248{near_lo} edge ({v:g} of {lo:g}\u2013{hi:g})"
    if hi - v <= edge_tol:
        return f"\u2248{near_hi} edge ({v:g} of {lo:g}\u2013{hi:g})"
    pct = (v - lo) / (hi - lo) * 100.0
    return f"{pct:.0f}% of {lo:g}\u2013{hi:g}"


def annotate(pos: dict, profile: MotionProfile) -> tuple[str, bool]:
    """Human-readable position words for X/Y, only where declared
    geometry can back them. Returns (annotation, used_cartesian_words)."""
    parts: list[str] = []
    cartesian = False
    x, y = pos.get("x"), pos.get("y")
    if profile.radius is not None and x is not None and y is not None:
        d = math.hypot(x, y)
        if d <= CENTRE_TOL:
            parts.append(f"over centre (r\u2264{profile.radius:g})")
        else:
            parts.append(f"r={d:g} of {profile.radius:g} "
                         f"({d / profile.radius * 100:.0f}% out)")
        return " \u00b7 ".join(parts), cartesian
    for axis, lo_lbl, hi_lbl in (("x", "left", "right"),
                                 ("y", "front", "back")):
        v = pos.get(axis)
        span = profile.bounds.get(axis)
        if v is None or span is None:
            continue
        parts.append(f"{axis.upper()} {_span(v, span[0], span[1], lo_lbl, hi_lbl)}")
        cartesian = True
    return " \u00b7 ".join(parts), cartesian


# ── the trace ───────────────────────────────────────────────────────────

@dataclass
class TraceResult:
    lines: list[str] = field(default_factory=list)
    state: MotionState | None = None
    aborted: bool = False


def _pos_str(pos: dict) -> str:
    return f"({_fmt(pos['x'])}, {_fmt(pos['y'])}, {_fmt(pos['z'])})"


def trace_motion(rendered: list[tuple[int | None, str]],
                 profile: MotionProfile,
                 seed: MotionState,
                 start_note: str = "") -> TraceResult:
    """Execute rendered lines against the declared machine geometry.

    ``rendered`` is (source_line, text) per RenderedLine; the trace adds
    no claims about commands it does not model."""
    state = seed.copy()
    out: TraceResult = TraceResult(state=state)
    add = out.lines.append

    ann, _ = annotate(state.pos, profile)
    if all(state.pos[a] is None for a in _AXES) and not state.homed:
        start = ("Start: pos undeclared \u2014 NOT homed (Klipper cold "
                 "start); the first X/Y/Z move is refused")
    else:
        homed = " ".join(a.upper() for a in _AXES if a in state.homed) or "\u2014"
        start = f"Start: pos {_pos_str(state.pos)} \u00b7 homed {homed}"
        if ann:
            start += f" \u00b7 {ann}"
    start += _state_suffix(state)
    if start_note:
        start += f" ({start_note})"
    add(start)

    seen_cartesian = False
    for src_line, raw in rendered:
        loc = f"L{src_line}" if src_line else "L?"
        parsed = parse_command(raw)
        if parsed is None:
            continue
        token, params = parsed

        refusal = None
        if token in ("G0", "G1"):
            moved = [a for a in _AXES if a.upper() in params]
            # homing is checked before limits, like klippy does
            need = [a for a in moved if a not in state.homed]
            if need and any(a.upper() in params for a in need):
                refusal = ("Must home axis first: " + " ".join(need))
            targets: dict[str, float | None] = {}
            unresolved: list[str] = []
            if refusal is None:
                for a in moved:
                    v = _num(params[a.upper()])
                    if v is None:
                        unresolved.append(a)
                        targets[a] = None
                    elif state.abs_xyz:
                        targets[a] = v
                    else:
                        cur = state.pos[a]
                        if cur is None:
                            targets[a] = None
                            unresolved.append(a)
                        else:
                            targets[a] = cur + v
                if refusal is None:
                    for a, t in targets.items():
                        span = profile.bounds.get(a)
                        if t is not None and span is not None and \
                                not (span[0] - 1e-9 <= t <= span[1] + 1e-9):
                            refusal = (f"{a.upper()}={t:g} beyond machine "
                                       f"limit {span[0]:g}\u2013{span[1]:g} "
                                       "(Klipper: move exceeds maximum "
                                       "soft limit)")
                            break
                    tx = targets.get("x", state.pos["x"])
                    ty = targets.get("y", state.pos["y"])
                    if refusal is None and profile.radius is not None \
                            and tx is not None and ty is not None \
                            and math.hypot(tx, ty) > profile.radius + 1e-9:
                        refusal = (f"target ({_fmt(tx)}, {_fmt(ty)}) is "
                                   f"r={math.hypot(tx, ty):g}, beyond the "
                                   f"print radius {profile.radius:g}")
            # extruder bookkeeping rides the same line
            if "R" in params:
                v = _num(params["R"])
                state.pos["e"] = (None if v is None or state.pos["e"] is None
                                  else state.pos["e"] + v)
            elif "E" in params:
                v = _num(params["E"])
                if v is None:
                    state.pos["e"] = None
                elif state.abs_e:
                    state.pos["e"] = v
                elif state.pos["e"] is None:
                    state.pos["e"] = None
                else:
                    state.pos["e"] += v
            if refusal:
                add(f"{loc}: REFUSED — {refusal}")
                add("\u2192 ABORTED at this line: the real printer stops "
                    "the macro here; later lines do not run")
                out.aborted = True
                break
            if moved:
                for a in moved:
                    state.pos[a] = targets[a]
                line = f"{loc}: {raw.strip()} \u2192 pos {_pos_str(state.pos)}"
                ann, cart = annotate(state.pos, profile)
                if unresolved:
                    line += (" \u00b7 " + "/".join(a.upper() for a in unresolved)
                             + " unresolved (coordinate did not render)")
                elif ann:
                    line += f" \u00b7 {ann}"
                    seen_cartesian = seen_cartesian or cart
                add(line)
            elif state.pos["e"] is not None:
                add(f"{loc}: {raw.strip()} \u2192 e={_fmt(state.pos['e'])} "
                    "(extruder only \u2014 no homing required)")

        elif token == "G28.1":
            state.homed = set(_AXES)
            add(f"{loc}: G28.1 \u2192 marked homed X Y Z, no move "
                f"(pos {_pos_str(state.pos)})")

        elif token == "G28":
            axes = [a for a in _AXES if a.upper() in params] or list(_AXES)
            state.homed |= set(axes)
            for a in axes:
                state.pos[a] = profile.home.get(a)
            landed = " ".join(a.upper() for a in axes)
            note = "" if profile.home else \
                " (home positions not declared \u2014 pos unresolved)"
            add(f"{loc}: G28 \u2192 homed {landed}; pos \u2192 "
                f"{_pos_str(state.pos)}{note}")

        elif token == "SET_KINEMATIC_POSITION":
            axes = [a for a in _AXES if a.upper() in params] or list(_AXES)
            for a in axes:
                state.pos[a] = _num(params.get(a.upper()) or "0") \
                    if a.upper() in params else state.pos[a]
                state.homed.add(a)
            add(f"{loc}: SET_KINEMATIC_POSITION \u2192 pos "
                f"{_pos_str(state.pos)}, marked homed "
                + " ".join(a.upper() for a in axes))

        elif token == "G92":
            touched = []
            for a in "xyze":
                if a.upper() in params:
                    state.pos[a] = _num(params[a.upper()] or "0")
                    touched.append(a.upper())
            if touched:
                add(f"{loc}: G92 {' '.join(touched)} \u2192 pos "
                    f"{_pos_str(state.pos)} (offset; homing unchanged)")

        elif token in ("G90", "G91", "M82", "M83"):
            if token == "G90":
                state.abs_xyz, state.abs_e = True, True
                add(f"{loc}: G90 \u2192 absolute XYZ+E")
            elif token == "G91":
                state.abs_xyz, state.abs_e = False, False
                add(f"{loc}: G91 \u2192 relative XYZ+E")
            elif token == "M82":
                state.abs_e = True
                add(f"{loc}: M82 \u2192 absolute extruder")
            else:
                state.abs_e = False
                add(f"{loc}: M83 \u2192 relative extruder")

        elif token in ("M104", "M109", "M140", "M190"):
            # TARGETS only (D2) — the wait itself is not modelled and no
            # current temperature is ever claimed.
            nm = "extruder" if token in ("M104", "M109") else "heater_bed"
            raw_s = params.get("S")
            if raw_s is None:
                # M109/M190 without S wait at the CURRENT target — the
                # no-S form is in the registry snippet.
                if token in ("M109", "M190") and nm in state.heaters:
                    add(f"{loc}: {token} \u2192 {nm} target already "
                        f"{_fmt_temp(state.heaters[nm])} (the wait is not "
                        "modelled)")
            else:
                v = _num(raw_s)
                note = "" if v is not None else \
                    " (target did not render \u2014 Klipper: unable to " \
                    "parse, the line fails at run time)"
                old = _before(state.heaters, nm, _fmt_temp)
                state.heaters[nm] = v
                add(f"{loc}: {raw.strip()} \u2192 {nm} target {old} "
                    f"\u2192 {_fmt_temp(v)}{note}")

        elif token == "SET_HEATER_TEMPERATURE":
            nm = (params.get("HEATER") or "").strip().lower()
            if nm:
                v = _num(params.get("TEMPERATURE"))
                note = "" if v is not None else \
                    " (value did not render \u2014 Klipper: unable to " \
                    "parse, the line fails at run time)"
                old = _before(state.heaters, nm, _fmt_temp)
                state.heaters[nm] = v
                add(f"{loc}: {raw.strip()} \u2192 {nm} target {old} "
                    f"\u2192 {_fmt_temp(v)}{note}")

        elif token == "TURN_OFF_HEATERS":
            if state.heaters:
                parts = [f"{n} target {_fmt_temp(v)} \u2192 0\u00b0C"
                         for n, v in sorted(state.heaters.items())
                         if v != 0]
                for n in state.heaters:
                    state.heaters[n] = 0.0
                add(f"{loc}: TURN_OFF_HEATERS \u2192 "
                    + (", ".join(parts) if parts else "already all 0\u00b0C"))
            else:
                add(f"{loc}: TURN_OFF_HEATERS \u2192 no heater targets "
                    "known (heaters absent from the trace, not asserted "
                    "off)")

        elif token in ("M106", "M107"):
            nm = "fan"
            if token == "M106":
                v = _num(params.get("S")) if "S" in params else 255.0
                pct = None if v is None else round(v / 255.0 * 100.0, 1)
            else:
                pct = 0.0
            old = _before(state.fans, nm, _fmt_pct)
            state.fans[nm] = pct
            add(f"{loc}: {raw.strip()} \u2192 {nm} speed {old} "
                f"\u2192 {_fmt_pct(pct)}")

        elif token == "SET_FAN_SPEED":
            nm = (params.get("FAN") or "").strip().lower()
            if nm:
                v = _num(params.get("SPEED"))
                note = ""
                if v is None:
                    note = (" (value did not render \u2014 Klipper: unable "
                            "to parse, the line fails at run time)")
                elif not 0.0 <= v <= 1.0:
                    note = " (SPEED must be a 0\u20131 ratio \u2014 " \
                           "Klipper refuses)"
                    v = None
                pct = None if v is None else round(v * 100.0, 1)
                old = _before(state.fans, nm, _fmt_pct)
                state.fans[nm] = pct
                add(f"{loc}: {raw.strip()} \u2192 {nm} speed {old} "
                    f"\u2192 {_fmt_pct(pct)}{note}")

        elif token == "SET_LED":
            nm = (params.get("LED") or "").strip().lower()
            if nm:
                comps, bad = [], False
                for c in ("RED", "GREEN", "BLUE"):
                    v = _num(params.get(c) or "0")
                    if v is None:
                        bad = True
                    comps.append(v if v is not None else 0.0)
                if "WHITE" in params and params["WHITE"].strip():
                    w = _num(params["WHITE"])
                    if w is None:
                        bad = True
                    comps.append(w if w is not None else 0.0)
                old = _before(state.leds, nm, _fmt_led)
                if bad:
                    state.leds[nm] = None
                    add(f"{loc}: {raw.strip()} \u2192 led {nm} {old} "
                        "\u2192 ? (colour did not render \u2014 Klipper: "
                        "unable to parse, the line fails at run time)")
                else:
                    state.leds[nm] = tuple(comps)
                    add(f"{loc}: {raw.strip()} \u2192 led {nm} {old} "
                        f"\u2192 {_fmt_led(comps)}")

        elif token == "SET_LED_EFFECT":
            nm = (params.get("LED") or "").strip().lower()
            eff = (params.get("EFFECT") or "").strip().lower()
            stop = (params.get("STOP") or "").strip() == "1"
            if nm and (eff or stop):
                old = _before(state.leds, nm, _fmt_led)
                if stop:
                    state.leds[nm] = "off"
                    add(f"{loc}: {raw.strip()} \u2192 led {nm} {old} "
                        "\u2192 stopped")
                else:
                    state.leds[nm] = f"effect {eff}"
                    add(f"{loc}: {raw.strip()} \u2192 led {nm} {old} "
                        f"\u2192 effect {eff} (colour cycles \u2014 not "
                        "modelled)")

        elif token == "STOP_LED_EFFECTS":
            nm = (params.get("LED") or "").strip().lower()
            stopped = []
            for n, v in list(state.leds.items()):
                if nm and n != nm:
                    continue
                if isinstance(v, str) and v.startswith("effect "):
                    stopped.append(f"led {n} {v} \u2192 stopped")
                    state.leds[n] = "off"
            add(f"{loc}: STOP_LED_EFFECTS \u2192 "
                + (", ".join(stopped) if stopped
                   else "no running effects known \u2014 static colours "
                        "are NOT turned off by this command"))

        elif token in Z_MOVERS:
            state.pos["z"] = None
            add(f"{loc}: {token} \u2014 physically moves Z: not modelled, "
                "pos z unresolved from here")

    ann, cart = annotate(state.pos, profile)
    homed = " ".join(a.upper() for a in _AXES if a in state.homed) or "\u2014"
    final = (f"Final state{' at refusal' if out.aborted else ''}: pos "
             f"{_pos_str(state.pos)} \u00b7 homed {homed}")
    if state.pos["e"] is not None:
        final += f" \u00b7 e={_fmt(state.pos['e'])}"
    if ann:
        final += f" \u00b7 {ann}"
    final += _state_suffix(state)
    if seen_cartesian or cart:
        final += (" \u00b7 (X0=left, Y0=front \u2014 conventions; verify "
                  "against your config)")
    add(final)
    return out
