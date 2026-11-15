"""Guard-splice correctness (review L5 + L6, plan G2).

The statically-decidable param-presence grammars (`params.X is defined`,
`params['X'] is defined`, `'X' in params`) must collapse to literals
BEFORE arm expansion — using PARAMS ONLY. Two confirmed defects:

L5: the bracket alternative of _PARAM_IS_DEFINED_RE lacked the closing
    `\\]`, so `params['X'] is defined` never matched; both arms expanded
    and the arm Klipper would not run rendered `{params.X}` empty -> a
    fabricated macro_param_renders_empty ERROR.

L6: the macro's `variable_*` names were unioned into the presence set,
    so `'X' in params` / `params.X is defined` forced TRUE whenever a
    variable named x existed — Klipper's params dict never contains
    variables. Fabricated arm + fabricated error, end-to-end through
    validate_config.

Bare-name `x is defined` stays native (variables ARE top-level template
names in Klipper's context) — pinned here too so a future 'fix' cannot
break the working side while repairing the broken side.
"""
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1] / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from parser.config_parser import parse_config  # noqa: E402
from parser.macro_render import simulate_macro  # noqa: E402
from parser.validator import validate_config  # noqa: E402


def _texts(result):
    return [r.text for r in result.rendered]


# ── L5 bracket form splices, both directions ───────────────────────────────

def test_bracket_guard_true_arm_when_param_present():
    body = ("{% if params['X'] is defined %}M106 S{params.X}"
            "{% else %}M106 S255{% endif %}")
    result = simulate_macro(body, {"x": "200"})
    assert _texts(result) == ["M106 S200"]
    assert result.findings == []


def test_bracket_guard_false_arm_when_param_absent():
    body = ("{% if params['X'] is defined %}M106 S{params.X}"
            "{% else %}M106 S255{% endif %}")
    result = simulate_macro(body, {})
    assert _texts(result) == ["M106 S255"]
    assert result.findings == []


def test_bracket_guard_double_quotes_is_not_defined():
    body = ('{% if params["Level"] is not defined %}M117 missing'
            '{% else %}M117 have{% endif %}')
    assert _texts(simulate_macro(body, {})) == ["M117 missing"]
    # Case-SENSITIVE, like Klipper (round-2 D2): the params dict holds
    # uppercase keys, so a mixed-case lookup is ALWAYS undefined — even
    # when the value was passed.
    assert _texts(simulate_macro(body, {"level": "2"})) == ["M117 missing"]
    assert _texts(simulate_macro(body, {"Level": "2"})) == ["M117 missing"]
    exact = ('{% if params["LEVEL"] is not defined %}M117 missing'
             '{% else %}M117 have{% endif %}')
    assert _texts(simulate_macro(exact, {"level": "2"})) == ["M117 have"]


def test_lowercase_dot_guard_is_decidably_absent():
    # Klipper's params dict is uppercase-keyed and Jinja lookup is
    # case-sensitive: params.x can NEVER be defined, so the guard is
    # decidable in every invocation — the else arm, never a fabricated
    # render of the true arm (round-2 D2).
    body = ("{% if params.x is defined %}M106 S{params.x}"
            "{% else %}M106 S200{% endif %}")
    r = simulate_macro(body, {"X": "100"})
    assert _texts(r) == ["M106 S200"]
    assert not [f for f in r.findings if f.severity == "error"], \
        [f.message for f in r.findings]
    # no invocation declared either — case mismatch is not a
    # caller-passes-it question
    r2 = simulate_macro(body, declared_defaults={"x": "100"})
    assert _texts(r2) == ["M106 S200"]


def test_case_sensitive_membership_and_upper_idiom():
    lower = "{% if 'x' in params %}M106 S100{% else %}M106 S0{% endif %}"
    assert _texts(simulate_macro(lower, {"X": "100"})) == ["M106 S0"]
    upper = ("{% if 'x' in params|upper %}M106 S100"
             "{% else %}M106 S0{% endif %}")
    assert _texts(simulate_macro(upper, {"X": "100"})) == ["M106 S100"]


# ── L6 variables must NOT satisfy params-presence ──────────────────────────

def test_variable_does_not_satisfy_membership_guard():
    body = "{% if 'X' in params %}M106 S{params.X}{% endif %}"
    result = simulate_macro(body, {}, variables={"x": "5"})
    assert _texts(result) == []          # arm collapses away, like Klipper
    assert result.findings == []         # no fabricated renders_empty


def test_variable_does_not_satisfy_is_defined_guard():
    body = "{% if params.X is defined %}M106 S{params.X}{% endif %}"
    result = simulate_macro(body, {}, variables={"x": "5"})
    assert _texts(result) == []
    assert result.findings == []


def test_guard_still_true_for_real_param_alongside_variable():
    body = "{% if 'X' in params %}M106 S{params.X}{% endif %}"
    result = simulate_macro(body, {"x": "20"}, variables={"y": "5"})
    assert _texts(result) == ["M106 S20"]
    assert result.findings == []


def test_variable_guard_bare_name_still_native_parity():
    # variables ARE context entries in Klipper: bare `x is defined`
    # must stay TRUE for a variable (repairing L6 must not break this).
    body = "{% if x is defined %}M117 yes{% else %}M117 no{% endif %}"
    assert _texts(simulate_macro(body, {}, variables={"x": "5"})) == \
        ["M117 yes"]


def test_validate_config_no_fabricated_error_from_variable():
    cfg = (
        "[gcode_macro TEST]\n"
        "variable_x: 5\n"
        "gcode:\n"
        "    {% if 'X' in params %}\n"
        "    M106 S{params.X}\n"
        "    {% endif %}\n"
    )
    result = validate_config(parse_config(cfg))
    # 3.1 truth: the guard over x is NOT resolved from the variable
    # (both arms explored); the X-arm read is param-dependent INFO —
    # never an ERROR (the L6 fabrication this pins out).
    assert not [e for e in result.errors
                if e.severity == "error"
                and e.code in ("macro_param_renders_empty",
                               "macro_param_undefined")], \
        "a variable must not fabricate a params error through the full pass"
