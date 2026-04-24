from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Iterable


REPO_ROOT = Path(__file__).resolve().parents[1]
BACKEND_ROOT = REPO_ROOT / "backend"
REFERENCE_CONFIG_ROOT = REPO_ROOT / "reference" / "config"
KLIPPER_DOCS_ROOT = REPO_ROOT / "reference" / "reference_docs" / "klipper_docs"
CONFIG_REFERENCE_PATH = KLIPPER_DOCS_ROOT / "Config_Reference.md"

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from parser.config_parser import parse_config  # noqa: E402
from parser.validator import ValidationError, validate_config  # noqa: E402


SNIPPET_MARKERS = (
    "this file is just a \"snippet\"",
    "this file is a snippet",
    "partial config",
    "include this config",
    "must be added to a config file",
    "added to your printer.cfg",
    "include this partial config",
    "overwrite the relevent sections",
    "overwrite the relevant sections",
)

UNKNOWN_SECTION_RE = re.compile(r"Unknown section type '([^']+)'")
UNKNOWN_PARAM_RE = re.compile(r"Unknown parameter '([^']+)' for section \[([^\]]+)\]\.")
MISSING_REQUIRED_RE = re.compile(r"Required parameter '([^']+)' is missing\.")
SECTION_HEADING_RE = re.compile(r"^### \[([^\]]+)\]", re.MULTILINE)


@dataclass
class ConfigContext:
    likely_partial: bool
    reasons: list[str] = field(default_factory=list)


@dataclass
class DiagnosticRecord:
    file: str
    severity: str
    section: str
    param: str
    message: str
    line_number: int
    classification: str
    doc_hits: list[str]
    partial_reasons: list[str]


def _repo_relative(path: Path) -> str:
    return path.relative_to(REPO_ROOT).as_posix()


def load_docs(docs_root: Path) -> dict[str, str]:
    docs: dict[str, str] = {}
    for path in sorted(docs_root.rglob("*.md")):
        docs[_repo_relative(path)] = path.read_text(encoding="utf-8", errors="replace")
    return docs


def load_config_reference_sections(config_reference_path: Path) -> dict[str, list[str]]:
    text = config_reference_path.read_text(encoding="utf-8", errors="replace")
    matches = list(SECTION_HEADING_RE.finditer(text))
    sections: dict[str, list[str]] = defaultdict(list)

    for index, match in enumerate(matches):
        heading = match.group(1).strip()
        section_type = heading.split(None, 1)[0]
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        sections[section_type].append(text[start:end])

    return dict(sections)


def detect_config_context(path: Path, text: str) -> ConfigContext:
    header = "\n".join(text.splitlines()[:80]).lower()
    reasons: list[str] = []

    for marker in SNIPPET_MARKERS:
        if marker in header:
            reasons.append(f"header mentions '{marker}'")

    if path.name.startswith("sample-") and "[printer]" not in text.lower():
        reasons.append("sample file without [printer] section")

    if path.parts[-2] in {"Accelerometer", "Expander", "Probe", "Toolhead"} and "[printer]" not in text.lower():
        reasons.append(f"{path.parts[-2]} reference file without [printer] section")

    return ConfigContext(likely_partial=bool(reasons), reasons=reasons)


def find_section_doc_hits(section_type: str, docs: dict[str, str], config_ref_sections: dict[str, list[str]]) -> list[str]:
    hits: list[str] = []
    if section_type in config_ref_sections:
        hits.append(_repo_relative(CONFIG_REFERENCE_PATH))

    pattern = re.compile(rf"\[{re.escape(section_type)}(?:\s|\])", re.IGNORECASE)
    for rel_path, text in docs.items():
        if rel_path in hits:
            continue
        if pattern.search(text):
            hits.append(rel_path)
    return hits[:5]


def find_param_doc_hits(section_type: str, param: str, docs: dict[str, str], config_ref_sections: dict[str, list[str]]) -> list[str]:
    hits: list[str] = []
    param_pattern = re.compile(rf"^\s*#?{re.escape(param)}\s*:", re.MULTILINE)

    for block in config_ref_sections.get(section_type, []):
        if param_pattern.search(block):
            hits.append(_repo_relative(CONFIG_REFERENCE_PATH))
            break

    return hits


def classify_diagnostic(
    error: ValidationError,
    context: ConfigContext,
    docs: dict[str, str],
    config_ref_sections: dict[str, list[str]],
) -> tuple[str, list[str]]:
    section_match = UNKNOWN_SECTION_RE.search(error.message)
    if section_match:
        section_type = section_match.group(1)
        doc_hits = find_section_doc_hits(section_type, docs, config_ref_sections)
        if doc_hits:
            return "documented_unknown_section", doc_hits
        return "needs_review", []

    param_match = UNKNOWN_PARAM_RE.search(error.message)
    if param_match:
        param_name, section_type = param_match.groups()
        doc_hits = find_param_doc_hits(section_type, param_name, docs, config_ref_sections)
        if doc_hits:
            return "documented_unknown_param", doc_hits
        return "needs_review", []

    if context.likely_partial:
        if MISSING_REQUIRED_RE.search(error.message):
            return "likely_partial_example", []
        if error.message.startswith("MCU requires either"):
            return "likely_partial_example", []
        if error.message.startswith("Section [") and "requires [" in error.message:
            return "likely_partial_example", []

    return "needs_review", []


