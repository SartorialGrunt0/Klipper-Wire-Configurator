"""
reference/schema.json is a generated artifact (scripts/generate-schema.py) and
the frontend's static fallback for /schema when the live API is unreachable.
It must stay byte-for-byte equivalent to the live SECTION_DEFS, otherwise the
frontend's schema view diverges from what the validator enforces — the exact
drift that the old sanitizeValidationResult bandaid was papering over.

This test fails if someone edits config_schema.py without re-running:
    python scripts/generate-schema.py
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from parser.config_schema import SECTION_DEFS  # noqa: E402


def _live_schemas():
    """Mirror of scripts/generate-schema.py: the exact dict the generator emits."""
    schemas = {}
    for sec_type, sec_def in SECTION_DEFS.items():
        schemas[sec_type] = {
            "section_type": sec_def.section_type,
            "display_name": sec_def.display_name,
            "category": sec_def.category,
            "component_group": sec_def.component_group,
            "is_named": sec_def.is_named,
            "description": sec_def.description,
            "max_instances": sec_def.max_instances,
            "requires": sec_def.requires,
            "params": [
                {
                    "name": p.name,
                    "type": p.param_type.value,
                    "required": p.required,
                    "default": p.default,
                    "description": p.description,
                    "enum_values": p.enum_values,
                    "unit": p.unit,
                }
                for p in sec_def.params
            ],
        }
    return schemas


def test_schema_json_matches_live_section_defs():
    path = Path(__file__).resolve().parents[1] / 'reference' / 'schema.json'
    assert path.exists(), (
        "reference/schema.json is missing — run: python scripts/generate-schema.py"
    )
    committed = json.loads(path.read_text())
    live = {"schemas": _live_schemas()}

    committed_types = set(committed["schemas"])
    live_types = set(live["schemas"])

    missing_from_json = sorted(live_types - committed_types)
    extra_in_json = sorted(committed_types - live_types)

    problems = []
    if missing_from_json:
        problems.append(f"section types in live SECTION_DEFS but missing from schema.json: {missing_from_json}")
    if extra_in_json:
        problems.append(f"section types in schema.json but not in live SECTION_DEFS: {extra_in_json}")

    for st in sorted(live_types & committed_types):
        if committed["schemas"][st] != live["schemas"][st]:
            # pinpoint which field/params differ to make the fix obvious
            c, l = committed["schemas"][st], live["schemas"][st]
            diff_fields = [k for k in l if c.get(k) != l[k]]
            problems.append(f"[{st}] divergent fields: {diff_fields}")

    assert not problems, (
        "reference/schema.json is out of sync with backend/parser/config_schema.py.\n"
        "Fix: python scripts/generate-schema.py\n\n"
        + "\n".join(problems)
    )
