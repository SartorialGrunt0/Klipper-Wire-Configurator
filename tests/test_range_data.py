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


def _resolve_ref_default(sec_def, name):
    """Numeric schema default of a referenced param (mirrors the validator's
    _resolve fallback: absent config option -> referenced default)."""
    if sec_def is None:
        return None
    rd = next((p for p in sec_def.params if p.name == name), None)
    if rd is None or rd.default in (None, ""):
        return None
    try:
        return float(rd.default)
    except ValueError:
        return None


def _bounded_params():
    """Every (sec_type, ParamDef) carrying any bound kind (constant or
    relational ref), deduped by (section_type, param name)."""
    seen = set()
    out = []
    for sec_type in get_all_section_types():
        sec_def = get_section_def(sec_type)
        if sec_def is None:
            continue
        for p in sec_def.params:
            if (p.min_val is None and p.max_val is None
                    and p.strict_above is None and p.strict_below is None
                    and p.rel_above is None and p.rel_below is None
                    and p.rel_between is None
                    and p.rel_min is None and p.rel_max is None):
                continue
            key = (sec_type, p.name)
            if key in seen:
                continue
            seen.add(key)
            out.append((sec_type, p))
    return out


BOUNDED = _bounded_params()
SEC_DEF_BY_TYPE = {s: get_section_def(s) for s, _p in BOUNDED}


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
            or 'at or above' in e.message or 'at or below' in e.message
            or 'must be between' in e.message
        )
    ]


def _ref_defaults(sec_type, p):
    """Resolve each relational ref to its schema-default number.
    Returns {kind: value(s)}; kinds whose ref has no numeric default are
    omitted — the validator skips those comparisons too."""
    sd = SEC_DEF_BY_TYPE.get(sec_type)
    out = {}
    if p.rel_above is not None:
        d = _resolve_ref_default(sd, p.rel_above)
        if d is not None:
            out['rel_above'] = d
    if p.rel_below is not None:
        d = _resolve_ref_default(sd, p.rel_below)
        if d is not None:
            out['rel_below'] = d
    if p.rel_min is not None:
        d = _resolve_ref_default(sd, p.rel_min)
        if d is not None:
            out['rel_min'] = d
    if p.rel_max is not None:
        d = _resolve_ref_default(sd, p.rel_max)
        if d is not None:
            out['rel_max'] = d
    if p.rel_between is not None:
        lo = _resolve_ref_default(sd, p.rel_between[0])
        hi = _resolve_ref_default(sd, p.rel_between[1])
        if lo is not None and hi is not None and lo <= hi:
            out['rel_between'] = (lo, hi)
    return out


def _bad_values(sec_type, p):
    """Values that must error for this param's bound kinds (constant and
    relational — refs use the referenced param's schema default)."""
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
    refs = _ref_defaults(sec_type, p)
    if 'rel_above' in refs:
        vals.append(refs['rel_above'])       # strict: equal fails
        vals.append(refs['rel_above'] - _step(p))
    if 'rel_below' in refs:
        vals.append(refs['rel_below'])
        vals.append(refs['rel_below'] + _step(p))
    if 'rel_min' in refs:
        vals.append(refs['rel_min'] - _step(p))
    if 'rel_max' in refs:
        vals.append(refs['rel_max'] + _step(p))
    if 'rel_between' in refs:
        lo, hi = refs['rel_between']
        vals.append(lo - _step(p))
        vals.append(hi + _step(p))
    return vals


def _satisfies_all(sec_type, p, v):
    """True if v respects EVERY bound kind on p (params can carry two, e.g.
    servo widths: strict_above=0 AND strict_below=0.020)."""
    if p.min_val is not None and v < p.min_val:
        return False
    if p.max_val is not None and v > p.max_val:
        return False
    if p.strict_above is not None and v <= p.strict_above:
        return False
    if p.strict_below is not None and v >= p.strict_below:
        return False
    for kind, d in _ref_defaults(sec_type, p).items():
        if kind == 'rel_above' and v <= d:
            return False
        if kind == 'rel_below' and v >= d:
            return False
        if kind == 'rel_min' and v < d:
            return False
        if kind == 'rel_max' and v > d:
            return False
        if kind == 'rel_between' and (v < d[0] or v > d[1]):
            return False
    return True


def _good_values(sec_type, p):
    """Values that must pass for this param's bound kinds. Single-sided
    candidates are filtered so they satisfy ALL of the param's bounds —
    otherwise a multi-bound param (e.g. servo pulse widths with
    strict_above=0 and strict_below=0.020) generates 'good' values that
    violate its other bound."""
    vals = []
    if p.min_val is not None:
        vals.append(p.min_val)               # inclusive: boundary passes
    if p.max_val is not None:
        vals.append(p.max_val)
    if p.strict_above is not None:
        vals.append(p.strict_above + _step(p))
    if p.strict_below is not None:
        vals.append(p.strict_below - _step(p))
    refs = _ref_defaults(sec_type, p)
    if 'rel_above' in refs:
        vals.append(refs['rel_above'] + _step(p))
    if 'rel_below' in refs:
        vals.append(refs['rel_below'] - _step(p))
    if 'rel_min' in refs:
        vals.append(refs['rel_min'])         # inclusive: boundary passes
    if 'rel_max' in refs:
        vals.append(refs['rel_max'])
    if 'rel_between' in refs:
        lo, hi = refs['rel_between']
        vals.append(lo)                      # inclusive boundaries
        vals.append(hi)
    return [v for v in vals if _satisfies_all(sec_type, p, v)]


@pytest.mark.parametrize(
    'sec_type,param,value',
    [(s, p, v) for s, p in BOUNDED for v in _bad_values(s, p)],
    ids=[f'{s}.{p.name}@{v}' for s, p in BOUNDED for v in _bad_values(s, p)],
)
def test_out_of_bounds_is_error(sec_type, param, value):
    bad = _range_errors(sec_type, param.name, value, param.param_type.name == 'INT')
    assert bad, (
        f"[{sec_type}] {param.name} (min={param.min_val}, max={param.max_val}, "
        f"sa={param.strict_above}, sb={param.strict_below}) did not reject {value}"
    )


@pytest.mark.parametrize(
    'sec_type,param,value',
    [(s, p, v) for s, p in BOUNDED for v in _good_values(s, p)],
    ids=[f'{s}.{p.name}@{v}' for s, p in BOUNDED for v in _good_values(s, p)],
)
def test_in_bounds_is_clean(sec_type, param, value):
    bad = _range_errors(sec_type, param.name, value, param.param_type.name == 'INT')
    assert not bad, (
        f"[{sec_type}] {param.name} (min={param.min_val}, max={param.max_val}, "
        f"sa={param.strict_above}, sb={param.strict_below}) must accept {value}"
    )
