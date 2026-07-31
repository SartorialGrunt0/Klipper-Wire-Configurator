#!/usr/bin/env python3
"""AI chat accuracy test harness for Klipper Wire Configurator.

Drives the real backend /ai/chat endpoint (the same one the frontend uses)
against a battery of questions with known success criteria. Each question
starts a fresh chat dialog (a single user message, its own requestId), so
the model cannot lean on prior conversation context.

The goal is twofold:
  1. Answer accuracy — does the model produce the expected answer?
  2. Tool reliability — does the model actually use the embedded MCP tools,
     and does it reach for the *right* tool for the job?

Every step is logged: the request payload, the raw response, the tool names
and tool-turn count reported by the backend, the per-question slice of the
backend's own log (backend/ai_chat.log), the pass/fail evaluation for each
criterion, and a final summary.

Usage (from the repo root, with the backend running):

    python3 scripts/ai_chat_accuracy_test.py

It will prompt for provider details and chat settings (provider, model, API
key, API URL / host+port, max tokens, backend base URL). All of those can
also be passed as flags for unattended runs:

    python3 scripts/ai_chat_accuracy_test.py \
        --provider openai-compatible --host localhost --port 1234 \
        --model llama-3.1-8b --max-tokens 4096 --base-url http://localhost:8099

Other useful flags:
    --questions 1-5,8     run only a subset of questions
    --list-questions      print the question bank and exit (no API calls)
    --output-dir DIR      where to write the log (default reports/ai-chat-accuracy)

Stdlib only — no third-party dependencies.
"""

from __future__ import annotations

import argparse
import getpass
import json
import re
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT_DIR = REPO_ROOT / "reports" / "ai-chat-accuracy"
BACKEND_CHAT_LOG = REPO_ROOT / "backend" / "ai_chat.log"

# ── Provider presets (mirrors frontend/src/utils/chatProviders.ts) ─────
PROVIDER_PRESETS: dict[str, dict] = {
    "chatgpt": {
        "label": "ChatGPT (OpenAI)",
        "default_model": "gpt-4o",
        "default_url": "https://api.openai.com/v1/chat/completions",
        "requires_key": True,
        "local": False,
    },
    "google": {
        "label": "Google (Gemini)",
        "default_model": "gemini-1.5-pro",
        "default_url": "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
        "requires_key": True,
        "local": False,
    },
    "anthropic": {
        "label": "Anthropic (Claude)",
        "default_model": "claude-3-5-sonnet",
        "default_url": "https://api.anthropic.com/v1/messages",
        "requires_key": True,
        "local": False,
    },
    "github": {
        "label": "GitHub Copilot",
        "default_model": "gpt-4o",
        "default_url": "https://models.github.ai/inference/chat/completions",
        "requires_key": True,
        "local": False,
    },
    "openai-compatible": {
        "label": "OpenAI Compatible (LM Studio / Ollama)",
        "default_model": "",
        "default_url": "",  # derived from host:port -> http://host:port/v1/chat/completions
        "requires_key": False,
        "local": True,
    },
}
PROVIDER_ORDER = ["chatgpt", "google", "anthropic", "github", "openai-compatible"]


# ── Question bank ──────────────────────────────────────────────────────
# Each question: a fresh chat dialog (messages=[user text]), the MCP tools
# the model should reach for (expected_tools), and checkable success
# criteria. Criterion kinds:
#   contains      -> value appears in the answer (case-insensitive)
#   not_contains  -> value must NOT appear (case-insensitive)
#   regex         -> value is a regex searched case-insensitively over the answer
@dataclass(frozen=True)
class TestQuestion:
    qid: str
    title: str
    text: str
    expected_tools: tuple[str, ...] = ()
    require_tool: bool = True
    criteria: tuple[tuple[str, str], ...] = ()


# Shared config snippets used by several questions.
_EXTRUDER_SNIPPET = """[extruder]
step_pin: PB4
dir_pin: !PB5
enable_pin: !PB3
microsteps: sixteen
rotation_distance: 100
heater_pin: PB6
sensor_type: NTC 100K
sensor_pin: PA0
control: pid
pid_Kp: 22.2
pid_Ki: 1.08
pid_Kd: 114
min_temp: 0
max_temp: 235
"""

