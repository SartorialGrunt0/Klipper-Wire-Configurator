"""Test the full diff roundtrip with Trident backup printer.cfg"""
import sys, json
sys.path.insert(0, 'backend')
from parser.config_parser import parse_config
from parser.config_writer import smart_export, _sections_match
from models.config_models import ConfigUpdate, SectionUpdate, ParamUpdate
from api.routes import _config_update_to_config_file
from pathlib import Path

# Read Trident printer.cfg with preserved CRLF (as browser upload would)
raw_bytes = Path('reference/Trident_backup/printer_data/config/printer.cfg').read_bytes()
text = raw_bytes.decode('utf-8')
crlf_count = raw_bytes.count(b'\r\n')
print(f"Line endings in file: CRLF={crlf_count}")

# Step 1: Parse (simulating import endpoint — this is what the backend does)
config = parse_config(text, 'printer.cfg')
data = json.loads(json.dumps(config.to_dict()))

# originalTexts in the frontend comes from config.raw_text (after parse_config normalization)
original_text = data['raw_text']
print(f"original_text (from raw_text): {len(original_text)} chars, has \\r: {chr(13) in original_text}")
print(f"Sections: {len(data['sections'])}")

# Step 1: Parse (simulating import endpoint)
config = parse_config(text, 'printer.cfg')
data = json.loads(json.dumps(config.to_dict()))
print(f"Sections: {len(data['sections'])}")

# Step 2: Rebuild via API model (simulating export from frontend)
# Simulate changing mcu baud to 115200
def rebuild_with_change(data, change_section=None, change_key=None, change_value=None):
    sections = []
    for s in data['sections']:
        params = []
        for p in s['params']:
            value = p['value']
            if (change_section and s['full_header'] == change_section
                    and p['key'] == change_key and not p['is_commented_out']):
                value = change_value
            params.append(ParamUpdate(
                key=p['key'],
                value=value,
                is_commented_out=p['is_commented_out'],
                comment=p['comment'],
                separator=p.get('separator', ':'),
            ))
        sections.append(SectionUpdate(
            full_header=s['full_header'],
            section_type=s['section_type'],
            section_name=s['section_name'],
            params=params,
            header_comments=s.get('header_comments', []),
            trailing_comments=s.get('trailing_comments', []),
            is_commented_out=s.get('is_commented_out', False),
        ))

    cu = ConfigUpdate(
        filename=data['filename'],
        sections=sections,
        includes=data.get('includes', []),
        header_comments=data.get('header_comments', []),
        raw_text=data.get('raw_text', ''),
    )

    rebuilt = _config_update_to_config_file(cu)
    rebuilt.raw_text = cu.raw_text
    return rebuilt

# Test 1: No changes
print("\n=== Test 1: No changes ===")
rebuilt = rebuild_with_change(data)
exported = smart_export(rebuilt)
print(f"Exported: {len(exported)} chars")
print(f"Exact match vs originalTexts: {original_text == exported}")

# Test 2: Change baud to 115200
print("\n=== Test 2: Change mcu baud to 115200 ===")
rebuilt = rebuild_with_change(data, 'mcu', 'baud', '115200')
exported = smart_export(rebuilt)
print(f"Exported: {len(exported)} chars")

# Compare against originalTexts (the normalized raw_text from import)
orig_lines = original_text.splitlines()
exp_lines = exported.splitlines()
diffs = 0
for i, (o, e) in enumerate(zip(orig_lines, exp_lines)):
    if o != e:
        diffs += 1
        if diffs <= 10:
            print(f"  Line {i+1}: {repr(o[:80])}")
            print(f"       => {repr(e[:80])}")
diffs += abs(len(orig_lines) - len(exp_lines))
print(f"Total diff lines: {diffs}")

# Also compare using split by \n (as diff library would)
orig_split = original_text.split('\n')
exp_split = exported.split('\n')
ndiff = sum(1 for a, b in zip(orig_split, exp_split) if a != b)
ndiff += abs(len(orig_split) - len(exp_split))
print(f"Diffs when split by newline: {ndiff}")
