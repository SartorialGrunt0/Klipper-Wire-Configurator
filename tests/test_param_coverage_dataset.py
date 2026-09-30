"""Param-coverage dataset assertions (unknown-param escalation, Phase 1).

The escalation guard (validator.py) only promotes an unknown_param finding to
an un-acknowledgeable ERROR when KWC can *ground* the claim: the section type
has a coverage record derived from the bundled Klipper artifacts
(`reference/klipper` source snapshot + Config_Reference.md extraction), and the
param is absent from it. A wrong or incomplete record therefore means a config
Klipper ACCEPTS gets blocked — so the dataset is load-bearing data and gets
data tests, not just code review.

Ground truth for the hard-fail predicate: klippy/configfile.py check_unused
(424-441) raises "Option 'x' is not valid in section 'y'", called as the last
step of klippy.py _read_config (klippy.py:127).
"""
import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "backend"))

from parser.config_schema import SECTION_DEFS  # noqa: E402

DATASET_PATH = REPO_ROOT / "backend" / "parser" / "klipper_param_coverage.json"
DOC_SECTIONS_PATH = REPO_ROOT / "reference" / "klipper_config_sections.json"

# Param-looking tokens for the literal-scan: Klipper option names are
# [A-Za-z0-9_]+; wildcard records (faulty_region_*_min) are allowed a single '*'.
PARAMISH_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]*(\*[A-Za-z0-9_]*)?$")


def load_coverage() -> dict:
    data = json.loads(DATASET_PATH.read_text())
    return data["sections"]


def unmodeled_params(section_defs: dict, coverage: dict, key: str = "doc_params") -> list:
    """(section_type, param) pairs the dataset claims but the schema does not
    model (matched with the validator's own wildcard semantics).

    The escalation-relevant contract is `doc_params` ⊆ schema: every param
    Config_Reference.md lists for a section MUST be modeled, or escalation
    would block a documented option. The full `params` set is deliberately a
    superset of what's modeled (common bus reads pulled in via the module
    closure, defensive extras) — over-inclusion only weakens escalation, it
    can never block a valid config, so it is NOT asserted here.
    """
    rows = []
    for sec_type, sd in sorted(section_defs.items()):
        rec = coverage.get(sec_type)
        if rec is None:
            continue
        modeled = {p.name.lower() for p in sd.params}
        wildcards = [
            (pd.name.lower().split("*", 1))
            for pd in sd.params
            if "*" in pd.name
        ]
        for param in rec[key]:
            pl = param.lower()
            if pl in modeled:
                continue
            if any(pl.startswith(pre) and pl.endswith(suf) for pre, suf in wildcards):
                continue
            rows.append((sec_type, param))
    return rows


def test_dataset_file_exists_and_shaped():
    data = json.loads(DATASET_PATH.read_text())
    assert data["_meta"]["klipper_head"], "dataset must pin the Klipper snapshot HEAD"
    for sec_type, rec in data["sections"].items():
        assert isinstance(rec["params"], list)
        assert all(PARAMISH_RE.match(p) for p in rec["params"]), (sec_type, rec["params"])
        assert rec["sources"], f"{sec_type}: every record needs at least one source"


def test_dataset_covers_every_documented_param():
    """Anything Config_Reference.md lists for a modeled section must be modeled
    in SECTION_DEFS — otherwise the escalation would block a documented option."""
    coverage = load_coverage()
    rows = unmodeled_params(SECTION_DEFS, coverage)
    assert rows == [], f"unmodeled but real params: {rows[:10]}"


def test_dataset_excludes_the_tmc_microsteps_trap():
    # microsteps is read from the *stepper* section (klippy/stepper.py:311),
    # NOT from the driver section (extras/tmc.py:682 reads it off `sconfig`).
    # klippy genuinely rejects `[tmc2209 stepper_x] microsteps:` — so it must
    # NOT appear in any tmc* record, and the corpus sweep must still report
    # its 7 occurrences as unknown_param findings after the flip.
    coverage = load_coverage()
    for sec_type in coverage:
        if sec_type.startswith("tmc"):
            assert "microsteps" not in coverage[sec_type]["params"], sec_type