_MCU_SNIPPET = """[mcu]
serial: /dev/serial/by-id/usb-Klipper_stm32f446xx_3D002B000E50505734393820-if00

[stepper_x]
step_pin: PC2
dir_pin: PB9
enable_pin: PC3
microsteps: 16
rotation_distance: 40
"""

_MACRO_SNIPPET = """[gcode_macro TEST]
gcode:
    RESTORE_GCODE_STATE NAME=missing_state
"""


def build_questions() -> list[TestQuestion]:
    return [
        TestQuestion(
            qid="Q01",
            title="Docs: [bed_mesh] horizontal_move_z",
            text="What does the `horizontal_move_z` parameter in the `[bed_mesh]` section do, "
                 "and what is its default value?",
            expected_tools=("search_klipper_docs", "get_config_reference_section"),
            criteria=(
                ("contains", "horizontal_move_z"),
                ("regex", r"\b5\s*mm\b"),
            ),
        ),
        TestQuestion(
            qid="Q02",
            title="Docs: [probe] section parameters",
            text="List all the parameters supported by the [probe] section in Klipper, "
                 "with their types where possible.",
            expected_tools=("get_config_reference_section", "search_klipper_docs"),
            criteria=(
                ("contains", "z_offset"),
                ("contains", "samples"),
                ("contains", "sample_retract_dist"),
            ),
        ),
        TestQuestion(
            qid="Q03",
            title="Docs: read Pressure Advance doc",
            text="Read the Klipper Pressure Advance documentation file and summarize "
                 "how to calibrate pressure advance.",
            expected_tools=("read_klipper_doc",),
            criteria=(
                ("contains", "pressure advance"),
                ("regex", r"calibrat|tun"),
            ),
        ),
        TestQuestion(
            qid="Q04",
            title="Docs: list bundled docs",
            text="What Klipper documentation files are bundled with this app? "
                 "Name at least five of them.",
            expected_tools=("list_klipper_docs",),
            criteria=(
                ("contains", "Config_Reference"),
                ("contains", "Pressure_Advance"),
            ),
        ),
        TestQuestion(
            qid="Q05",
            title="Schema: [heater_fan] section schema",
            text="What is the section schema for [heater_fan]? "
                 "List the supported parameters and their types.",
            expected_tools=("get_section_schema",),
            criteria=(
                ("contains", "heater_fan"),
                ("contains", "max_power"),
                ("contains", "shutdown_speed"),
            ),
        ),
        TestQuestion(
            qid="Q06",
            title="Validation: find the config error",
            text="Here is a config snippet. Validate it and tell me what is wrong with it:\n\n"
                 + _EXTRUDER_SNIPPET,
            expected_tools=("validate_klipper_config",),
            criteria=(
                ("contains", "microsteps"),
                ("regex", r"invalid|not a valid|must be|sixteen|expected"),
            ),
        ),
        TestQuestion(
            qid="Q07",
            title="Examples: search Voron configs",
            text="Find bundled example configurations for a Voron printer.",
            expected_tools=("search_example_configs",),
            criteria=(("regex", r"voron"),),
        ),
        TestQuestion(
            qid="Q08",
            title="Examples: SKR Mini E3 config",
            text="Find the generic example config for a BIGTREETECH SKR Mini E3 board "
                 "and show me its [mcu] section.",
            expected_tools=("search_example_configs", "read_example_config"),
            criteria=(
                ("regex", r"skr mini"),
                ("contains", "mcu"),
                ("regex", r"serial|usb"),
            ),
        ),
        TestQuestion(
            qid="Q09",
            title="User configs: search",
            text="Search my local configuration files for anything related to fans.",
            expected_tools=("search_user_configs",),
            criteria=(
                ("regex", r"aux_fan|fan"),
                ("regex", r"\.cfg"),
            ),
        ),
        TestQuestion(
            qid="Q10",
            title="User configs: read aux_fan.cfg",
            text="Read my local config file aux_fan.cfg and tell me what fan section "
                 "it defines.",
            expected_tools=("read_user_config", "search_user_configs"),
            criteria=(
                ("contains", "Aux_Fan"),
                ("regex", r"fan_generic|SET_FAN_SPEED"),
            ),
        ),
        TestQuestion(
            qid="Q11",
            title="Board detection",
            text="Here is an MCU definition from my printer.cfg. Which board or MCU "
                 "family does it look like?\n\n" + _MCU_SNIPPET,
            expected_tools=("detect_board",),
            criteria=(
                ("regex", r"stm32|STM32|stm|f446"),
                ("regex", r"octopus|f4|mcu|board"),
            ),
        ),
        TestQuestion(
            qid="Q12",
            title="Calc: leadscrew rotation_distance",
            text="My Z axis uses a leadscrew with 2mm pitch, single start. "
                 "What is the rotation_distance for my Z stepper?",
            expected_tools=("calculate_rotation_distance",),
            criteria=(
                ("contains", "rotation_distance"),
                ("regex", r"rotation_distance\s*[:=]?\s*2(\.0+)?\b"),
            ),
        ),
        TestQuestion(
            qid="Q13",
            title="Calc: belt rotation_distance",
            text="My X axis is belt driven with a 20-tooth pulley on the motor and a "
                 "GT2 belt (2mm pitch). What rotation_distance should I use?",
            expected_tools=("calculate_rotation_distance",),
            criteria=(
                ("contains", "rotation_distance"),
                ("regex", r"rotation_distance\s*[:=]?\s*40(\.0+)?\b"),
            ),
        ),
        TestQuestion(
            qid="Q14",
            title="Macros: PRINT_START template",
            text="Generate a PRINT_START macro template for me, including bed mesh "
                 "calibration.",
            expected_tools=("generate_macro_template",),
            criteria=(
                ("contains", "PRINT_START"),
                ("regex", r"\[gcode_macro"),
                ("contains", "BED_MESH_CALIBRATE"),
            ),
        ),
        TestQuestion(
            qid="Q15",
            title="Macros: validate macro",
            text="Validate this macro and tell me if there are any problems:\n\n"
                 + _MACRO_SNIPPET,
            expected_tools=("validate_macro",),
            criteria=(
                ("contains", "RESTORE_GCODE_STATE"),
                ("regex", r"missing|no matching|without|error|issue|problem|invalid|SAVE_GCODE_STATE"),
            ),
        ),
        TestQuestion(
            qid="Q16",
            title="Multi-tool: ADXL345 input shaper",
            text="I have an EBB36 toolhead board and want to add an accelerometer for "
                 "input shaper. Find an example config for accelerometers and search "
                 "the docs for how to set up an [adxl345] section.",
            expected_tools=(
                "search_example_configs",
                "read_example_config",
                "search_klipper_docs",
                "get_config_reference_section",
            ),
            criteria=(
                ("regex", r"adxl345|ADXL345"),
                ("regex", r"cs_pin|axes_map|spi"),
            ),
        ),
        TestQuestion(
            qid="Q17",
            title="Draft protocol: add [bed_mesh]",
            text="Add a [bed_mesh] section to my printer config with a 5x5 mesh and "
                 "default settings otherwise. Return it as a cfg block.\n\n"
                 "[printer]\n"
                 "kinematics: cartesian\n"
                 "max_velocity: 300\n"
                 "max_accel: 3000\n",
            expected_tools=(),
            require_tool=False,
            criteria=(
                ("regex", r"```cfg"),
                ("contains", "[bed_mesh]"),
                ("regex", r"probe_count.{0,20}?5"),
            ),
        ),
        TestQuestion(
            qid="Q18",
            title="Grounding: pressure_advance default",
            text="What is the default value of pressure_advance in the [extruder] section?",
            expected_tools=("search_klipper_docs", "get_config_reference_section"),
            criteria=(
                ("regex", r"default.{0,60}?\b0\b"),
            ),
        ),
        TestQuestion(
            qid="Q19",
            title="Guardrail: clarifying question",
            text="Help me set up my new printer from scratch. I have not given you any "
                 "details yet.",
            expected_tools=(),
            require_tool=False,
            criteria=(
                ("contains", "?"),
                ("regex", r"kinematic|mainboard|probe|toolhead|bed|printer|config"),
            ),
        ),
        TestQuestion(
            qid="Q20",
            title="Docs: SAVE_CONFIG command",
            text="Which Klipper command saves calibration results into the config file, "
                 "and what section does it create?",
            expected_tools=("search_klipper_docs", "get_config_reference_section"),
            criteria=(
                ("contains", "SAVE_CONFIG"),
                ("regex", r"\[\s*save_config\s*\]"),
            ),
        ),
    ]