def summarize_top(records: Iterable[DiagnosticRecord], *, limit: int = 20) -> list[dict[str, object]]:
    counts: Counter[tuple[str, str]] = Counter()
    examples: dict[tuple[str, str], list[str]] = defaultdict(list)
    for record in records:
        key = (record.classification, f"{record.severity}|{record.message}")
        counts[key] += 1
        if len(examples[key]) < 5:
            examples[key].append(record.file)

    return [
        {
            "classification": key[0],
            "diagnostic": key[1],
            "count": count,
            "examples": examples[key],
        }
        for key, count in counts.most_common(limit)
    ]


def build_report(config_root: Path, docs_root: Path) -> dict[str, object]:
    docs = load_docs(docs_root)
    config_ref_sections = load_config_reference_sections(CONFIG_REFERENCE_PATH)
    records: list[DiagnosticRecord] = []
    severity_counts: Counter[str] = Counter()
    classification_counts: Counter[str] = Counter()
    files_scanned = 0
    files_with_diagnostics = 0

    for path in sorted(config_root.rglob("*.cfg")):
        files_scanned += 1
        text = path.read_text(encoding="utf-8", errors="replace")
        context = detect_config_context(path, text)
        result = validate_config(parse_config(text, path.name))
        if result.errors:
            files_with_diagnostics += 1

        for error in result.errors:
            classification, doc_hits = classify_diagnostic(error, context, docs, config_ref_sections)
            severity_counts[error.severity] += 1
            classification_counts[classification] += 1
            records.append(DiagnosticRecord(
                file=_repo_relative(path),
                severity=error.severity,
                section=error.section,
                param=error.param,
                message=error.message,
                line_number=error.line_number,
                classification=classification,
                doc_hits=doc_hits,
                partial_reasons=context.reasons,
            ))

    review_records = [record for record in records if record.classification == "needs_review"]
    documented_records = [record for record in records if record.classification.startswith("documented_")]
    partial_records = [record for record in records if record.classification == "likely_partial_example"]

    return {
        "summary": {
            "files_scanned": files_scanned,
            "files_with_diagnostics": files_with_diagnostics,
            "diagnostic_count": len(records),
            "severity_counts": dict(severity_counts),
            "classification_counts": dict(classification_counts),
        },
        "top_diagnostics": summarize_top(records),
        "review_candidates": [asdict(record) for record in review_records[:200]],
        "documented_unknowns": [asdict(record) for record in documented_records[:200]],
        "likely_partial_examples": [asdict(record) for record in partial_records[:200]],
    }


def print_report(report: dict[str, object], *, max_items: int) -> None:
    summary = report["summary"]
    print(
        f"Scanned {summary['files_scanned']} reference configs; "
        f"{summary['files_with_diagnostics']} files reported {summary['diagnostic_count']} diagnostics."
    )
    print(
        "Severity counts: "
        + ", ".join(f"{name}={count}" for name, count in summary["severity_counts"].items())
    )
    print(
        "Classification counts: "
        + ", ".join(f"{name}={count}" for name, count in summary["classification_counts"].items())
    )

    print("\nTop diagnostics:")
    for item in report["top_diagnostics"][:max_items]:
        print(f"- [{item['classification']}] {item['diagnostic']} ({item['count']})")
        print(f"  examples: {', '.join(item['examples'])}")

    print("\nReview candidates:")
    review_candidates = report["review_candidates"][:max_items]
    if not review_candidates:
        print("- none")
    for record in review_candidates:
        print(f"- {record['file']}:{record['line_number']} [{record['severity']}] {record['message']}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Audit reference Klipper configs against the built-in validator and bundled Klipper docs.")
    parser.add_argument("--config-root", type=Path, default=REFERENCE_CONFIG_ROOT, help="Directory containing reference .cfg files")
    parser.add_argument("--docs-root", type=Path, default=KLIPPER_DOCS_ROOT, help="Directory containing bundled Klipper docs")
    parser.add_argument("--json-out", type=Path, help="Optional path to write the full JSON report")
    parser.add_argument("--max-items", type=int, default=15, help="Number of summary items to print")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report = build_report(args.config_root, args.docs_root)
    print_report(report, max_items=args.max_items)
    if args.json_out is not None:
        args.json_out.parent.mkdir(parents=True, exist_ok=True)
        args.json_out.write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(f"\nWrote JSON report to {_repo_relative(args.json_out) if args.json_out.is_relative_to(REPO_ROOT) else args.json_out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())