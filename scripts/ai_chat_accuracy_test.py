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
    --start N             start at question N (runs N..end); ignored when --questions is set
    --list-questions      print the question bank and exit (no API calls)
    --output-dir DIR      where to write the log (default reports/ai-chat-accuracy)
    --include-memory      also test printer-memory auto-fill (MEMORY-01..03); the backend's
                          printer memory is backed up, blanked to trigger the auto-fill
                          prompt, and restored automatically afterward

Question bank: Q01-Q20 (core tools), MACRO-01..11 (macro authoring, editing,
fixing, template options, and the individual validate_macro checks),
TRIDENT-01..14 (real configs from reference/Trident_backup and the real
backend/user_configs — read, edit, delete, manage, and fix the actual
printer.cfg/aux_fan.cfg/PIS.cfg via the draft-block protocol; the files are
attached as read-only context and never modified), and MEMORY-01..03
(printer-memory auto-fill, requires --include-memory).

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
    # Real config files to attach as system context, mirroring how the
    # frontend attaches config files to the chat. Each entry is
    # (filename, label, content). The model must read/answer from these
    # rather than inventing config. Files are never modified — the chat
    # endpoint only returns draft text.
    context_files: tuple[tuple[str, str, str], ...] = ()


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
                ("regex", r"\b5\b"),
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
                ("regex", r"(?:\d+\.\s+\*\*[^*\n]+\.md\*\*[^\n]*(?:\n|$)){4,}"),
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
                ("regex", r"rotation[_ ]distance[^0-9]{0,40}?\b2(\.0+)?\b"),
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
                ("regex", r"rotation[_ ]distance[^0-9]{0,40}?\b40(\.0+)?\b"),
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
            text="My printer bed is 300x300 mm and my probe is at x_offset 0, "
                 "y_offset 20. Add a [bed_mesh] section to my "
                 "printer config with a 5x5 mesh and default settings otherwise. "
                 "Return it as a cfg block.\n\n"
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
                ("regex", r"default.{0,120}?\b0\b"),
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
                ("regex", r"provide|need to know|what|which"),
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
                ("regex", r"append|to the end|section"),
            ),
        ),
    ]