ALL_TOOLS = (
    "search_klipper_docs",
    "read_klipper_doc",
    "list_klipper_docs",
    "get_config_reference_section",
    "validate_klipper_config",
    "get_section_schema",
    "search_example_configs",
    "read_example_config",
    "search_user_configs",
    "read_user_config",
    "detect_board",
    "calculate_rotation_distance",
    "generate_macro_template",
    "validate_macro",
)


# ── Evaluation ─────────────────────────────────────────────────────────
def criterion_ok(kind: str, value: str, content: str) -> bool:
    if kind == "contains":
        return value.lower() in content.lower()
    if kind == "not_contains":
        return value.lower() not in content.lower()
    if kind == "regex":
        return re.search(value, content, re.IGNORECASE | re.DOTALL) is not None
    return False


@dataclass
class QuestionResult:
    qid: str
    title: str
    status: str = "ERROR"          # PASS | FAIL | ERROR
    answer_ok: bool = False
    tool_ok: bool = False
    response: str = ""
    tool_names: list[str] = field(default_factory=list)
    tool_turns: int = 0
    backend_log_lines: list[str] = field(default_factory=list)
    error: str = ""
    checks: list[tuple[str, str, bool]] = field(default_factory=list)
    duration_s: float = 0.0


# ── HTTP helpers (stdlib only) ─────────────────────────────────────────
def http_get_json(url: str, timeout: float) -> dict:
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def http_post_json(url: str, payload: dict, timeout: float) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def chat_request(base_url: str, question: TestQuestion, settings: dict,
                 timeout: float) -> tuple[dict | None, str]:
    """POST one fresh chat dialog to /ai/chat.

    Returns (response_dict, error_string). Exactly one is set.
    """
    request_id = f"accuracy-{question.qid}-{int(time.time())}"
    payload = {
        "messages": [{"role": "user", "content": question.text}],
        "apiKey": settings["api_key"],
        "model": settings["model"],
        "apiUrl": settings["api_url"],
        "apiProvider": settings["provider"],
        "requestId": request_id,
        "maxTokens": settings["max_tokens"],
    }
    url = base_url.rstrip("/") + "/ai/chat"
    try:
        return http_post_json(url, payload, timeout), ""
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        return None, f"HTTP {exc.code}: {body[:500]}"
    except urllib.error.URLError as exc:
        return None, f"Connection error: {exc.reason}"
    except TimeoutError:
        return None, "Request timed out"
    except json.JSONDecodeError:
        return None, "Non-JSON response (backend returned HTML? stale bundle vs service?)"


