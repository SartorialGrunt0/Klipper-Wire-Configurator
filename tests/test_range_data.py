"""
Phase 6 (F17 data): round-trip guarantee that every schema param carrying
min_val/max_val actually enforces it.

For each bound-bearing ParamDef this test builds a minimal one-section config
and asserts:
  * an out-of-bounds value produces the range error, and
  * the boundary value (inclusive, matching Klipper minval=/maxval=) does not.

The data was transcribed from the Klipper source (~/klipper) — see plan
.hermes/plans/2026-08-24_014451-kwc-error-warning-flagging.md. If a param's
bound ever changes upstream, the getfloat/getint call site is the authority
and this test catches transcription drift in either direction.
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from parser.config_parser import parse_config  # noqa: E402
from parser.config_schema import (  # noqa: E402
    get_all_section_types,
    get_section_def,
)
from parser.validator import validate_config  # noqa: E402


def _bounded_params():
    seen = set()
    out = []
    for sec_type in get_all_section_types():
        sec_def = get_section_def(sec_type)
        if sec_def is None:
            continue
        for p in sec_def.params:
            if p.min_val is None and p.max_val is None:
                continue
            key = (sec_type, p.name)
            if key in seen:
                continue
            seen.add(key)
            out.append((sec_type, p))
    return out


BOUNDED = _bounded_params()


def test_schema_carries_bounds():
    # The data itself: Phase 6 populated real bounds, so an empty set here
    # means the transcription was lost (e.g. reverted) — fail loudly.
    assert len(BOUNDED) >= 100, (
        f"expected >=100 bound-bearing params, found {len(BOUNDED)}"
    )


def _fmt(value, is_int):
    if is_int or float(value).is_integer():
        return str(int(value))
    return repr(value)


def _range_errors(sec_type, param_name, value, is_int):
    cfg = f"[{sec_type}]\n{param_name}: {_fmt(value, is_int)}\n"
    errors = validate_config(parse_config(cfg, f'{sec_type}.cfg')).errors
    return [
        e for e in errors
        if e.param == param_name and ('minimum of' in e.message or 'maximum of' in e.message)
    ]


def _out_of_bounds_value(p):
    """A value guaranteed outside [min_val, max_val] for p's type."""
    step = 1 if p.param_type.name == 'INT' else 0.5
    if p.max_val is not None:
        return p.max_val + step
    return p.min_val - step


def _in_bounds_value(p):
    # Boundary values are inclusive (Klipper minval/maxval are inclusive).
    if p.min_val is not None:
        return p.min_val
    return p.max_val


@pytest.mark.parametrize(
    'sec_type,param',
    BOUNDED,
    ids=[f'{s}.{p.name}' for s, p in BOUNDED],
)
def test_out_of_bounds_is_error(sec_type, param):
    bad = _range_errors(sec_type, param.name, _out_of_bounds_value(param),
                        param.param_type.name == 'INT')
    assert bad, (
        f"[{sec_type}] {param.name} (min={param.min_val}, max={param.max_val}) "
        f"did not reject {_out_of_bounds_value(param)}"
    )


@pytest.mark.parametrize(
    'sec_type,param',
    BOUNDED,
    ids=[f'{s}.{p.name}' for s, p in BOUNDED],
)
def test_in_bounds_is_clean(sec_type, param):
    bad = _range_errors(sec_type, param.name, _in_bounds_value(param),
                        param.param_type.name == 'INT')
    assert not bad, (
        f"[{sec_type}] {param.name} (min={param.min_val}, max={param.max_val}) "
        f"must accept the boundary value {_in_bounds_value(param)}"
    )