def build_macro_questions() -> list[TestQuestion]:
    """Macro-focused questions: authoring, editing, fixing, template options,
    and the individual validate_macro checks."""
    return [
        TestQuestion(
            qid="MACRO-01",
            title="Macros: create from scratch",
            text=("Write a NEW Klipper gcode_macro from scratch named PARK_HEAD that: "
                  "parks the toolhead at X0 Y0 with a 10mm Z lift, turns off the part "
                  "cooling fan (M106 S0), and includes a short description line. "
                  "Return it as a cfg block."),
            expected_tools=("validate_macro",),
            require_tool=False,
            criteria=(
                ("regex", r"\[gcode_macro\s+PARK_HEAD"),
                ("contains", "description:"),
                ("regex", r"G1\b[^\n]*X0|G28"),
                ("regex", r"M106[^\n]*S0"),
                ("regex", r"```cfg"),
            ),
        ),
        TestQuestion(
            qid="MACRO-02",
            title="Macros: modify existing",
            text=("Here is my current PRINT_START macro:\n\n"
                  "```cfg\n"
                  "[gcode_macro PRINT_START]\n"
                  "description: Start a print\n"
                  "\n"
                  "gcode:\n"
                  "    G28\n"
                  "    G1 X150 Y150 F6000\n"
                  "    G92 E0\n"
                  "```\n\n"
                  "Modify it to heat the bed to 60C (M140 S60) and run BED_MESH_CALIBRATE "
                  "before the G1 move. Return the full updated macro as a cfg block."),
            expected_tools=("validate_macro", "get_config_reference_section"),
            require_tool=False,
            criteria=(
                ("regex", r"\[gcode_macro\s+PRINT_START"),
                ("regex", r"M140[^\n]*S60"),
                ("contains", "BED_MESH_CALIBRATE"),
                ("regex", r"```cfg"),
            ),
        ),
        TestQuestion(
            qid="MACRO-03",
            title="Macros: fix a bug",
            text=("This macro has a bug. Fix it and return the corrected version as a "
                  "cfg block:\n\n"
                  "```cfg\n"
                  "[gcode_macro FIX_ME]\n"
                  "description: test\n"
                  "\n"
                  "gcode:\n"
                  "    {% if printer.bed_mesh %}\n"
                  "        BED_MESH_CALIBRATE\n"
                  "    M140 S60\n"
                  "```"),
            expected_tools=("validate_macro",),
            require_tool=False,
            criteria=(
                ("regex", r"\[gcode_macro\s+FIX_ME"),
                ("contains", "{% endif %}"),
                ("contains", "BED_MESH_CALIBRATE"),
                ("regex", r"```cfg"),
            ),
        ),
        TestQuestion(
            qid="MACRO-04",
            title="Macros: generate all templates",
            text=("Generate PAUSE, RESUME, PRINT_END, and CANCEL_PRINT macro templates "
                  "for me — one cfg block per macro."),
            expected_tools=("generate_macro_template",),
            require_tool=True,
            criteria=(
                ("regex", r"\[gcode_macro\s+PAUSE"),
                ("regex", r"\[gcode_macro\s+RESUME"),
                ("regex", r"\[gcode_macro\s+PRINT_END"),
                ("regex", r"\[gcode_macro\s+CANCEL_PRINT"),
            ),
        ),
        TestQuestion(
            qid="MACRO-05",
            title="Macros: custom park/retract options",
            text=("Generate a PAUSE macro template with park position X=100 Y=150, "
                  "Z lift 20mm, retract 3mm at 30mm/s. Return it as a cfg block."),
            expected_tools=("generate_macro_template",),
            require_tool=True,
            criteria=(
                ("regex", r"\[gcode_macro\s+PAUSE"),
                ("regex", r"PARK_X[^\n]*100"),
                ("regex", r"PARK_Y[^\n]*150"),
                ("regex", r"LIFT_Z[^\n]*20"),
                ("regex", r"RETRACT[^\n]*3\b"),
                ("regex", r"RETRACT_SPEED[^\n]*30\b"),
            ),
        ),
        TestQuestion(
            qid="MACRO-06",
            title="Macros: validate Jinja imbalance",
            text=("Validate this macro and tell me what is wrong with it:\n\n"
                  "[gcode_macro TEST]\n"
                  "description: x\n"
                  "\n"
                  "gcode:\n"
                  "    {% if printer.bed_mesh %}\n"
                  "        G28\n"),
            expected_tools=("validate_macro",),
            require_tool=True,
            criteria=(
                ("regex", r"unbalanced|missing.{0,20}end|end.?if"),
            ),
        ),
        TestQuestion(
            qid="MACRO-07",
            title="Macros: validate M104 without S",
            text=("Validate this macro and report any problems:\n\n"
                  "[gcode_macro HEAT]\n"
                  "description: heat\n"
                  "\n"
                  "gcode:\n"
                  "    M104\n"
                  "    G28\n"),
            expected_tools=("validate_macro",),
            require_tool=True,
            criteria=(
                ("contains", "M104"),
                ("regex", r"without\s+'?S'?|requires?\s+an?\s+[`']?S|missing.{0,20}temp"),
            ),
        ),
        TestQuestion(
            qid="MACRO-08",
            title="Macros: validate G1 E without feedrate",
            text=("Validate this macro and report any problems:\n\n"
                  "[gcode_macro PRIME]\n"
                  "description: prime\n"
                  "\n"
                  "gcode:\n"
                  "    G1 X10 Y10 E5\n"),
            expected_tools=("validate_macro",),
            require_tool=True,
            criteria=(
                ("regex", r"without feedrate|feedrate"),
            ),
        ),
        TestQuestion(
            qid="MACRO-09",
            title="Macros: validate mesh without homing",
            text=("Validate this macro and report any problems:\n\n"
                  "[gcode_macro MESH]\n"
                  "description: mesh\n"
                  "\n"
                  "gcode:\n"
                  "    BED_MESH_CALIBRATE\n"),
            expected_tools=("validate_macro",),
            require_tool=True,
            criteria=(
                ("contains", "G28"),
                ("contains", "BED_MESH_CALIBRATE"),
            ),
        ),
        TestQuestion(
            qid="MACRO-10",
            title="Macros: generate then validate",
            text=("Generate a RESUME macro template, then validate the generated macro "
                  "and report whether it has any issues."),
            expected_tools=("generate_macro_template", "validate_macro"),
            require_tool=True,
            criteria=(
                ("regex", r"\[gcode_macro\s+RESUME"),
                ("regex", r"valid|issue|warning|error"),
            ),
        ),
        TestQuestion(
            qid="MACRO-11",
            title="Macros: move-safety geometry",
            text=("Validate this macro against a printer with a 300x300mm bed and 250mm "
                  "max Z, with a no-go zone from X100-180, Y100-180. Use the validate_macro "
                  "tool and pass the bed dimensions and no-go zone so it can check move "
                  "safety:\n\n"
                  "[gcode_macro MOVE]\n"
                  "description: test\n"
                  "\n"
                  "gcode:\n"
                  "    G1 X150 Y150 F6000\n"),
            expected_tools=("validate_macro",),
            require_tool=True,
            criteria=(
                ("regex", r"no-?go|zone hit|inside a zone|crosses? a zone"),
            ),
        ),
    ]