def read_backend_log_slice(before_size: int) -> list[str]:
    """Return lines appended to backend/ai_chat.log since before_size."""
    if before_size < 0 or not BACKEND_CHAT_LOG.exists():
        return []
    size = BACKEND_CHAT_LOG.stat().st_size
    if size <= before_size:
        return []
    with open(BACKEND_CHAT_LOG, "r", encoding="utf-8", errors="replace") as fh:
        fh.seek(before_size)
        return [ln.rstrip("\n") for ln in fh.read().splitlines()]


# ── Logging ────────────────────────────────────────────────────────────
class TestLog:
    def __init__(self, path: Path):
        self.path = path
        self._fh = open(path, "w", encoding="utf-8")

    def write(self, text: str) -> None:
        self._fh.write(text + "\n")
        self._fh.flush()

    def section(self, title: str) -> None:
        self.write("")
        self.write("=" * 80)
        self.write(title)
        self.write("=" * 80)

    def close(self) -> None:
        self._fh.close()


# ── Interactive setup ──────────────────────────────────────────────────
def _prompt(label: str, default: str = "", secret: bool = False) -> str:
    if default:
        suffix = f" [{default}]"
    else:
        suffix = ""
    if secret:
        value = getpass.getpass(f"{label}{suffix}: ")
        return value or default
    value = input(f"{label}{suffix}: ").strip()
    return value or default


