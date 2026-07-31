from __future__ import annotations

import argparse
import json
import platform
import re
import subprocess
import sys
import time
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT_ROOT = REPO_ROOT / "reports" / "functional-test-results"


@dataclass(frozen=True)
class SuiteDefinition:
    suite_id: str
    title: str
    kind: str
    requirement_ids: tuple[str, ...]
    description: str
    selectors: tuple[str, ...] = ()
    script_path: str = ""


@dataclass
class SuiteResult:
    suite_id: str
    title: str
    kind: str
    status: str
    requirement_ids: list[str]
    duration_seconds: float
    return_code: int | None
    command: list[str]
    log_file: str
    summary: str


AUTOMATED_SUITES = (
    SuiteDefinition(
        suite_id="FTA-001",
        title="Validation and save-config regression suite",
        kind="pytest",
        requirement_ids=(
            "REQ-CONF-03",
            "REQ-EDIT-05",
            "REQ-VAL-01",
            "REQ-VAL-02",
            "REQ-VAL-03",
            "REQ-OUT-01",
        ),
        description="Strict pass/fail validation of parser, validator, warning acknowledgement, and save-config behavior.",
        selectors=(
            "tests/test_delta_validation.py",
            "tests/test_warning_acknowledgments.py",
            "tests/test_save_config_handling.py",
        ),
    ),
    SuiteDefinition(
        suite_id="FTA-002",
        title="Firmware and flash-target API regression suite",
        kind="pytest",
        requirement_ids=(
            "REQ-FW-01",
            "REQ-FW-02",
            "REQ-FW-03",
            "REQ-FW-04",
            "REQ-NATIVE-06",
        ),
        description="Strict pass/fail validation of native firmware routes, flash-target services, flash profiles, and Klipper log excerpt handling.",
        selectors=(
            "tests/test_native_firmware_routes.py",
            "tests/test_flash_target_routes.py",
            "tests/test_flash_target_service.py",
            "tests/test_klipper_firmware_service.py",
            "tests/test_flash_profile_service.py",
            "tests/test_native_klipper_service.py",
        ),
    ),
    SuiteDefinition(
        suite_id="FTA-003",
        title="AI chat backend regression suite",
        kind="pytest",
        requirement_ids=(
            "REQ-AI-02",
            "REQ-AI-03",
            "REQ-AI-04",
        ),
        description="Strict pass/fail validation of provider key gating, docs-grounded prompt preparation, provider payload building, response extraction, auto-search fallback, and the native tool-call loop.",
        selectors=(
            "tests/test_ai_chat_routes.py",
        ),
    ),
    SuiteDefinition(
        suite_id="FTA-004",
        title="MCP tool-calling helper suite",
        kind="pytest",
        requirement_ids=(
            "REQ-AI-04",
            "REQ-AI-06",
        ),
        description="Strict pass/fail validation of text-based and native tool-call extraction, execution, and follow-up message building.",
        selectors=(
            "tests/test_mcp_tool_calling.py",
        ),
    ),
)


INFORMATIONAL_SUITES = (
    SuiteDefinition(
        suite_id="FTI-001",
        title="Reference corpus roundtrip diagnostic",
        kind="script",
        requirement_ids=(
            "REQ-CONF-01",
            "REQ-CONF-02",
            "REQ-CONF-03",
            "REQ-OUT-01",
        ),
        description="Runs the existing roundtrip diagnostic across bundled reference configs.",
        script_path="tests/test_roundtrip.py",
    ),
    SuiteDefinition(
        suite_id="FTI-002",
        title="Diff roundtrip diagnostic",
        kind="script",
        requirement_ids=(
            "REQ-CONF-03",
            "REQ-EDIT-04",
            "REQ-OUT-01",
            "REQ-OUT-02",
        ),
        description="Runs the existing Trident diff roundtrip script and captures its diff summary.",
        script_path="tests/test_diff_roundtrip.py",
    ),
)