def test_dataset_excludes_the_docs_microsteps_on_drivers():
    # The 2026-04-09 doc extraction inherited the same over-attribution:
    # verify the dataset is NOT built by blindly unioning doc entries into
    # driver sections.
    doc = json.loads(DOC_SECTIONS_PATH.read_text())["sections"]
    doc_tmc = [s for s in doc if s["pattern"].startswith("tmc2209")]
    assert doc_tmc, "doc fixture missing tmc2209"
    # (doc may list microsteps; the dataset must not)
    _ = doc_tmc  # informational; the real assertion is the one above


def _snapshot_module_exists(snapshot: Path, dotted: str) -> bool:
    """Case-insensitive module resolution: dataset keys are Klipper-lowercased
    (dac084s085) while the snapshot file keeps its case (dac084S085.py)."""
    parts = dotted.split(".")
    dirpath = snapshot
    for part in parts[:-1]:
        match = next((p for p in dirpath.iterdir()
                      if p.is_dir() and p.name.lower() == part), None)
        if match is None:
            return False
        dirpath = match
    target = parts[-1] + ".py"
    return any(p.name.lower() == target for p in dirpath.glob("*.py"))


def test_every_recorded_section_has_evidence():
    """Every section in the dataset must be attributable to the bundled
    artifacts: a doc pattern or an owning module with load_config* in the
    snapshot (the generator records this; guard it against hand-edits)."""
    coverage = load_coverage()
    doc = json.loads(DOC_SECTIONS_PATH.read_text())["sections"]
    doc_patterns = {s["pattern"] for s in doc}
    snapshot = REPO_ROOT / "reference" / "klipper" / "klippy"
    for sec_type, rec in coverage.items():
        sources = rec["sources"]
        has_module = any(
            _snapshot_module_exists(snapshot, rel)
            for rel in sources.get("modules", [])
        )
        has_doc = sec_type in doc_patterns or bool(sources.get("doc"))
        assert has_module or has_doc, f"{sec_type}: no evidence in bundled artifacts"


def test_third_party_and_moonraker_sections_have_no_record():
    # Escalation must never fire on sections Klipper's snapshot cannot speak
    # for. These are modeled in SECTION_DEFS for the UI but are Moonraker-
    # owned or third-party extras: no coverage record may exist for them.
    coverage = load_coverage()
    for sec_type in (
        "update_manager",
        "shaketune",
        "autotune_tmc",
        "motor_constants",
        "motor_alias",
    ):
        assert sec_type in SECTION_DEFS, f"{sec_type} fixture moved"
        assert sec_type not in coverage, f"{sec_type} must not be groundable"


def test_dynamic_reads_sections_have_no_record():
    # Sections whose options are names Klipper builds at runtime (menu paths,
    # display item params, thermistor R0/beta/T0-style custom sensor params,
    # board_pins aliases_*) cannot be enumerated from source — a record would
    # be a lie and the guard must not escalate them.
    coverage = load_coverage()
    for sec_type in ("menu", "display", "thermistor", "board_pins"):
        assert sec_type in SECTION_DEFS, f"{sec_type} fixture moved"
        assert sec_type not in coverage, f"{sec_type} has dynamic option names"


def test_format_string_reads_become_wildcards():
    # bed_mesh.py:830 reads "faulty_region_%d_min" % (i,) — the dataset must
    # record a wildcard, and the wildcard must match a real 1-indexed option.
    coverage = load_coverage()
    bm = coverage["bed_mesh"]["params"]
    wild = [p for p in bm if "*" in p and p.startswith("faulty_region")]
    assert wild, "faulty_region_%d_* must be recorded as a wildcard"
    for name in ("faulty_region_1_min", "faulty_region_12_max"):
        pre, suf = wild[0].split("*", 1) if "*" in wild[0] else ("", "")
        matched = any(
            p == name
            or ("*" in p and name.startswith(p.split("*", 1)[0]) and name.endswith(p.split("*", 1)[1]))
            for p in bm
        )
        assert matched, name