def resolve_settings(args: argparse.Namespace) -> dict:
    provider = args.provider
    if not provider:
        print("Available providers:")
        for i, name in enumerate(PROVIDER_ORDER, 1):
            print(f"  {i}. {name} ({PROVIDER_PRESETS[name]['label']})")
        choice = input(f"Provider [1-{len(PROVIDER_ORDER)}, default 1]: ").strip()
        if choice.isdigit() and 1 <= int(choice) <= len(PROVIDER_ORDER):
            provider = PROVIDER_ORDER[int(choice) - 1]
        elif choice in PROVIDER_PRESETS:
            provider = choice
        else:
            provider = PROVIDER_ORDER[0]

    preset = PROVIDER_PRESETS[provider]

    model = args.model or _prompt("Model", preset["default_model"])

    api_key = args.api_key
    if api_key is None:
        env_key = __import__("os").environ.get("KWC_TEST_API_KEY", "")
        api_key = env_key or ("" if preset["local"] else _prompt("API key", secret=True))

    api_url = args.api_url
    if not api_url:
        if preset["local"]:
            host = args.host or _prompt("Host", "localhost")
            port = args.port or _prompt("Port", "1234")
            api_url = f"http://{host}:{port}/v1/chat/completions"
        else:
            api_url = _prompt("API URL", preset["default_url"])

    max_tokens = args.max_tokens or int(_prompt("Max tokens", "4096"))
    base_url = args.base_url or _prompt("Backend base URL", "http://localhost:8099")

    return {
        "provider": provider,
        "model": model,
        "api_key": api_key,
        "api_url": api_url,
        "max_tokens": int(max_tokens),
        "base_url": base_url,
    }


# ── Question selection ─────────────────────────────────────────────────
def parse_question_filter(spec: str, count: int) -> list[int]:
    """Parse '1-5,8' into zero-based indices."""
    indices: set[int] = set()
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            lo, _, hi = part.partition("-")
            lo_i = int(lo) - 1
            hi_i = int(hi) - 1
            indices.update(range(max(0, lo_i), min(count, hi_i + 1)))
        else:
            idx = int(part) - 1
            if 0 <= idx < count:
                indices.add(idx)
    return sorted(indices)


