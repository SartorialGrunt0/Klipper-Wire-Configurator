#!/usr/bin/env python3
"""Generate schema.json from backend config_schema definitions."""
import json
import sys
from pathlib import Path

# Add backend to path
backend_path = Path(__file__).parent.parent / "backend"
sys.path.insert(0, str(backend_path))

from parser.config_schema import SECTION_DEFS

def generate_schema():
    """Generate schema from SECTION_DEFS."""
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
    return {"schemas": schemas}

def main():
    output_path = Path(__file__).parent.parent / "reference" / "schema.json"
    schema = generate_schema()
    output_path.write_text(json.dumps(schema, indent=2))
    print(f"Generated schema.json with {len(schema['schemas'])} section types at {output_path}")

if __name__ == "__main__":
    main()