# ── Real-config (Trident backup) questions ─────────────────────────────
# These attach the real printer config files under
# reference/Trident_backup/printer_data/config/ as chat context, exactly
# like the frontend does when config files are loaded/attached, and force
# the model to read, edit, delete, and manage the real files via the
# draft-block protocol (# file: hints, *[section] deletes, #[section]
# comment-outs). The backend /ai/chat endpoint only returns draft text —
# it never writes these files, so the backup stays untouched.
TRIDENT_BACKUP_DIR = (
    REPO_ROOT / "reference" / "Trident_backup" / "printer_data" / "config"
)
TRIDENT_FILE_LABEL = "Klipper config file (reference/Trident_backup)"


def _load_trident_config(filename: str) -> str:
    path = TRIDENT_BACKUP_DIR / filename
    if not path.exists():
        raise FileNotFoundError(f"Trident backup config missing: {path}")
    return path.read_text(encoding="utf-8")


def _cfg_context(*filenames: str) -> tuple[tuple[str, str, str], ...]:
    return tuple(
        (name, TRIDENT_FILE_LABEL, _load_trident_config(name)) for name in filenames
    )


# The real user-config directory the backend's search_user_configs /
# read_user_config tools serve. Its printer.cfg genuinely differs from the
# Trident backup: the [gcode_macro M109] macro is missing its {% endif %}
# (unbalanced Jinja) — a real bug used by the macro error-check questions.
BACKEND_USER_CONFIGS_DIR = REPO_ROOT / "backend" / "user_configs"


def _load_user_config(filename: str) -> str:
    path = BACKEND_USER_CONFIGS_DIR / filename
    if not path.exists():
        raise FileNotFoundError(f"Backend user config missing: {path}")
    return path.read_text(encoding="utf-8")


def _load_m109_bugged_printer_cfg() -> str:
    """Real backend/user_configs/printer.cfg whose M109 macro is genuinely
    missing {% endif %}. Guard against the fixture being fixed so the
    error-check questions stay honest."""
    content = _load_user_config("printer.cfg")
    m109 = re.search(r"\[gcode_macro M109\].*?(?=\n\[gcode_macro|\Z)",
                     content, re.DOTALL)
    if (not m109 or "{% if s != 0 %}" not in m109.group(0)
            or "{% endif %}" in m109.group(0)):
        raise RuntimeError(
            "backend/user_configs/printer.cfg no longer has the expected M109 "
            "unbalanced-Jinja fixture; update TRIDENT-09/10."
        )
    return content


def _load_kinematics_bugged_printer_cfg() -> str:
    """Real Trident printer.cfg with one planted bug in a config section:
    [printer] kinematics corexy -> coresy. The on-disk file is untouched —
    only the attached test fixture carries the bug."""
    content = _load_trident_config("printer.cfg")
    bugged = content.replace("kinematics: corexy", "kinematics: coresy", 1)
    if bugged == content:
        raise RuntimeError(
            "could not plant kinematics bug — marker not found in printer.cfg"
        )
    return bugged


def _context_with(content: str,
                   filename: str = "printer.cfg") -> tuple[tuple[str, str, str], ...]:
    return ((filename, TRIDENT_FILE_LABEL, content),)


