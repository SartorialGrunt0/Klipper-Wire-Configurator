"""
Phase 6 (F17 data): round-trip guarantee that every schema param carrying
min_val/max_val/strict_above/strict_below actually enforces it.

For each bound-bearing ParamDef this test builds a minimal one-section config
and asserts:
  * inclusive min_val/max_val (Klipper minval=/maxval=): an out-of-bounds
    value errors; the boundary value passes (inclusive).
  * strict strict_above/strict_below (Klipper above=/below=): the boundary
    value itself ERRORS (strict); a value one step beyond it passes.

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
    """Every (sec_type, ParamDef) carrying any bound kind, deduped by
    (section_type, param name) across the whole schema."""
    seen = set()
    out = []
    for sec_type in get_all_section_types():
        sec_def = get_section_def(sec_type)
        if sec_def is None:
            continue
        for p in sec_def.params:
            if (p.min_val is None and p.max_val is None
                    and p.strict_above is None and p.strict_below is None):
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


def _step(p):
    return 1 if p.param_type.name == 'INT' else 0.5


def _range_errors(sec_type, param_name, value, is_int):
    cfg = f"[{sec_type}]\n{param_name}: {_fmt(value, is_int)}\n"
    errors = validate_config(parse_config(cfg, f'{sec_type}.cfg')).errors
    return [
        e for e in errors
        if e.param == param_name and (
            'minimum of' in e.message or 'maximum of' in e.message
            or 'must be above' in e.message or 'must be below' in e.message
        )
    ]


def _bad_values(p):
    """Values that must error for this param's bound kinds."""
    vals = []
    if p.min_val is not None:
        vals.append(p.min_val - _step(p))
    if p.max_val is not None:
        vals.append(p.max_val + _step(p))
    if p.strict_above is not None:
        vals.append(p.strict_above)          # strict: the bound itself fails
        vals.append(p.strict_above - _step(p))
    if p.strict_below is not None:
        vals.append(p.strict_below)          # strict: the bound itself fails
        vals.append(p.strict_below + _step(p))
    return vals


def _good_values(p):
    """Values that must pass for this param's bound kinds."""
    vals = []
    if p.min_val is not None:
        vals.append(p.min_val)               # inclusive: boundary passes
    if p.max_val is not None:
        vals.append(p.max_val)
    if p.strict_above is not None:
        vals.append(p.strict_above + _step(p))
    if p.strict_below is not None:
        vals.append(p.strict_below - _step(p))
    return vals


@pytest.mark.parametrize(
    'sec_type,param,value',
    [(s, p, v) for s, p in BOUNDED for v in _bad_values(p)],
    ids=[f'{s}.{p.name}@{v}' for s, p in BOUNDED for v in _bad_values(p)],
)
def test_out_of_bounds_is_error(sec_type, param, value):
    bad = _range_errors(sec_type, param.name, value, param.param_type.name == 'INT')
    assert bad, (
        f"[{sec_type}] {param.name} (min={param.min_val}, max={param.max_val}, "
        f"sa={param.strict_above}, sb={param.strict_below}) did not reject {value}"
    )


@pytest.mark.parametrize(
    'sec_type,param,value',
    [(s, p, v) for s, p in BOUNDED for v in _good_values(p)],
    ids=[f'{s}.{p.name}@{v}' for s, p in BOUNDED for v in _good_values(p)],
)
def test_in_bounds_is_clean(sec_type, param, value):
    bad = _range_errors(sec_type, param.name, value, param.param_type.name == 'INT')
    assert not bad, (
        f"[{sec_type}] {param.name} (min={param.min_val}, max={param.max_val}, "
        f"sa={param.strict_above}, sb={param.strict_below}) must accept {value}"
    )