# ── Main ───────────────────────────────────────────────────────────────
def main() -> int:
    parser = argparse.ArgumentParser(
        description="Test AI chat accuracy and MCP tool usage against the running backend.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--base-url", default="", help="Backend base URL, e.g. http://localhost:8099")
    parser.add_argument("--provider", default="", choices=list(PROVIDER_PRESETS.keys()),
                        help="AI provider (prompted if omitted)")
    parser.add_argument("--model", default="", help="Model name (prompted if omitted)")
    parser.add_argument("--api-key", default="", help="API key (prompted if omitted; "
                        "env KWC_TEST_API_KEY also works; never logged)")
    parser.add_argument("--api-url", default="", help="Full API URL (openai-compatible derives from host/port)")
    parser.add_argument("--host", default="", help="Host for openai-compatible local server")
    parser.add_argument("--port", default="", help="Port for openai-compatible local server")
    parser.add_argument("--max-tokens", default=0, type=int, help="Max tokens per reply")
    parser.add_argument("--questions", default="", help="Subset, e.g. '1-5,8' (1-based)")
    parser.add_argument("--list-questions", action="store_true",
                        help="Print the question bank and exit")
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR),
                        help="Directory for the log and results JSON")
    parser.add_argument("--timeout", default=600, type=float,
                        help="Per-request timeout in seconds")
    args = parser.parse_args()

    questions = build_questions()
    if args.list_questions:
        print(f"{'QID':<5} {'TOOLS':<45} TITLE")
        print("-" * 100)
        for q in questions:
            tools = ",".join(q.expected_tools) if q.expected_tools else "(any/none)"
            print(f"{q.qid:<5} {tools:<45} {q.title}")
        return 0

    settings = resolve_settings(args)

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    log_path = output_dir / f"ai_chat_accuracy_{timestamp}.log"
    results_path = output_dir / f"ai_chat_accuracy_{timestamp}.json"
    log = TestLog(log_path)

    base_url = settings["base_url"].rstrip("/")

    # Sanitized settings for logging — never write the API key.
    log_settings = dict(settings)
    log_settings["api_key"] = "***" if settings["api_key"] else "(none)"

    log.section(f"AI Chat Accuracy Test — {datetime.now().isoformat()}")
    log.write(f"Settings (sanitized): {json.dumps(log_settings, indent=2)}")
    log.write(f"Question count: {len(questions)}")
    log.write(f"Backend chat log: {BACKEND_CHAT_LOG}")
    log.write(f"Run output: {log_path}")

    # Health check
    print(f"Checking backend at {base_url}/health ...")
    try:
        health = http_get_json(base_url + "/health", timeout=10)
        log.write(f"\nHealth check: {json.dumps(health)}")
        print(f"Backend healthy: {health}")
    except Exception as exc:  # noqa: BLE001
        msg = (f"Backend not reachable at {base_url} — start it first "
               f"(cd backend && source venv/bin/activate && python main.py). "
               f"Error: {exc}")
        log.section("FATAL")
        log.write(msg)
        log.close()
        print(msg, file=sys.stderr)
        return 1

    selected = parse_question_filter(args.questions, len(questions)) if args.questions \
        else list(range(len(questions)))
    if not selected:
        print("No questions selected (check --questions syntax).", file=sys.stderr)
        log.close()
        return 1

    log.section("Questions")
    for i, q in enumerate(questions):
        log.write(f"{q.qid} [{q.title}]")
        log.write(f"  tools_expected: {', '.join(q.expected_tools) if q.expected_tools else '(none required)'}")
        log.write(f"  criteria: {list(q.criteria)}")
        log.write(f"  prompt: {q.text[:300]}{'...' if len(q.text) > 300 else ''}")

    results: list[QuestionResult] = []
    print(f"\nRunning {len(selected)} of {len(questions)} questions against "
          f"provider={settings['provider']} model={settings['model']}")

    for idx in selected:
        q = questions[idx]
        log.section(f"{q.qid} — {q.title}")
        print(f"\n[{q.qid}] {q.title} ...", end=" ", flush=True)
        start = time.monotonic()
        before_size = BACKEND_CHAT_LOG.stat().st_size if BACKEND_CHAT_LOG.exists() else -1

        response, error = chat_request(base_url, q, settings, args.timeout)
        duration = time.monotonic() - start
        log_lines = read_backend_log_slice(before_size)

        result = QuestionResult(qid=q.qid, title=q.title, duration_s=round(duration, 1))
        log.write(f"Request: messages=[user: {q.text}] requestId=accuracy-{q.qid}-* "
                  f"(apiKey redacted)")
        log.write(f"Backend log slice ({len(log_lines)} lines):")
        for ln in log_lines:
            log.write(f"  {ln}")

        if error:
            result.status = "ERROR"
            result.error = error
            log.write(f"ERROR: {error}")
            print("ERROR", flush=True)
        elif response is None:
            result.status = "ERROR"
            result.error = "No response received"
            log.write("ERROR: No response received")
            print("ERROR", flush=True)
        else:
            result.response = response.get("content", "")
            result.tool_names = list(response.get("mcpToolNames", []) or [])
            result.tool_turns = int(response.get("mcpToolTurns", 0) or 0)

            log.write(f"Response mcpToolTurns={result.tool_turns} "
                      f"mcpToolNames={result.tool_names}")
            log.write(f"Raw response keys: {sorted(response.keys())}")
            log.write(f"Answer ({len(result.response)} chars):")
            log.write(result.response)

            if "error" in response:
                result.status = "ERROR"
                result.error = str(response["error"])
                log.write(f"API error: {result.error}")
                print("ERROR", flush=True)
            else:
                # Tool-usage check
                used = set(result.tool_names)
                expected = set(q.expected_tools)
                result.tool_ok = (not q.require_tool) or bool(used & expected)
                if q.require_tool and not used:
                    result.tool_ok = False
                # Answer check
                for kind, value in q.criteria:
                    ok = criterion_ok(kind, value, result.response)
                    result.checks.append((kind, value, ok))
                result.answer_ok = all(ok for _, _, ok in result.checks)
                result.status = "PASS" if (result.answer_ok and result.tool_ok) else "FAIL"

                log.write(f"Tool check: {'PASS' if result.tool_ok else 'FAIL'} "
                          f"(used={sorted(used)} expected={sorted(expected)})")
                for kind, value, ok in result.checks:
                    log.write(f"  criterion {kind} {value!r}: {'PASS' if ok else 'FAIL'}")
                log.write(f"OVERALL: {result.status}")
                print(result.status, flush=True)

        results.append(result)

    # ── Summary ──
    log.section("SUMMARY")
    passed = [r for r in results if r.status == "PASS"]
    failed = [r for r in results if r.status == "FAIL"]
    errored = [r for r in results if r.status == "ERROR"]

    log.write(f"Total: {len(results)}  Passed: {len(passed)}  Failed: {len(failed)}  "
              f"Errors: {len(errored)}")
    log.write(f"Answer accuracy: {len([r for r in results if r.answer_ok])}/{len(results)}")
    log.write(f"Tool-usage accuracy: {len([r for r in results if r.tool_ok])}/{len(results)}")
    log.write("")
    log.write(f"{'QID':<5} {'STATUS':<7} {'ANSWER':<7} {'TOOL':<7} {'TURNS':<6} TOOLS USED")
    for r in results:
        log.write(f"{r.qid:<5} {r.status:<7} {str(r.answer_ok):<7} {str(r.tool_ok):<7} "
                  f"{r.tool_turns:<6} {','.join(r.tool_names) or '-'}")
    if failed:
        log.write("")
        log.write("Failed questions:")
        for r in failed:
            log.write(f"  {r.qid} {r.title} (answer={r.answer_ok} tool={r.tool_ok})")
    if errored:
        log.write("")
        log.write("Errored questions:")
        for r in errored:
            log.write(f"  {r.qid} {r.title}: {r.error}")

    exercised = {t for r in results for t in r.tool_names}
    missing = [t for t in ALL_TOOLS if t not in exercised]
    log.write("")
    log.write(f"Tools exercised ({len(exercised)}/{len(ALL_TOOLS)}): "
              f"{', '.join(sorted(exercised)) or '(none)'}")
    if missing:
        log.write(f"Tools NEVER used: {', '.join(missing)}")

    # Machine-readable copy
    with open(results_path, "w", encoding="utf-8") as fh:
        json.dump({
            "run_at": datetime.now().isoformat(),
            "settings": log_settings,
            "results": [vars(r) for r in results],
            "tools_exercised": sorted(exercised),
            "tools_missing": missing,
        }, fh, indent=2)

    log.close()

    # Console summary
    print("\n" + "=" * 60)
    print(f"SUMMARY — {len(passed)}/{len(results)} passed "
          f"({len(failed)} failed, {len(errored)} errored)")
    print(f"Answer accuracy: {len([r for r in results if r.answer_ok])}/{len(results)}")
    print(f"Tool-usage accuracy: {len([r for r in results if r.tool_ok])}/{len(results)}")
    for r in results:
        mark = "PASS" if r.status == "PASS" else ("ERR " if r.status == "ERROR" else "FAIL")
        print(f"  {r.qid} {mark}  tools=[{','.join(r.tool_names) or '-'}]  {r.title}")
    print(f"\nTools exercised: {len(exercised)}/{len(ALL_TOOLS)}")
    if missing:
        print(f"Tools NEVER used: {', '.join(missing)}")
    print(f"\nFull log: {log_path}")
    print(f"Machine-readable: {results_path}")
    return 0 if not failed and not errored else 2


if __name__ == "__main__":
    sys.exit(main())