def build_trident_questions() -> list[TestQuestion]:
    """Real-file questions: read through, edit, delete, manage, and fix the
    actual configs in reference/Trident_backup (printer.cfg, aux_fan.cfg,
    PIS.cfg) and the real backend/user_configs/printer.cfg.

    The files are attached as context (never modified); every criterion
    checks the model actually engaged the real file and used the
    draft-block protocol with correct '# file:' targeting. Questions
    09-10 use the genuine unbalanced-Jinja bug in the real
    backend/user_configs/printer.cfg M109 macro; question 14 plants one
    kinematics typo on a real section of an attached copy.
    """
    printer_cfg = _cfg_context("printer.cfg")
    printer_and_aux = _cfg_context("printer.cfg", "aux_fan.cfg")
    return [
        TestQuestion(
            qid="TRIDENT-01",
            title="Real file: read through printer.cfg",
            text=("Read through the provided printer.cfg and answer from the file: "
                  "what kinematics does it use, what is the configured max_accel, "
                  "and which TMC driver sections are present? Name the real values "
                  "you found in the file."),
            context_files=printer_cfg,
            require_tool=False,
            criteria=(
                ("contains", "corexy"),
                ("regex", r"max_accel\s*:\s*15500"),
                ("contains", "tmc2209"),
            ),
        ),
        TestQuestion(
            qid="TRIDENT-02",
            title="Real file: edit [printer] max_accel",
            text=("In printer.cfg the [printer] section sets max_accel to 15500. "
                  "Change it to 12000 and return only the changed section in a "
                  "fenced cfg code block starting with a '# file: printer.cfg' "
                  "hint line. Validate the result."),
            context_files=printer_cfg,
            expected_tools=("validate_klipper_config",),
            require_tool=False,
            criteria=(
                ("regex", r"```cfg"),
                ("regex", r"#\s*file\s*:\s*printer\.cfg"),
                ("regex", r"\[printer\]"),
                ("regex", r"max_accel\s*:\s*12000"),
            ),
        ),
        TestQuestion(
            qid="TRIDENT-03",
            title="Real file: delete RESET_ACCEL macro",
            text=("In printer.cfg there is a [gcode_macro RESET_ACCEL] section. "
                  "Delete it entirely: write '*[gcode_macro RESET_ACCEL]' on its "
                  "own line inside a fenced cfg code block that starts with a "
                  "'# file: printer.cfg' hint line."),
            context_files=printer_cfg,
            expected_tools=("validate_klipper_config",),
            require_tool=False,
            criteria=(
                ("regex", r"```cfg"),
                ("regex", r"#\s*file\s*:\s*printer\.cfg"),
                ("regex", r"\*\s*\[gcode_macro\s+RESET_ACCEL\]"),
            ),
        ),
        TestQuestion(
            qid="TRIDENT-04",
            title="Real file: comment out sensorless include",
            text=("In printer.cfg, sensorless.cfg is currently included. Comment "
                  "out that include line so sensorless.cfg no longer loads. Return "
                  "the edit as a fenced cfg code block with a '# file: printer.cfg' "
                  "hint line."),
            context_files=printer_cfg,
            require_tool=False,
            criteria=(
                ("regex", r"#\s*file\s*:\s*printer\.cfg"),
                ("regex", r"#\s*\[include\s+sensorless\.cfg\]"),
            ),
        ),
        TestQuestion(
            qid="TRIDENT-05",
            title="Real file: edit aux_fan.cfg fan",
            text=("The file aux_fan.cfg defines [fan_generic Aux_Fan] and the "
                  "M106/M107 replacement macros. In aux_fan.cfg, change the "
                  "Aux_Fan max_power to 0.8. Return only the changed section in a "
                  "fenced cfg code block with a '# file: aux_fan.cfg' hint line."),
            context_files=printer_and_aux,
            expected_tools=("validate_klipper_config",),
            require_tool=False,
            criteria=(
                ("regex", r"#\s*file\s*:\s*aux_fan\.cfg"),
                ("regex", r"\[fan_generic\s+Aux_Fan\]"),
                ("regex", r"max_power\s*:\s*0\.8"),
            ),
        ),
        TestQuestion(
            qid="TRIDENT-06",
            title="Real file: create park_head.cfg + include it",
            text=("Create a NEW file park_head.cfg containing a [gcode_macro "
                  "PARK_HEAD] macro that homes the toolhead and parks it at "
                  "X175 Y175 with a 20mm Z lift. Then add an "
                  "[include park_head.cfg] line to printer.cfg. Return two fenced "
                  "cfg code blocks — one per file — each with the correct "
                  "'# file:' hint line."),
            context_files=printer_cfg,
            expected_tools=("validate_macro",),
            require_tool=False,
            criteria=(
                ("regex", r"#\s*file\s*:\s*park_head\.cfg"),
                ("regex", r"\[gcode_macro\s+PARK_HEAD"),
                ("regex", r"#\s*file\s*:\s*printer\.cfg"),
                ("regex", r"\[include\s+park_head\.cfg\]"),
            ),
        ),
        TestQuestion(
            qid="TRIDENT-07",
            title="Real file: probe tolerance grounded in docs",
            text=("In printer.cfg the [probe] section sets samples_tolerance to "
                  "0.008. Look up what samples_tolerance does in the Klipper "
                  "Config_Reference, then propose changing it to 0.005 in "
                  "printer.cfg. Return the changed section in a fenced cfg code "
                  "block with a '# file: printer.cfg' hint line and cite the doc."),
            context_files=printer_cfg,
            expected_tools=("get_config_reference_section", "search_klipper_docs"),
            require_tool=False,
            criteria=(
                ("regex", r"#\s*file\s*:\s*printer\.cfg"),
                ("regex", r"\[probe\]"),
                ("regex", r"samples_tolerance\s*:\s*0\.005"),
                ("contains", "samples_tolerance"),
            ),
        ),
        TestQuestion(
            qid="TRIDENT-08",
            title="Real file: bed_mesh multi-parameter edit",
            text=("In printer.cfg the [bed_mesh] section currently uses "
                  "probe_count 7,7 and mesh_pps 10,10. Change probe_count to 5,5 "
                  "and mesh_pps to 5,5. Return the full updated [bed_mesh] "
                  "section in a fenced cfg code block with a '# file: printer.cfg' "
                  "hint line."),
            context_files=printer_cfg,
            expected_tools=("validate_klipper_config",),
            require_tool=False,
            criteria=(
                ("regex", r"#\s*file\s*:\s*printer\.cfg"),
                ("regex", r"\[bed_mesh\]"),
                ("regex", r"probe_count\s*:\s*5,\s*5"),
                ("regex", r"mesh_pps\s*:\s*5,\s*5"),
            ),
        ),
        TestQuestion(
            qid="TRIDENT-09",
            title="Real macro: error-check M109",
            text=("Read the [gcode_macro M109] macro in the provided printer.cfg "
                  "and error-check it. Is there anything wrong with the macro "
                  "itself? Be specific about the problem."),
            # Real backend/user_configs/printer.cfg — its M109 genuinely
            # lacks {% endif %} (unbalanced Jinja).
            context_files=_context_with(_load_m109_bugged_printer_cfg()),
            expected_tools=("validate_macro",),
            require_tool=False,
            criteria=(
                ("contains", "M109"),
                ("regex", r"unbalanced|missing.{0,30}end.?if|end.?if|{% endif %}"),
            ),
        ),
        TestQuestion(
            qid="TRIDENT-10",
            title="Real macro: fix unbalanced Jinja in M109",
            text=("The [gcode_macro M109] macro in the provided printer.cfg has "
                  "a bug: its Jinja conditional is unbalanced. Fix it and return "
                  "the corrected macro in a fenced cfg code block with a "
                  "'# file: printer.cfg' hint line."),
            context_files=_context_with(_load_m109_bugged_printer_cfg()),
            expected_tools=("validate_macro",),
            require_tool=False,
            criteria=(
                ("regex", r"#\s*file\s*:\s*printer\.cfg"),
                ("regex", r"\[gcode_macro\s+M109\]"),
                ("contains", "{% endif %}"),
            ),
        ),
        TestQuestion(
            qid="TRIDENT-11",
            title="Two user files: edit printer.cfg and aux_fan.cfg",
            text=("Make two edits across two user files: in printer.cfg change "
                  "[printer] max_accel to 12000, and in aux_fan.cfg change "
                  "[fan_generic Aux_Fan] max_power to 0.8. Return two fenced cfg "
                  "code blocks — one per file — each with the correct "
                  "'# file:' hint line."),
            context_files=_cfg_context("printer.cfg", "aux_fan.cfg"),
            require_tool=False,
            criteria=(
                ("regex", r"#\s*file\s*:\s*printer\.cfg"),
                ("regex", r"max_accel\s*:\s*12000"),
                ("regex", r"#\s*file\s*:\s*aux_fan\.cfg"),
                ("regex", r"max_power\s*:\s*0\.8"),
            ),
        ),
        TestQuestion(
            qid="TRIDENT-12",
            title="Included + non-included user files",
            text=("In this config set, aux_fan.cfg is included by printer.cfg but "
                  "PIS.cfg is NOT included (its include line is commented out). "
                  "Edit aux_fan.cfg to change [fan_generic Aux_Fan] max_power to "
                  "0.8, and edit PIS.cfg to change [resonance_tester] "
                  "accel_per_hz to 50. Return two fenced cfg code blocks with the "
                  "correct '# file:' hint lines."),
            context_files=_cfg_context("printer.cfg", "aux_fan.cfg", "PIS.cfg"),
            require_tool=False,
            criteria=(
                ("regex", r"#\s*file\s*:\s*aux_fan\.cfg"),
                ("regex", r"max_power\s*:\s*0\.8"),
                ("regex", r"#\s*file\s*:\s*PIS\.cfg"),
                ("regex", r"accel_per_hz\s*:\s*50"),
            ),
        ),
        TestQuestion(
            qid="TRIDENT-13",
            title="Add + modify + delete in one file, preserve the rest",
            text=("In printer.cfg, perform all three of these edits and nothing "
                  "else: (1) add a new [gcode_macro PARK_HEAD] section, "
                  "(2) change [bed_mesh] probe_count from 7,7 to 5,5, "
                  "(3) delete the [gcode_macro RESET_ACCEL] section using "
                  "'*[gcode_macro RESET_ACCEL]'. Return them in fenced cfg code "
                  "blocks with '# file: printer.cfg' hint lines. Do not modify "
                  "any other content in the file."),
            context_files=printer_cfg,
            require_tool=False,
            criteria=(
                ("regex", r"#\s*file\s*:\s*printer\.cfg"),
                ("regex", r"\[gcode_macro\s+PARK_HEAD"),
                ("regex", r"probe_count\s*:\s*5,\s*5"),
                ("regex", r"\*\s*\[gcode_macro\s+RESET_ACCEL\]"),
                # Unwanted-content gate: the reply must not contain real
                # stepper section content (i.e. it did not dump/re-edit
                # unrelated sections).
                ("not_contains", "[stepper_x]\nstep_pin"),
            ),
        ),
        TestQuestion(
            qid="TRIDENT-14",
            title="Fix issue in a real config section",
            text=("The provided printer.cfg fails to load — the [printer] "
                  "section has an invalid kinematics value. Find the invalid "
                  "value and return the corrected [printer] section in a fenced "
                  "cfg code block with a '# file: printer.cfg' hint line."),
            # Real Trident printer.cfg with one planted bug: kinematics
            # corexy -> coresy in [printer]. On-disk file untouched.
            context_files=_context_with(_load_kinematics_bugged_printer_cfg()),
            expected_tools=("validate_klipper_config",),
            require_tool=False,
            criteria=(
                ("regex", r"#\s*file\s*:\s*printer\.cfg"),
                ("regex", r"\[printer\]"),
                ("regex", r"kinematics\s*:\s*corexy"),
                ("not_contains", "coresy"),
            ),
        ),
    ]