MANUAL_CASES = (
    {
        "test_id": "FTM-001",
        "title": "Generate a new configuration",
        "requirement_ids": ["REQ-CONF-04", "REQ-CONF-05", "REQ-CONF-06", "REQ-GRAPH-01"],
        "status": "manual_required",
    },
    {
        "test_id": "FTM-002",
        "title": "Import and inspect a project through the UI",
        "requirement_ids": ["REQ-CONF-01", "REQ-CONF-02", "REQ-CONF-07", "REQ-GRAPH-06"],
        "status": "manual_required",
    },
    {
        "test_id": "FTM-003",
        "title": "Edit from the graph and settings panel",
        "requirement_ids": ["REQ-GRAPH-02", "REQ-GRAPH-03", "REQ-GRAPH-04", "REQ-GRAPH-05", "REQ-EDIT-01"],
        "status": "manual_required",
    },
    {
        "test_id": "FTM-004",
        "title": "Edit in text view and sync back to the graph",
        "requirement_ids": ["REQ-EDIT-02", "REQ-EDIT-03", "REQ-EDIT-04", "REQ-EDIT-05"],
        "status": "manual_required",
    },
    {
        "test_id": "FTM-005",
        "title": "Review diffs and export artifacts",
        "requirement_ids": ["REQ-OUT-01", "REQ-OUT-02"],
        "status": "manual_required",
    },
    {
        "test_id": "FTM-006",
        "title": "Open, apply, and revert directly on a native SBC",
        "requirement_ids": ["REQ-NATIVE-01", "REQ-NATIVE-02", "REQ-NATIVE-03", "REQ-NATIVE-04", "REQ-NATIVE-05", "REQ-NATIVE-06", "REQ-NATIVE-07"],
        "status": "manual_required",
    },
    {
        "test_id": "FTM-007",
        "title": "Firmware build and flash workflow",
        "requirement_ids": ["REQ-FW-01", "REQ-FW-02", "REQ-FW-03", "REQ-FW-04"],
        "status": "manual_required",
    },
    {
        "test_id": "FTM-008",
        "title": "Macro designer workflow",
        "requirement_ids": ["REQ-MACRO-01", "REQ-MACRO-02", "REQ-MACRO-03"],
        "status": "manual_required",
    },
    {
        "test_id": "FTM-009",
        "title": "AI chat grounding and draft-apply workflow",
        "requirement_ids": ["REQ-AI-01", "REQ-AI-05"],
        "status": "manual_required",
    },
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run functional regression suites and write a timestamped report.")
    parser.add_argument(
        "--output-root",
        default=str(DEFAULT_OUTPUT_ROOT),
        help="Directory where timestamped result folders are created.",
    )
    parser.add_argument(
        "--suite",
        action="append",
        default=[],
        help="Run only the specified suite ID. May be passed multiple times.",
    )
    parser.add_argument(
        "--skip-informational",
        action="store_true",
        help="Skip legacy informational scripts.",
    )
    return parser.parse_args()


def ensure_output_dir(output_root: Path) -> Path:
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    run_dir = output_root / timestamp
    (run_dir / "logs").mkdir(parents=True, exist_ok=True)
    return run_dir


def build_command(defn: SuiteDefinition) -> list[str]:
    if defn.kind == "pytest":
        return [sys.executable, "-m", "pytest", "-q", *defn.selectors]
    if defn.kind == "script":
        return [sys.executable, defn.script_path]
    raise ValueError(f"Unsupported suite kind: {defn.kind}")


def extract_summary(defn: SuiteDefinition, combined_output: str, return_code: int) -> str:
    text = combined_output.strip()
    if not text:
        return f"Completed with return code {return_code}."

    if defn.kind == "pytest" and return_code != 0:
        failure_match = re.search(r"^FAILED\s+(.+)$", text, re.MULTILINE)
        short_summary = re.search(r"^\d+\s+failed.*$", text, re.MULTILINE)
        if failure_match and short_summary:
            return f"FAILED {failure_match.group(1)} | {short_summary.group(0)}"
        if short_summary:
            return short_summary.group(0)

    if defn.suite_id == "FTI-001":
        summary_match = re.search(r"Summary:.*", text)
        total_match = re.search(r"Total files:.*", text)
        pieces = []
        if summary_match:
            pieces.append(summary_match.group(0))
        if total_match:
            pieces.append(total_match.group(0))
        if pieces:
            return " | ".join(pieces)

    if defn.suite_id == "FTI-002":
        highlights = []
        for pattern in (
            r"Exact match vs originalTexts:.*",
            r"Total diff lines:.*",
            r"Diffs when split by newline:.*",
        ):
            match = re.search(pattern, text)
            if match:
                highlights.append(match.group(0))
        if highlights:
            return " | ".join(highlights)

    lines = text.splitlines()
    return lines[-1][:400]


def run_suite(defn: SuiteDefinition, logs_dir: Path) -> SuiteResult:
    command = build_command(defn)
    started = time.perf_counter()
    proc = subprocess.run(
        command,
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    duration = time.perf_counter() - started
    combined_output = "\n".join(part for part in (proc.stdout, proc.stderr) if part).strip()
    log_path = logs_dir / f"{defn.suite_id}.log"
    log_path.write_text(combined_output + ("\n" if combined_output else ""), encoding="utf-8")

    if defn.kind == "pytest":
        status = "passed" if proc.returncode == 0 else "failed"
    else:
        status = "completed" if proc.returncode == 0 else "failed"

    return SuiteResult(
        suite_id=defn.suite_id,
        title=defn.title,
        kind=defn.kind,
        status=status,
        requirement_ids=list(defn.requirement_ids),
        duration_seconds=round(duration, 3),
        return_code=proc.returncode,
        command=command,
        log_file=str(log_path.relative_to(REPO_ROOT)).replace("\\", "/"),
        summary=extract_summary(defn, combined_output, proc.returncode),
    )


def render_markdown(
    run_dir: Path,
    automated_results: list[SuiteResult],
    informational_results: list[SuiteResult],
) -> str:
    lines: list[str] = []
    lines.append("# Functional Test Run")
    lines.append("")
    lines.append(f"Generated: {datetime.now().isoformat(timespec='seconds')}")
    lines.append("")
    lines.append("## Environment")
    lines.append("")
    lines.append(f"- Repository root: {REPO_ROOT}")
    lines.append(f"- Python: {sys.executable}")
    lines.append(f"- Platform: {platform.platform()}")
    lines.append(f"- Output directory: {run_dir}")
    lines.append("")

    lines.append("## Automated Assertion Suites")
    lines.append("")
    lines.append("| Suite | Status | Duration (s) | Requirements | Summary | Log |")
    lines.append("| --- | --- | ---: | --- | --- | --- |")
    for result in automated_results:
        reqs = ", ".join(result.requirement_ids)
        lines.append(
            f"| {result.suite_id} | {result.status} | {result.duration_seconds:.3f} | {reqs} | {result.summary.replace('|', '/')} | [{result.log_file}]({result.log_file}) |"
        )
    lines.append("")

    lines.append("## Informational Automation")
    lines.append("")
    lines.append("| Suite | Status | Duration (s) | Requirements | Summary | Log |")
    lines.append("| --- | --- | ---: | --- | --- | --- |")
    for result in informational_results:
        reqs = ", ".join(result.requirement_ids)
        lines.append(
            f"| {result.suite_id} | {result.status} | {result.duration_seconds:.3f} | {reqs} | {result.summary.replace('|', '/')} | [{result.log_file}]({result.log_file}) |"
        )
    lines.append("")

    lines.append("## Manual Cases Still Required")
    lines.append("")
    lines.append("| Test ID | Status | Requirements | Title |")
    lines.append("| --- | --- | --- | --- |")
    for case in MANUAL_CASES:
        reqs = ", ".join(case["requirement_ids"])
        lines.append(f"| {case['test_id']} | {case['status']} | {reqs} | {case['title']} |")
    lines.append("")

    failing = [result for result in automated_results if result.status != "passed"]
    if failing:
        lines.append("## Overall Result")
        lines.append("")
        lines.append("One or more automated assertion suites failed. Review the logs before using this run as release evidence.")
    else:
        lines.append("## Overall Result")
        lines.append("")
        lines.append("All automated assertion suites passed. Informational scripts and manual cases still require review.")
    lines.append("")
    return "\n".join(lines)


def selected_suites(args: argparse.Namespace) -> tuple[list[SuiteDefinition], list[SuiteDefinition]]:
    selected = set(args.suite)
    automated = list(AUTOMATED_SUITES)
    informational = [] if args.skip_informational else list(INFORMATIONAL_SUITES)

    if not selected:
        return automated, informational

    all_ids = {suite.suite_id for suite in automated + informational}
    unknown = sorted(selected - all_ids)
    if unknown:
        raise SystemExit(f"Unknown suite ID(s): {', '.join(unknown)}")

    automated = [suite for suite in automated if suite.suite_id in selected]
    informational = [suite for suite in informational if suite.suite_id in selected]
    return automated, informational


def main() -> int:
    args = parse_args()
    output_root = Path(args.output_root)
    automated_defs, informational_defs = selected_suites(args)
    run_dir = ensure_output_dir(output_root)
    logs_dir = run_dir / "logs"

    automated_results = [run_suite(defn, logs_dir) for defn in automated_defs]
    informational_results = [run_suite(defn, logs_dir) for defn in informational_defs]

    summary_path = run_dir / "functional-test-summary.md"
    summary_path.write_text(
        render_markdown(run_dir, automated_results, informational_results),
        encoding="utf-8",
    )

    json_path = run_dir / "functional-test-summary.json"
    payload = {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "repository_root": str(REPO_ROOT),
        "python": sys.executable,
        "platform": platform.platform(),
        "output_directory": str(run_dir),
        "automated_results": [asdict(result) for result in automated_results],
        "informational_results": [asdict(result) for result in informational_results],
        "manual_cases": list(MANUAL_CASES),
    }
    json_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    print(f"Wrote functional test report to {summary_path}")
    print(f"Wrote machine-readable results to {json_path}")

    if any(result.status != "passed" for result in automated_results):
        return 1
    if any(result.status == "failed" for result in informational_results):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())