_MEMORY_CONFIG_SNIPPET = """[mcu]
serial: /dev/serial/by-id/usb-Klipper_stm32f446xx_3D002B000E50505734393820-if00

[printer]
kinematics: corexy
max_velocity: 400
max_accel: 5000

[stepper_x]
step_pin: PC2
dir_pin: PB9
enable_pin: PC3
microsteps: 16
rotation_distance: 40

[probe]
pin: PA1
x_offset: 0
y_offset: 20
z_offset: 2.0
"""


def build_memory_questions() -> list[TestQuestion]:
    """Questions that exercise the printer-memory auto-fill path.
    The backend only injects the auto-fill prompt when printer memory is
    blank, so these run after the harness blanks memory (backed up first,
    restored after the run). Success = a valid fenced `printer-memory` JSON
    block with only the 7 allowed fields, plus correct field values.
    """
    return [
        TestQuestion(
            qid="MEMORY-01",
            title="Printer memory: derive from config",
            text=("Here is my printer config. Fill in the printer memory profile from it.\n\n"
                  + _MEMORY_CONFIG_SNIPPET),
            expected_tools=("detect_board", "search_klipper_docs",
                            "get_config_reference_section", "search_example_configs",
                            "read_example_config"),
            require_tool=False,
            criteria=(
                ("memory_block", ""),
                ("memory_valid", ""),
                ("memory_has", "kinematics:corexy"),
                ("memory_has", "mainboard:stm32|f446|octopus|mcu|board"),
            ),
        ),
        TestQuestion(
            qid="MEMORY-02",
            title="Printer memory: stated facts",
            text=("My printer is a Voron Trident with a Fysetc Spider mainboard, an EBBCan "
                  "toolhead board, CoreXY kinematics, and a Voron Tap probe. "
                  "Fill in my printer memory."),
            expected_tools=(),
            require_tool=False,
            criteria=(
                ("memory_block", ""),
                ("memory_valid", ""),
                ("memory_has", "printerName:trident"),
                ("memory_has", "mainboard:spider"),
                ("memory_has", "kinematics:corexy"),
                ("memory_has", "probe:tap"),
            ),
        ),
        TestQuestion(
            qid="MEMORY-03",
            title="Printer memory: tool-driven fill",
            text=("I have an EBB36 toolhead board, a BIGTREETECH Octopus Pro mainboard, "
                  "CoreXY kinematics, and a Voron Tap probe. Fill in my printer memory — "
                  "use the bundled tools to confirm the hardware details."),
            expected_tools=("search_example_configs", "read_example_config",
                            "search_klipper_docs", "get_config_reference_section",
                            "detect_board"),
            require_tool=False,
            criteria=(
                ("memory_block", ""),
                ("memory_valid", ""),
                ("memory_has", "toolheadBoard:ebb"),
                ("memory_has", "mainboard:octopus"),
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

# ── Printer memory (REQ-AI-08) ────────────────────────────────────────
PRINTER_MEMORY_BLOCK_RE = re.compile(r"```printer-memory\s*\n(.+?)\n```", re.DOTALL)
ALLOWED_MEMORY_FIELDS = (
    "mainboard",
    "toolheadBoard",
    "expanderBoards",
    "printerName",
    "kinematics",
    "probe",
    "additionalNotes",
)


def extract_printer_memory(content: str) -> tuple[str, dict | None]:
    """Extract a fenced ```printer-memory block.
    Returns (block_text, parsed dict) or ("", None) when absent/invalid.
    """
    m = PRINTER_MEMORY_BLOCK_RE.search(content)
    if not m:
        return "", None
    block = m.group(1).strip()
    try:
        data = json.loads(block)
    except json.JSONDecodeError:
        return block, None
    if not isinstance(data, dict):
        return block, None
    return block, data


# ── Evaluation ─────────────────────────────────────────────────────────
def criterion_ok(kind: str, value: str, content: str,
                 memory: tuple[str, dict | None] | None = None) -> bool:
    if kind == "contains":
        return value.lower() in content.lower()
    if kind == "not_contains":
        return value.lower() not in content.lower()
    if kind == "regex":
        return re.search(value, content, re.IGNORECASE | re.DOTALL) is not None
    if kind == "memory_block":
        return bool(memory and memory[0])
    if kind == "memory_valid":
        if not memory or memory[1] is None:
            return False
        data = memory[1]
        keys_ok = all(k in ALLOWED_MEMORY_FIELDS for k in data)
        has_value = any(str(v).strip() for v in data.values())
        return keys_ok and has_value
    if kind == "memory_has":
        if not memory or memory[1] is None:
            return False
        field, _, pattern = value.partition(":")
        if field not in memory[1]:
            return False
        return re.search(pattern, str(memory[1].get(field, "")), re.IGNORECASE) is not None
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


def http_post_json(url: str, payload: dict, timeout: float, method: str = "POST") -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method=method,
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _build_chat_messages(question: TestQuestion) -> list[dict]:
    """Build the /ai/chat messages for a question.

    When the question carries real config files (context_files), they are
    attached as system messages in the same format the frontend uses
    (``label: filename`` + fenced cfg block), followed by the frontend's
    file-targeting instruction so the model returns draft cfg blocks with
    ``# file: <filename>`` hints. Files are only attached as context —
    the chat endpoint never writes them.
    """
    messages: list[dict] = []
    for filename, label, content in question.context_files:
        messages.append({
            "role": "system",
            "content": f"{label}: {filename}\n\n```cfg\n{content}\n```",
        })
    if question.context_files:
        primary = question.context_files[0][0]
        messages.append({
            "role": "system",
            "content": (
                f"Unless the user names a different file, apply edits to {primary}. "
                "Return only changed, new, or deleted sections in a fenced cfg "
                "code block. "
                "Start each block with a '# file: <filename>' hint line when "
                "targeting a specific file. To create a new file, use "
                "'# file: <newfilename>'. Do not return the whole file unless "
                "the user explicitly asks for a full replacement."
            ),
        })
    messages.append({"role": "user", "content": question.text})
    return messages


def chat_request(base_url: str, question: TestQuestion, settings: dict,
                 timeout: float) -> tuple[dict | None, str]:
    """POST one fresh chat dialog to /ai/chat.

    Returns (response_dict, error_string). Exactly one is set.
    """
    request_id = f"accuracy-{question.qid}-{int(time.time())}"
    payload = {
        "messages": _build_chat_messages(question),
        "apiKey": settings["api_key"],
        "model": settings["model"],
        "apiUrl": settings["api_url"],
        "apiProvider": settings["provider"],
        "requestId": request_id,
        "maxTokens": settings["max_tokens"],
        "temperature": settings["temperature"],
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


# ── Printer memory helpers (backup / blank / restore via the real API) ─
def get_printer_memory(base_url: str) -> dict:
    return http_get_json(base_url.rstrip("/") + "/api/printer-memory", timeout=15)


def put_printer_memory(base_url: str, memory: dict) -> dict:
    return http_post_json(base_url.rstrip("/") + "/api/printer-memory", memory,
                          timeout=15, method="PUT")


def blank_printer_memory(base_url: str) -> dict:
    """Back up the current memory, blank it via the API, return the backup."""
    backup = get_printer_memory(base_url)
    put_printer_memory(base_url, {})
    return backup


def restore_printer_memory(base_url: str, backup: dict) -> None:
    put_printer_memory(base_url, backup)


def run_one_question(
    q: TestQuestion,
    settings: dict,
    args: argparse.Namespace,
    log: TestLog,
    base_url: str,
) -> QuestionResult:
    """Run one fresh-chat question, log every step, and evaluate it."""
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
    if q.context_files:
        log.write("Context files attached (read-only, never modified):")
        for name, label, content in q.context_files:
            log.write(f"  {name} [{label}] ({len(content)} chars)")
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

            # Answer check (memory criteria get the parsed printer-memory block)
            memory = extract_printer_memory(result.response)
            for kind, value in q.criteria:
                ok = criterion_ok(kind, value, result.response, memory=memory)
                result.checks.append((kind, value, ok))
            result.answer_ok = all(ok for _, _, ok in result.checks)
            result.status = "PASS" if (result.answer_ok and result.tool_ok) else "FAIL"

            if q.qid.startswith("MEMORY"):
                block, parsed = memory
                log.write(f"Printer memory block ({len(block)} chars):")
                log.write(block[:600] if block else "(no printer-memory block)")
                log.write(f"Parsed: {json.dumps(parsed, indent=2) if parsed else 'invalid/absent'}")

            log.write(f"Tool check: {'PASS' if result.tool_ok else 'FAIL'} "
                      f"(used={sorted(used)} expected={sorted(expected)})")
            for kind, value, ok in result.checks:
                log.write(f"  criterion {kind} {value!r}: {'PASS' if ok else 'FAIL'}")
            log.write(f"OVERALL: {result.status}")
            print(result.status, flush=True)

    return result


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
    temperature = (
        args.temperature if args.temperature is not None
        else float(_prompt("Temperature", "0.7"))
    )
    base_url = args.base_url or _prompt("Backend base URL", "http://localhost:8099")

    return {
        "provider": provider,
        "model": model,
        "api_key": api_key,
        "api_url": api_url,
        "max_tokens": int(max_tokens),
        "temperature": float(temperature),
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
    parser.add_argument("--temperature", default=None, type=float,
                        help="Sampling temperature 0-2 (default 0.7)")
    parser.add_argument("--questions", default="", help="Subset, e.g. '1-5,8' (1-based)")
    parser.add_argument("--start", default=0, type=int,
                        help="Start at question N (1-based), running N..end. "
                             "Ignored when --questions is set.")
    parser.add_argument("--list-questions", action="store_true",
                        help="Print the question bank and exit")
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR),
                        help="Directory for the log and results JSON")
    parser.add_argument("--timeout", default=600, type=float,
                        help="Per-request timeout in seconds")
    parser.add_argument("--include-memory", action="store_true",
                        help="Also test printer-memory auto-fill: back up the backend's "
                             "printer memory, blank it, run MEMORY-01..03, then restore it")
    args = parser.parse_args()

    questions = build_questions() + build_macro_questions() + build_trident_questions()
    if args.include_memory:
        questions += build_memory_questions()
    if args.list_questions:
        print(f"{'QID':<5} {'TOOLS':<45} TITLE")
        print("-" * 100)
        for q in questions:
            tools = ",".join(q.expected_tools) if q.expected_tools else "(any/none)"
            print(f"{q.qid:<5} {tools:<45} {q.title}")
        return 0

    # Validate --start before any interactive prompts so bad values fail fast.
    if args.start and not args.questions and (args.start < 1 or args.start > len(questions)):
        parser.error(f"--start must be between 1 and {len(questions)}")

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

    if args.questions:
        selected = parse_question_filter(args.questions, len(questions))
    elif args.start:
        selected = list(range(args.start - 1, len(questions)))
    else:
        selected = list(range(len(questions)))
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

    memory_backup: dict | None = None
    try:
        for idx in selected:
            q = questions[idx]
            # Blank printer memory right before the MEMORY questions so the
            # backend injects the auto-fill prompt (fresh chats pick it up).
            if args.include_memory and q.qid.startswith("MEMORY") and memory_backup is None:
                memory_backup = blank_printer_memory(base_url)
                log.section("PRINTER MEMORY TEST SETUP")
                log.write(f"Backed up current printer memory ({len(memory_backup)} fields) "
                          f"and blanked it to trigger the auto-fill prompt.")
                log.write("The original memory is restored after the run.")
                print(f"\n[printer-memory] backed up {len(memory_backup)} fields, blanked "
                      f"for {q.qid}+ (restored after run)")
            results.append(run_one_question(q, settings, args, log, base_url))
    finally:
        if memory_backup is not None:
            try:
                restore_printer_memory(base_url, memory_backup)
                log.write(f"\n[restore] printer memory restored: {json.dumps(memory_backup)}")
                print(f"\n[printer-memory] restored original memory "
                      f"({len(memory_backup)} fields)")
            except Exception as exc:  # noqa: BLE001
                msg = (f"\n[restore FAILED] printer memory was NOT restored! Restore manually "
                       f"via PUT /api/printer-memory with: {json.dumps(memory_backup)} "
                       f"Error: {exc}")
                log.write(msg)
                print(msg, file=sys.stderr)

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

    raw_used = {t for r in results for t in r.tool_names}
    exercised = raw_used & set(ALL_TOOLS)
    unknown_attempts = sorted(raw_used - set(ALL_TOOLS))
    missing = [t for t in ALL_TOOLS if t not in exercised]
    log.write("")
    log.write(f"Tools exercised ({len(exercised)}/{len(ALL_TOOLS)}): "
              f"{', '.join(sorted(exercised)) or '(none)'}")
    if unknown_attempts:
        log.write(f"Unknown tool names attempted by model (not real MCP tools): "
                  f"{', '.join(unknown_attempts)}")
    if missing:
        log.write(f"Tools NEVER used: {', '.join(missing)}")

    # Machine-readable copy
    with open(results_path, "w", encoding="utf-8") as fh:
        json.dump({
            "run_at": datetime.now().isoformat(),
            "settings": log_settings,
            "results": [vars(r) for r in results],
            "tools_exercised": sorted(exercised),
            "unknown_tool_attempts": unknown_attempts,
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
    if unknown_attempts:
        print(f"Unknown tool attempts (not real MCP tools): {', '.join(unknown_attempts)}")
    if missing:
        print(f"Tools NEVER used: {', '.join(missing)}")
    print(f"\nFull log: {log_path}")
    print(f"Machine-readable: {results_path}")
    return 0 if not failed and not errored else 2


if __name__ == "__main__":
    sys.exit(main())
