"""Klipper Wire Configurator - AI Chat Backend Proxy"""
import asyncio
import json
import logging
import os
from enum import Enum
from pathlib import Path
import re
from urllib.parse import urlparse, urlunparse

import httpx
from fastapi import APIRouter
from pydantic import BaseModel

from api.printer_memory_routes import (
    load_printer_memory,
    printer_memory_to_context,
    is_printer_memory_blank,
)
from mcp_server import McpServer, get_index

router = APIRouter()

# ── Logging ────────────────────────────────────────────────────────────
logger = logging.getLogger("kwc.ai")
logger.setLevel(logging.DEBUG)

BACKEND_DIR = Path(__file__).parent.parent
AI_CHAT_LOG = BACKEND_DIR / "ai_chat.log"

# Add handlers if none exist (avoids duplicate handlers on reload)
if not logger.handlers:
    # Console handler (stdout) for live visibility
    _console_handler = logging.StreamHandler()
    _console_handler.setLevel(logging.DEBUG)
    # File handler for persistent record
    _file_handler = logging.FileHandler(AI_CHAT_LOG, mode="a", encoding="utf-8")
    _file_handler.setLevel(logging.DEBUG)
    _formatter = logging.Formatter(
        "%(asctime)s [AI %(levelname)s] %(message)s",
        datefmt="%H:%M:%S",
    )
    _console_handler.setFormatter(_formatter)
    _file_handler.setFormatter(_formatter)
    logger.addHandler(_console_handler)
    logger.addHandler(_file_handler)
    # Prevent propagating to root logger's handlers (avoid double output)
    logger.propagate = False


# ── Embedded MCP server for tool access ──
_mcp_server = McpServer()

# Match fenced code blocks tagged ```tool ... ```
# Captures the JSON payload which we parse with json.loads
MCP_TOOL_BLOCK_RE = re.compile(
    r"```tool\s*\n(.+?)\n```",
    re.DOTALL,
)
# A fenced ```printer-memory block signals a complete structured proposal —
# the auto-search fallback must not fire when the model returns one.
PRINTER_MEMORY_BLOCK_RE = re.compile(r"```printer-memory\s*\n", re.DOTALL)
# Alternative tool call formats emitted by models that use native
# function-calling special tokens instead of the fenced ```tool block.
# This matches <|tool_call|>, <tool_call>, and similar wrappers around
# JSON or natural-language tool call text.
# Note: \n is included as a boundary so the regex doesn't eat text
# that follows the tool call on subsequent lines.
ALT_TOOL_CALL_CONTENT_RE = re.compile(
    r"<\|?tool_call\|?>\s*(.*?)(?:</?\|?tool_call\|?>|\n|$)",
    re.DOTALL,
)
# Matches "call tool_name{...}" or "tool_name{...}" for non-JSON tool call text.
# Also accepts the llama.cpp/Qwen-style "call:tool_call:tool_name{...}" prefix
# emitted inside <|tool_call|> tokens by models with native tool templates.
CALL_SYNTAX_RE = re.compile(
    r"(?:^|\n)\s*(?:call[\s:]?\s*)?(?:tool_call[\s:]*)?(\w+)\s*\{(.+)\}",
    re.DOTALL,
)
# Matches Python-style "function_name(arg1=\"val1\", arg2=123)" or
# "function_name(arg1: \"val1\")" without curly braces
FUNC_CALL_RE = re.compile(
    r"(?:^|\n)\s*(?:call[\s:]?\s*)?(?:tool_call[\s:]*)?(\w+)\s*\(" +
    r"(.+?)" +
    r"\)\s*(?:\n|$)",
    re.DOTALL,
)
# Cleanup regexes for stripping bare function call text from output.
# These match on line boundaries to avoid mangling prose.
CALL_SYNTAX_CLEANUP_RE = re.compile(
    r"(?:^|\n)\s*(?:call[\s:]?\s*)?(?:tool_call[\s:]*)?\w+\s*\{[^}]*\}\s*(?=\n|$)",
    re.DOTALL,
)
FUNC_CALL_CLEANUP_RE = re.compile(
    r"(?:^|\n)\s*(?:call[\s:]?\s*)?(?:tool_call[\s:]*)?\w+\s*\([^)]*\)\s*(?=\n|$)",
    re.DOTALL,
)


SYSTEM_PROMPT = (
    "You are an expert Klipper firmware, configuration, and macro assistant. "
    "You help users by answering questions, editing configs, and drafting macros "
    "without inventing details.\n\n"
    "Guidelines:\n"
    "1. Keep answers short and focused.\n"
    "2. Prefer minimal targeted edits. Preserve unrelated settings, comments, and file "
    "structure unless the user explicitly asks for a larger refactor.\n"
    "3. Never invent section names, parameter names, defaults, units, commands, or supported "
    "behavior. If the bundled docs or the provided config do not confirm a detail, say so "
    "explicitly.\n"
    "4. If the request depends on unknown printer details (kinematics, probe, MCU, toolhead, "
    "bed size, macros, sensors), ask one short clarifying question unless the provided config "
    "already resolves it. Config content provided in the conversation "
    "(attached files, context sections, or read_user_config results) is "
    "already available to you — never ask the user to re-provide it.\n"
    "5. If a macro changes motion or extrusion state, preserve or restore it unless the user "
    "clearly wants persistent changes.\n"
    "6. If no safe grounded answer is possible, say what must be verified next instead of "
    "guessing.\n\n"
    "Edit protocol:\n"
    "- Before editing or answering about a config file, fetch its current "
    "content with the available tools if it is not already in your context. "
    "Never ask the user to paste content the tools can fetch.\n"
    "- For config edits, return only changed, new, or deleted content in fenced cfg code "
    "blocks. Start each block with a '# file: <filename>' hint line when the target file is "
    "not obvious. Do not return the whole file unless the user explicitly asks for a full "
    "replacement.\n"
    "- To EDIT an existing section, emit a mini-diff: the section header followed by only the "
    "lines that change, prefixing removed lines with '-' and added lines with '+', keeping "
    "their original indentation. The app applies these exact replacements to the current "
    "file — do not reproduce unchanged lines. Example:\n"
    "  [gcode_macro Level_Bed]\n"
    "  -    BED_MESH_CALIBRATE\n"
    "  +    BED_MESH_CALIBRATE ADAPTIVE=1\n"
    "- To ADD a new section, write the full section. To DELETE a section entirely, write "
    "`*[section_name]` on its own line inside the cfg block (* = delete). To comment a "
    "section out, keep it in the file with its header commented out: #[extruder].\n"
    "- For macros: valid Klipper syntax, conservative motion and temperature behavior. With "
    "the mini-diff protocol the unchanged lines are preserved automatically; never drop, "
    "reorder, or reword lines that were not part of the request.\n"
    "- After config or macro code, briefly explain what changed, why, and cite the exact "
    "documentation section header and parameter or command names you relied on.\n"
    "- Klipper G-code commands and macro names (G28, M104, BED_MESH_CALIBRATE, "
    "SET_FAN_SPEED, PRINT_START, etc.) are NOT tools — never wrap them in ```tool blocks.\n"
)


class AiProvider(str, Enum):
    chatgpt = "chatgpt"
    google = "google"
    anthropic = "anthropic"
    github = "github"
    openai_compatible = "openai-compatible"

class ChatRequest(BaseModel):
    messages: list[dict]
    apiKey: str
    model: str = "gpt-4o"
    apiUrl: str = "https://api.openai.com/v1/chat/completions"
    apiProvider: AiProvider = AiProvider.chatgpt
    requestId: str | None = None
    maxTokens: int = 4096
    # Sampling temperature. None = use the provider's default for the
    # request type (0.1 for OpenAI-compatible, Anthropic's default otherwise).
    temperature: float | None = None


class ChatStopRequest(BaseModel):
    requestId: str


class ChatStoppedError(Exception):
    """Raised when the user requests to stop the current AI chat request."""


# Registry of in-flight chat request stop events, keyed by client requestId.
_chat_stop_events: dict[str, asyncio.Event] = {}


@router.post("/ai/chat/stop")
async def chat_stop(req: ChatStopRequest):
    """Signal an in-flight /ai/chat request to stop processing."""
    event = _chat_stop_events.get(req.requestId)
    logger.info(
        "Stop lookup | requestId=%s found=%s registry_size=%d",
        req.requestId, event is not None, len(_chat_stop_events),
    )
    if event is None:
        return {"stopped": False}
    event.set()
    return {"stopped": True}


def _build_reference_lookup_query(messages: list[dict]) -> str:
    """Build a query string from the most recent user messages."""
    recent_user_messages: list[str] = []

    for msg in reversed(messages):
        if msg.get("role") != "user":
            continue

        content = str(msg.get("content", "")).strip()
        if not content:
            continue

        recent_user_messages.append(content)
        if len(recent_user_messages) >= 3:
            break

    if not recent_user_messages:
        return ""

    combined = "\n\n".join(reversed(recent_user_messages))
    if len(combined) <= 1800:
        return combined
    return combined[-1800:]


def _is_local_provider(provider: str, api_url: str = "") -> bool:
    """Check if the provider is a local server (OpenAI Compatible).

    OpenAI-compatible endpoints on plain http are local servers (LM Studio,
    Ollama, llama.cpp on the LAN): auth optional, text-based ```tool
    protocol. https endpoints are cloud OpenAI-compatible APIs (DeepSeek,
    OpenRouter, Groq, ...): they get the cloud treatment — required API key
    and native function calling.
    """
    if provider != "openai-compatible":
        return False
    return not api_url.strip().lower().startswith("https://")


def _get_openai_compatible_default_url(provider: str) -> str:
    """Get the default API URL for an OpenAI-compatible provider."""
    defaults = {
        "chatgpt": "https://api.openai.com/v1/chat/completions",
        "google": "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
        "openai-compatible": "http://localhost:11434/api/chat",
    }
    return defaults.get(provider, "")


def _prepare_messages(messages: list[dict]) -> list[dict]:
    """Build a clean system prompt with MCP tool descriptions, printer memory,
    and user messages.
    """
    # ── Inject printer memory context ──
    memory = load_printer_memory()
    memory_context = printer_memory_to_context(memory)

    system_parts = [SYSTEM_PROMPT, _build_mcp_tool_context(), memory_context]

    # If printer memory is completely blank and there are user messages to work with,
    # add an auto-fill instruction asking the AI to investigate.
    if is_printer_memory_blank(memory):
        auto_fill_prompt = (
            "\n---\n"
            "**Printer Memory Auto-Fill**\n\n"
            "The printer memory above is blank. Fill it in using the config files and tools below:\n"
            "1. Examine the user's config files passed as context for clues about the mainboard, "
            "toolhead board, kinematics, probe type, etc.\n"
            "2. Use `search_example_configs` with board/printer/MCU keywords from the config, then "
            "`read_example_config` on the best matches. Use `search_klipper_docs` and "
            "`get_config_reference_section` to confirm details. Correlate with "
            "the user's config — e.g. a Voron 2.4 usually uses CoreXY kinematics.\n"
            "3. For any field you cannot determine, ask the user to provide it.\n"
            "4. Return your proposal in a fenced `printer-memory` code block containing ONLY valid "
            "JSON — no surrounding explanation or markdown inside the block. Only these 7 fields "
            "are allowed; unsupported fields will be rejected: mainboard, toolheadBoard, "
            "expanderBoards, printerName, kinematics, probe, additionalNotes.\n"
            "   ```printer-memory\n"
            "   {\"mainboard\": \"BTT Octopus Pro v1.1\", \"kinematics\": \"CoreXY\"}\n"
            "   ```\n"
            "The user confirms in a review dialog before anything is saved — do NOT save printer "
            "memory directly."
        )
        system_parts.append(auto_fill_prompt)

    prepared: list[dict] = []
    for msg in messages:
        role = msg.get("role")
        content = str(msg.get("content", "")).strip()
        if role not in {"system", "user", "assistant"} or not content:
            continue
        if role == "system":
            if content != SYSTEM_PROMPT:
                system_parts.append(content)
            continue
        prepared.append({"role": role, "content": content})

    system_text = "\n\n".join(system_parts)
    logger.debug(
        "Prepared messages | system=%d chars user_msgs=%d printer_memory_blank=%s",
        len(system_text), len(prepared), is_printer_memory_blank(memory)
    )

    # Task anchor: with a long conversation the model can mistake an earlier
    # question for the current one. A trailing system message explicitly points
    # it at the LAST user message so it stays on task. Anthropic's payload
    # builder merges every system message (see _build_provider_payload), so the
    # anchor also survives there.
    task_anchor = (
        "Your current task is the user's latest (last) message in this conversation. "
        "Earlier messages are history and context only."
    )
    if prepared:
        return [
            {"role": "system", "content": system_text},
            *prepared,
            {"role": "system", "content": task_anchor},
        ]
    return [{"role": "system", "content": system_text}] + prepared


# ── MCP Tool Integration ───────────────────────────────────────────


def _build_mcp_tool_context() -> str:
    """Build a compact 'Available Tools' section for the system prompt.

    Only the tools the model should actively choose are advertised, each as a
    one-line snippet (the same pattern Pi/coding agents use — full schemas
    stay in the registered tool set for the executor and native function
    calling). Tools not listed here remain registered and callable, but the
    model is not nudged toward them, which keeps attention on the tools that
    matter for the current task.

    Visible: docs search/read, Config_Reference, user config read, example
    config search/read, and the two validators.
    Hidden (registered, not advertised): search_user_configs,
      list_klipper_docs, get_section_schema, detect_board,
      calculate_rotation_distance, generate_macro_template.
    """
    snippets: dict[str, str] = {
        "search_klipper_docs": "Search the bundled Klipper docs",
        "read_klipper_doc": "Read a bundled Klipper doc file",
        "get_config_reference_section": "Get the Config_Reference section and valid params for a config section (pass section_name, e.g. section_name='bed_mesh')",
        "read_user_config": (
            "Read a user config file (filename='printer.cfg', optional "
            "section='extruder' for one section). Call FIRST when the user "
            "names a config file to edit or inspect."
        ),
        "search_example_configs": "Search example configs by board or printer",
        "read_example_config": "Read a full example config file",
        "validate_klipper_config": "Validate a config snippet with Klipper rules",
        "validate_macro": "Validate a macro draft with Klipper's Jinja rules",
    }

    parts = [
        "# Available Tools",
        "",
        "Use these tools proactively. They are how you access the user's "
        "configs, the bundled Klipper docs, and validation. Before asking "
        "the user for information, prefer a tool that can fetch or verify "
        "it — read_user_config for config files, search_klipper_docs or "
        "get_config_reference_section for docs, validate_klipper_config / "
        "validate_macro for drafts. Do not guess when a tool can answer.",
        "",
        "Text format (used by providers without native function calling): put a JSON ",
        "code block tagged `tool` in your reply:",
        "",
        "```tool",
        """{"name": "tool_name", "arguments": {"key": "value"}}""",
        "```",
        "",
        "The tool runs and the result is returned as a follow-up message — use it to answer.",
        "",
        "Tools:",
    ]
    for name, snippet in snippets.items():
        parts.append(f"- {name}: {snippet}")
    parts.append("")
    parts.append(
        "Klipper G-code commands and macro names (e.g. G28, M104, BED_MESH_CALIBRATE, "
        "SET_FAN_SPEED, PRINT_START) are NOT tools — never wrap them in tool blocks."
    )

    return "\n".join(parts)


# ── Auto-search fallback ────────────────────────────────────────────

AUTO_SEARCH_FALLBACK_MAX_CHARS = 4000

# Phase 3: auto-search injects docs only for question-type requests. Edit
# requests are answered from the attached config context; injecting docs
# mid-edit derails drafts (models regenerate macros lossily under the extra
# load — verified 2026-08 on gemma-4-12b/qwen3.5-9b).
_EDIT_VERB_RE = re.compile(
    r"\b(?:change|update|modify|edit|add|remove|delete|fix|create|set|rename|"
    r"enable|disable|tweak|adjust|comment\s*out|calibrat\w*)\b",
    re.IGNORECASE,
)
_EDIT_TARGET_RE = re.compile(
    r"\[[^\]]+\]|\bmacros?\b|\bsection\b|\.cfg\b|"
    r"\b(?:max_accel|max_velocity|serial|pin|probe|bed_mesh|kinematics|"
    r"steps_per_mm|rotation_distance|z_offset|nozzle|extruder|heater|fan)\b",
    re.IGNORECASE,
)


def _is_edit_request(messages: list[dict]) -> bool:
    """Heuristic: does the latest user message ask for config/macro changes?

    Mirrors the frontend's detectChatIntent (chatIntent.ts): an edit verb AND
    a config-ish target. Only the LATEST user message decides — a follow-up
    question after an edit must not be gated. Validation/retry feedback also
    matches ('fixes ... cfg'), which is fine: auto-search is not useful during
    draft repair either.
    """
    for msg in reversed(messages):
        if msg.get("role") != "user":
            continue
        content = str(msg.get("content", "")).strip()
        if not content:
            continue
        return bool(_EDIT_VERB_RE.search(content) and _EDIT_TARGET_RE.search(content))
    return False


def _auto_search_enabled() -> bool:
    """Auto-search fallback toggle (env KWC_AUTO_SEARCH=1 re-enables it).

    Defaults to DISABLED. Harness A/B (2026-08, gemma-4-12b, Q01-Q20,
    19/19 both ways): with the compact prompt the model calls the docs tools
    itself on every grounding question, and the fallback only injects content
    the model didn't ask for (visible as phantom search_klipper_docs tool
    names on knowledge-answerable questions). Smaller local models
    (gemma-4-e2b, qwen3.5-4b) call tools less reliably — set
    KWC_AUTO_SEARCH=1 for them until their A/B says otherwise.
    """
    return os.environ.get("KWC_AUTO_SEARCH", "0") != "0"


def _auto_search_context(query: str) -> str | None:
    """Search Klipper docs using the MCP index and return a concise context block.

    Used as a fallback when the model doesn't call tools on its own.
    Returns a tool-result-style string with snippets, or None if no results.
    """
    index = get_index()
    if not index.is_ready():
        return None

    results = index.search(query, limit=3)
    if not results:
        return None

    parts: list[str] = []
    total = 0
    for r in results:
        snippet = r["snippet"]
        header = f"From {r['filename']} (score {r['score']}):\n"
        block = header + snippet
        if total + len(block) > AUTO_SEARCH_FALLBACK_MAX_CHARS:
            break
        parts.append(block)
        total += len(block)

    if not parts:
        return None

    return "\n\n---\n\n".join(parts)


def _extract_tool_calls(text: str) -> list[dict]:
    """Extract tool call JSON blocks from a model's response text.

    Handles several formats:
      1. ```tool
         {"name": "...", "arguments": {...}}
         ```
      2. <|tool_call|>{"name": "...", "arguments": {...}} or
         <|tool_call|> call name{arg1="val1", arg2="val2"}
         (native function-calling token from DeepSeek, Llama 3.1+, Qwen, etc.)
      3. name(arg1="val1", arg2=123)
         (Python-style function call without wrapper tokens)
    """
    calls: list[dict] = []
    seen_contents: set[str] = set()

    # Format 1: standard fenced ```tool block
    for match in MCP_TOOL_BLOCK_RE.finditer(text):
        raw_json = match.group(1).strip()
        if not raw_json or raw_json in seen_contents:
            continue
        seen_contents.add(raw_json)
        try:
            parsed = json.loads(raw_json)
        except json.JSONDecodeError:
            continue
        if not isinstance(parsed, dict):
            continue
        name = parsed.get("name", "")
        arguments = parsed.get("arguments", {})
        if name and isinstance(arguments, dict):
            calls.append({"name": name, "arguments": arguments})

    # Format 2: <|tool_call|> or <tool_call> native tokens
    for match in ALT_TOOL_CALL_CONTENT_RE.finditer(text):
        content = match.group(1).strip()
        if not content or content in seen_contents:
            continue
        seen_contents.add(content)

        # Try parsing as JSON first
        parsed: dict | None = None
        try:
            parsed = json.loads(content)
        except json.JSONDecodeError:
            pass

        if isinstance(parsed, dict):
            name = parsed.get("name", "")
            arguments = parsed.get("arguments", {})
            if name and isinstance(arguments, dict):
                calls.append({"name": name, "arguments": arguments})
                continue

        # Try parsing "call name{...}" or "name{...}" syntax
        call_match = CALL_SYNTAX_RE.match(content)
        if call_match:
            name = call_match.group(1)
            args_text = call_match.group(2)
            if name:
                recovered = _recover_tool_call(name, args_text)
                if recovered:
                    calls.append({"name": recovered[0], "arguments": recovered[1]})
                    continue
                arguments = _parse_kwargs(args_text)
                calls.append({"name": name, "arguments": arguments})
                continue

        # Try parsing multi-line YAML-style: call:name\nkey: val\nkey2: val2
        # (used by some Gemma variants)
        # ALT_TOOL_CALL_CONTENT_RE only captured first line, so read rest
        # of the tool call from the original text starting after the match.
        name_match = re.match(r"(?:call[\s:]?\s*)?(?:tool_call[\s:]*)?(\w+)", content)
        if name_match and name_match.group(1):
            tool_name = name_match.group(1)
            # Scan subsequent lines in original text for key:value pairs
            remaining = text[match.end():]
            arguments = {}
            for line in remaining.split("\n"):
                line = line.strip()
                if not line:
                    break  # blank line = end of tool call
                kv_match = re.match(r"(\w+)\s*[:=]\s*(.+)", line)
                if kv_match:
                    key = kv_match.group(1)
                    val = kv_match.group(2).strip().strip('"').strip("'")
                    arguments[key] = val
                else:
                    break  # non-key:value line = end of tool call
            if arguments:
                calls.append({"name": tool_name, "arguments": arguments})

    # Format 3: Python-style name(arg1="val1", arg2=123) (no wrapper tokens)
    # This is checked on the full text, not inside a tag wrapper.
    for match in FUNC_CALL_RE.finditer(text):
        content = match.group(0).strip()
        if not content or content in seen_contents:
            continue
        seen_contents.add(content)
        name = match.group(1)
        args_text = match.group(2) if match.lastindex and match.lastindex >= 2 else ""
        if name:
            arguments = _parse_kwargs(args_text)
            calls.append({"name": name, "arguments": arguments})

    # Format 4: name{args} or call name{args} (no wrapper tokens)
    # Checked on the full text, not inside a tag wrapper.
    for match in CALL_SYNTAX_RE.finditer(text):
        content = match.group(0).strip()
        if not content or content in seen_contents:
            continue
        seen_contents.add(content)
        name = match.group(1)
        args_text = match.group(2)
        if name:
            recovered = _recover_tool_call(name, args_text)
            if recovered:
                calls.append({"name": recovered[0], "arguments": recovered[1]})
                continue
            arguments = _parse_kwargs(args_text)
            calls.append({"name": name, "arguments": arguments})

    if calls:
        names = [c["name"] for c in calls]
        logger.debug("Extracted %d tool call(s): %s", len(calls), names)
    return calls


def _parse_kwargs(args_text: str) -> dict:
    """Parse keyword arguments from text like 'arg1=\"val1\", arg2=123, key=\"value\"'.

    Handles both colon and equals separators, quoted and unquoted values.
    """
    arguments: dict = {}
    for arg_match in re.finditer(
        r"(\w+)\s*[=:]\s*(.+?)(?:,\s*(?=\w+\s*[=:])|$)",
        args_text,
    ):
        arg_name = arg_match.group(1)
        arg_value = arg_match.group(2).strip().strip('"').strip("'")
        arguments[arg_name] = arg_value
    return arguments


# llama.cpp/Gemma text-protocol templates wrap tool calls in decoration
# tokens where the visible name is NOT the tool name:
#   call:tool{"name": "...", "arguments": {...}}   <- real name in JSON body
#   call:tool_use_search_klipper_docs{query: ...}  <- real name in the token
#   tool\n{"name": "...", "arguments": {...}}      <- bare 'tool' token
# The generic parser sees name='tool' / 'tool_use_<NAME>' and the calls get
# discarded by the hallucinated-tool guard, leaving an empty response. Recover
# the real name before that guard runs.
_TOOL_DECORATION_RE = re.compile(r"tool_(?:use|call)_(.+)")


def _recover_tool_call(token: str, args_text: str) -> tuple[str, dict] | None:
    """Recover (name, arguments) from a decorated tool-call token.

    Returns None when the token is a plain tool name — the caller then falls
    back to the generic extraction.
    """
    # 1) The args body is JSON with explicit name + arguments. The generic
    #    CALL_SYNTAX_RE strips the outer braces, so try the fragment both
    #    bare and re-wrapped.
    for candidate in (args_text, "{" + args_text + "}"):
        try:
            parsed = json.loads(candidate)
        except (json.JSONDecodeError, TypeError):
            continue
        if isinstance(parsed, dict):
            name = parsed.get("name")
            arguments = parsed.get("arguments")
            if isinstance(name, str) and name and isinstance(arguments, dict):
                return name, arguments
            break
    # 2) The token embeds the name: tool_use_<NAME> / tool_call_<NAME>.
    m = _TOOL_DECORATION_RE.match(token)
    if m:
        return m.group(1), _parse_kwargs(args_text)
    return None


def _execute_tool_call(tool_call: dict) -> str:
    """Execute a single MCP tool call and return the text result."""
    name = tool_call.get("name", "")
    arguments = tool_call.get("arguments", {})

    # Build a JSON-RPC request for the tool
    request = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": name,
            "arguments": arguments,
        },
    }

    response = _mcp_server.handle_jsonrpc(request)
    if response is None:
        return f"Error: Tool '{name}' returned no result."

    error = response.get("error")
    if error:
        return f"Error calling tool '{name}': {error.get('message', 'Unknown error')}"

    result = response.get("result", {})
    content = result.get("content", [])
    text_parts = [
        item["text"] for item in content if item.get("type") == "text"
    ]
    return "\n\n".join(text_parts) if text_parts else "Tool returned no content."


def _build_tool_result_message(tool_call: dict, result_text: str) -> str:
    """Build a user-role message containing the tool result for re-prompting."""
    name = tool_call.get("name", "unknown")
    args = tool_call.get("arguments", {})
    args_summary = ", ".join(f"{k}={v}" for k, v in args.items())
    return (
        f"[Tool result: {name}({args_summary})]\n\n"
        f"{result_text}\n\n"
        "[End tool result. Use this information to answer the user's latest (last) request above. "
        "Earlier messages are history and context. Do not repeat the tool call.]"
    )


MAX_MCP_TOOL_TURNS = 5
# When a model ends its turn with only a tool call and no visible text
# (tool-loop exhaustion, an unparseable call format, or a final tool-only
# response), re-prompt it without tools to force a direct text answer.
EMPTY_REPROMPT_LIMIT = 2
# Reasoning-enabled local builds (llama.cpp --reasoning-budget) spend part of
# the completion budget on hidden tokens that never become visible content.
# A low max_tokens can exhaust the whole budget invisibly and come back
# empty with finish_reason=length. When re-prompting, give local providers
# at least this much room so the hidden prefix + the real answer both fit.
EMPTY_REPROMPT_MAX_TOKENS = 4096


def _collect_tool_names(messages: list[dict]) -> list[str]:
    """Extract unique tool names from tool result messages in the conversation."""
    names: list[str] = []
    seen: set[str] = set()
    for msg in messages:
        content = str(msg.get("content", ""))
        m = re.search(r"\[Tool result: (\w+)\(", content)
        if m:
            name = m.group(1)
            if name not in seen:
                seen.add(name)
                names.append(name)
    return names


def _build_native_tools() -> list[dict]:
    """Build native function-calling tool definitions from the MCP server.

    Returns OpenAI-style tool objects:
        {"type": "function", "function": {"name", "description", "parameters"}}
    """
    native: list[dict] = []
    for tool in _mcp_server._list_tools():
        native.append({
            "type": "function",
            "function": {
                "name": tool["name"],
                "description": tool.get("description", "").replace("\n", " "),
                "parameters": tool.get("inputSchema", {"type": "object", "properties": {}}),
            },
        })
    return native


def _extract_native_tool_calls(provider: str, data: dict) -> list[dict] | None:
    """Extract structured tool calls from a provider response.

    Handles native function-calling responses:
      - OpenAI-compatible: choices[0].message.tool_calls
      - Anthropic: content blocks with type == "tool_use"

    Returns a list of {"name", "arguments", "id"} or None when the response
    contains no native tool calls (plain text or text ```tool blocks).
    """
    try:
        if provider == "anthropic":
            blocks = data.get("content")
            if not isinstance(blocks, list):
                return None
            calls: list[dict] = []
            for block in blocks:
                if isinstance(block, dict) and block.get("type") == "tool_use":
                    calls.append({
                        "name": block.get("name", ""),
                        "arguments": block.get("input", {}) or {},
                        "id": block.get("id", ""),
                    })
            return calls or None

        message = data.get("choices", [{}])[0].get("message", {})
        raw_calls = message.get("tool_calls")
        if not raw_calls:
            return None
        calls = []
        for raw in raw_calls:
            if not isinstance(raw, dict) or raw.get("type") != "function":
                continue
            function = raw.get("function", {})
            name = function.get("name", "")
            arguments = function.get("arguments", "{}")
            if isinstance(arguments, str):
                try:
                    arguments = json.loads(arguments)
                except json.JSONDecodeError:
                    arguments = {}
            if name:
                calls.append({
                    "name": name,
                    "arguments": arguments,
                    "id": raw.get("id", ""),
                    # Gemini 3.5+ reasoning models attach a thought_signature here;
                    # it MUST be echoed back on the follow-up or Google 400s.
                    "extra_content": raw.get("extra_content"),
                })
        return calls or None
    except Exception:
        return None


def _build_native_tool_followup(
    provider: str,
    assistant_content: str,
    tool_calls: list[dict],
    results: list[str],
) -> list[dict]:
    """Build the messages that continue a native function-calling exchange.

    OpenAI-compatible providers require the assistant message with its
    tool_calls echoed back, followed by one 'tool' message per call.
    Anthropic requires the assistant content blocks (including tool_use)
    echoed back, followed by a single user message with tool_result blocks.

    Returns the list of messages to append to the conversation.
    """
    if provider == "anthropic":
        content_blocks: list[dict] = []
        if assistant_content:
            content_blocks.append({"type": "text", "text": assistant_content})
        for call in tool_calls:
            content_blocks.append({
                "type": "tool_use",
                "id": call.get("id") or f"toolu_{call['name']}",
                "name": call["name"],
                "input": call["arguments"],
            })
        tool_results = [
            {
                "type": "tool_result",
                "tool_use_id": call.get("id") or f"toolu_{call['name']}",
                "content": result,
            }
            for call, result in zip(tool_calls, results)
        ]
        return [
            {"role": "assistant", "content": content_blocks},
            {"role": "user", "content": tool_results},
        ]

    assistant_message: dict = {
        "role": "assistant",
        "content": assistant_content or None,
        "tool_calls": [
            {
                "type": "function",
                "id": call.get("id") or f"call_{index}",
                "function": {
                    "name": call["name"],
                    "arguments": json.dumps(call["arguments"])
                    if isinstance(call["arguments"], dict)
                    else str(call["arguments"]),
                },
                # Gemini 3.5+ requires the thought_signature to be echoed back.
                **({"extra_content": call["extra_content"]} if call.get("extra_content") else {}),
            }
            for index, call in enumerate(tool_calls)
        ],
    }

    tool_messages = [
        {
            "role": "tool",
            "tool_call_id": call.get("id") or f"call_{index}",
            "content": result,
        }
        for index, (call, result) in enumerate(zip(tool_calls, results))
    ]

    return [assistant_message, *tool_messages]


def _build_provider_payload(
    provider: str,
    messages: list[dict],
    model: str,
    max_tokens: int = 4096,
    temperature: float | None = None,
    tools: list[dict] | None = None,
) -> dict:
    """Build the request payload for the given provider.

    Handles Anthropic's separate system field and OpenAI-compatible
    formats with temperature settings. When tools is provided, native
    function-calling tool definitions are included.
    """
    if provider == "anthropic":
        # Anthropic takes a single top-level system field. Merge every system
        # message (main prompt, config context, and the trailing task anchor)
        # instead of keeping only the last one.
        system_parts: list[str] = []
        filtered_messages: list[dict] = []
        for msg in messages:
            if msg["role"] == "system":
                system_parts.append(str(msg["content"]))
            else:
                filtered_messages.append(msg)
        payload: dict = {
            "model": model,
            "messages": filtered_messages,
            "max_tokens": max_tokens,
        }
        if temperature is not None:
            payload["temperature"] = temperature
        if system_parts:
            payload["system"] = "\n\n".join(system_parts)

        if tools:
            # Anthropic expects a flat tool list (no "type" wrapper): each
            # entry carries name/description/input_schema directly.
            payload["tools"] = [
                {
                    "name": tool["function"]["name"],
                    "description": tool["function"].get("description", ""),
                    "input_schema": tool["function"].get("parameters", {"type": "object", "properties": {}}),
                }
                for tool in tools
            ]
    else:
        # OpenAI-compatible chat providers use the standard messages format.
        # Low temperature makes tool call decisions more deterministic;
        # 0.1 is the historical default, overridable per request.
        payload = {
            "model": model,
            "messages": messages,
            "temperature": temperature if temperature is not None else 0.1,
            "max_tokens": max_tokens,
        }
        if tools:
            payload["tools"] = tools

    return payload


async def _query_provider(
    client: httpx.AsyncClient,
    url: str,
    headers: dict,
    payload: dict,
    provider: str,
    logger_context: str | None = None,
    stop_event: asyncio.Event | None = None,
) -> tuple[str, dict]:
    """Send a request to the AI provider and extract the response content.

    Returns:
        (content, data) where content is the extracted text and data is
        the full JSON response for further inspection.

    Raises:
        ChatStoppedError: If the user requested a stop via stop_event.
        ValueError: If the API returned an error in the response body.
        httpx.TimeoutException: On request timeout.
        httpx.HTTPError: On HTTP-level errors.
    """
    if stop_event is not None and stop_event.is_set():
        raise ChatStoppedError()

    context = logger_context or "main"
    logger.info(
        "Querying provider | url=%s msgs=%d chars=%d context=%s",
        url,
        len(payload.get("messages", [])),
        sum(len(str(m.get("content", ""))) for m in payload.get("messages", [])),
        context,
    )

    if stop_event is not None:
        # Race the provider request against the stop event so a user stop
        # cancels the in-flight request instead of waiting for it to finish.
        query_task = asyncio.create_task(client.post(url, headers=headers, json=payload))
        stop_task = asyncio.create_task(stop_event.wait())
        done, _pending = await asyncio.wait(
            {query_task, stop_task},
            return_when=asyncio.FIRST_COMPLETED,
        )
        if stop_task in done:
            query_task.cancel()
            stop_task.cancel()
            raise ChatStoppedError()
        stop_task.cancel()
        resp = await query_task
    else:
        resp = await client.post(url, headers=headers, json=payload)

    resp.raise_for_status()
    data = resp.json()

    error_message = _extract_api_error_message(data)
    if error_message:
        logger.error("Provider returned error | %s context=%s", error_message, context)
        raise ValueError(error_message)

    content = _extract_provider_content(provider, data) or ""

    logger.info(
        "Provider response | chars=%d context=%s preview=%s",
        len(content), context, repr(content[:120]),
    )

    if not content:
        # Empty text content is fine when the response carries native tool
        # calls (OpenAI tool_calls / Anthropic tool_use blocks).
        if _extract_native_tool_calls(provider, data):
            logger.info("Empty text, native tool calls present | context=%s", context)
            return "", data

        logger.warning(
            "Empty content | keys=%s finish_reason=%s context=%s",
            list(data.keys()) if isinstance(data, dict) else "N/A",
            data.get("choices", [{}])[0].get("finish_reason", "N/A") if isinstance(data, dict) else "N/A",
            context,
        )
        # Don't raise: a transient empty completion from a local server
        # (llama.cpp) is recoverable, and the caller's empty-response backstop
        # re-prompts without tools before surfacing a graceful fallback. The
        # warning above still records every empty for diagnostics.
        return "", data

    return content, data


def _extract_api_error_message(data: dict) -> str | None:
    error = data.get("error")
    if error is None:
        return None
    if isinstance(error, dict):
        message = error.get("message") or error.get("error")
        return str(message or error)
    return str(error)


def _extract_provider_content(provider: str, data: dict) -> str:
    if provider == "anthropic":
        return data.get("content", [{}])[0].get("text", "")
    return data.get("choices", [{}])[0].get("message", {}).get("content", "")


def _build_api_base_url(api_url: str) -> str:
    parsed = urlparse(api_url)
    if not parsed.scheme or not parsed.netloc:
        return api_url.rstrip("/")
    return urlunparse((parsed.scheme, parsed.netloc, "", "", "", "")).rstrip("/")


@router.post("/ai/chat")
async def chat_proxy(req: ChatRequest):
    """Proxy chat messages to the user's configured API provider."""
    messages = _prepare_messages(req.messages)

    # ── Log request summary ──
    msg_count = len(messages)
    system_msgs = [m for m in messages if m.get("role") == "system"]
    non_system_msgs = [m for m in messages if m.get("role") != "system"]
    total_chars = sum(len(str(m.get("content", ""))) for m in messages)
    system_chars = sum(len(str(m.get("content", ""))) for m in system_msgs)
    query_chars = sum(len(str(m.get("content", ""))) for m in non_system_msgs)
    logger.info(
        "Chat request | provider=%s model=%s msgs=%d (sys=%d user=%d) chars=%d (system=%d query=%d) requestId=%s",
        req.apiProvider.value if hasattr(req.apiProvider, 'value') else req.apiProvider,
        req.model, msg_count, len(system_msgs), len(non_system_msgs),
        total_chars, system_chars, query_chars,
        req.requestId or "none",
    )

    # Local providers don't require an API key
    if not _is_local_provider(req.apiProvider, req.apiUrl) and not req.apiKey:
        return {"error": "AI settings not configured. Please configure your API key in settings."}

    # Build headers based on provider
    if req.apiProvider == "anthropic":
        # Anthropic uses x-api-key header instead of Bearer
        headers = {
            "x-api-key": req.apiKey,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        }
    elif _is_local_provider(req.apiProvider, req.apiUrl):
        # LM Studio and Ollama: auth optional, include key if provided
        headers = {
            "Content-Type": "application/json",
        }
        if req.apiKey:
            headers["Authorization"] = f"Bearer {req.apiKey}"
    else:
        # OpenAI, Google (OpenAI-compat), GitHub Copilot, and OpenAI Compatible all use Bearer auth
        headers = {
            "Authorization": f"Bearer {req.apiKey}",
            "Content-Type": "application/json",
        }

    # Native function calling for cloud providers only; local providers keep
    # the text-based ```tool protocol since local tool support varies.
    native_tools = None if _is_local_provider(req.apiProvider, req.apiUrl) else _build_native_tools()

    # ── Stop-event registration ──
    stop_event = None
    if req.requestId:
        stop_event = asyncio.Event()
        _chat_stop_events[req.requestId] = stop_event
        logger.info(
            "Stop event registered | requestId=%s registry_size=%d",
            req.requestId, len(_chat_stop_events),
        )

    timeout = httpx.Timeout(connect=15.0, read=None, write=120.0, pool=120.0)

    async with httpx.AsyncClient(timeout=timeout) as client:
        try:
            payload = _build_provider_payload(
                req.apiProvider, messages, req.model,
                max_tokens=req.maxTokens,
                temperature=req.temperature,
                tools=native_tools,
            )

            current_content, current_data = await _query_provider(
                client, req.apiUrl, headers, payload, req.apiProvider,
                logger_context="initial",
                stop_event=stop_event,
            )

            tool_turns = 0
            current_messages = list(messages)
            executed_tool_names: list[str] = []

            # ── Auto-search fallback ──
            # If the model didn't call any tools on the first pass, do a backend
            # search and inject the results so it still gets grounded docs even
            # if it doesn't support tool calling.
            if not _extract_native_tool_calls(req.apiProvider, current_data) and not _extract_tool_calls(current_content):
                if _is_edit_request(req.messages):
                    # Phase 3: edits are answered from the config context; a
                    # doc search injection mid-edit derails the draft.
                    logger.info("Auto-search fallback skipped | edit request")
                elif not _auto_search_enabled():
                    logger.info("Auto-search fallback skipped | disabled via KWC_AUTO_SEARCH=0")
                elif PRINTER_MEMORY_BLOCK_RE.search(current_content):
                    # The model already produced a structured printer-memory
                    # proposal; injecting a doc search would only derail it.
                    logger.info("Auto-search fallback skipped | printer-memory block present")
                else:
                    if stop_event is not None and stop_event.is_set():
                        raise ChatStoppedError()
                    reference_query = _build_reference_lookup_query(req.messages)
                    auto_context = _auto_search_context(reference_query)
                    if auto_context:
                        logger.info(
                            "Auto-search fallback triggered | query_chars=%d result_chars=%d",
                            len(reference_query), len(auto_context),
                        )
                        tool_message = _build_tool_result_message(
                            {"name": "search_klipper_docs", "arguments": {"query": reference_query}},
                            auto_context,
                        )
                        current_messages.append({"role": "assistant", "content": current_content})
                        current_messages.append({"role": "user", "content": tool_message})
                        tool_turns += 1

                        # Re-query with injected search results
                        tool_payload = _build_provider_payload(
                            req.apiProvider, current_messages, req.model,
                            max_tokens=req.maxTokens,
                            temperature=req.temperature,
                            tools=native_tools,
                        )
                        current_content, current_data = await _query_provider(
                            client, req.apiUrl, headers, tool_payload, req.apiProvider,
                            logger_context="auto-search",
                            stop_event=stop_event,
                        )

            while tool_turns < MAX_MCP_TOOL_TURNS:
                if stop_event is not None and stop_event.is_set():
                    raise ChatStoppedError()

                # Native function calls come from the structured response body
                # (OpenAI tool_calls / Anthropic tool_use blocks); otherwise
                # fall back to regex extraction from the response text.
                native_calls = _extract_native_tool_calls(req.apiProvider, current_data)
                tool_calls = native_calls or _extract_tool_calls(current_content)
                if not tool_calls:
                    if tool_turns > 0:
                        logger.info("Tool call loop done | turns=%d final_chars=%d", tool_turns, len(current_content))
                    break

                # ── Hallucinated-tool guard ──
                # If the model wrapped names that are not real tools (e.g.
                # G-code commands like BED_MESH_CALIBRATE) in tool blocks and
                # produced answer text alongside, keep the text and stop
                # instead of feeding "Unknown tool" errors back — that derails
                # models into explaining the error instead of answering.
                known_tool_names = {t["name"] for t in _mcp_server._list_tools()}
                if tool_calls and current_content.strip() and all(
                    c.get("name") not in known_tool_names for c in tool_calls
                ):
                    logger.warning(
                        "Hallucinated tool call(s) skipped | names=%s content_chars=%d",
                        [c.get("name") for c in tool_calls], len(current_content),
                    )
                    break

                logger.info(
                    "Tool calls detected | turn=%d count=%d first=%s format=%s content_preview=%s",
                    tool_turns + 1, len(tool_calls),
                    tool_calls[0]["name"],
                    "native" if native_calls else "text",
                    repr(current_content[:80]),
                )

                # Execute every tool call in this round first, then build the
                # follow-up messages in the format the provider expects.
                results = []
                for tool_call in tool_calls[:MAX_MCP_TOOL_TURNS]:
                    result_text = _execute_tool_call(tool_call)
                    logger.info(
                        "Tool executed | name=%s result_chars=%d",
                        tool_call["name"], len(result_text),
                    )
                    executed_tool_names.append(tool_call["name"])
                    results.append(result_text)

                if native_calls is not None:
                    # Native format: echo the assistant message (with tool_calls)
                    # and append one 'tool' / tool_result message per call.
                    current_messages.extend(
                        _build_native_tool_followup(
                            req.apiProvider, current_content, tool_calls, results,
                        )
                    )
                    tool_turns += len(tool_calls)
                else:
                    # Text format: strip the tool call syntax from the assistant
                    # message so the re-query doesn't confuse models that use
                    # native special tokens (Gemma, Llama 3.1+, Qwen, etc.),
                    # then append one user tool-result message per call. Only
                    # append the assistant message if it has actual text — if
                    # the model ONLY emitted a tool call, skip it.
                    for tool_call, result_text in zip(tool_calls, results):
                        tool_message = _build_tool_result_message(tool_call, result_text)

                        clean_content = MCP_TOOL_BLOCK_RE.sub("", current_content).strip()
                        clean_content = ALT_TOOL_CALL_CONTENT_RE.sub("", clean_content).strip()
                        clean_content = CALL_SYNTAX_CLEANUP_RE.sub("", clean_content).strip()
                        clean_content = FUNC_CALL_CLEANUP_RE.sub("", clean_content).strip()
                        if clean_content:
                            current_messages.append({"role": "assistant", "content": clean_content})
                        current_messages.append({"role": "user", "content": tool_message})
                    tool_turns += len(tool_calls)

                tool_payload = _build_provider_payload(
                    req.apiProvider, current_messages, req.model,
                    max_tokens=req.maxTokens,
                    temperature=req.temperature,
                    tools=native_tools,
                )
                current_content, current_data = await _query_provider(
                    client, req.apiUrl, headers, tool_payload, req.apiProvider,
                    logger_context=f"tool-turn-{tool_turns}",
                    stop_event=stop_event,
                )

            # Clean up any remaining tool call blocks in the final content.
            # Check whether the content contained tool call blocks BEFORE cleanup
            # so we don't restore raw tool call text back into the visible output.
            had_tool_blocks = bool(
                MCP_TOOL_BLOCK_RE.search(current_content)
                or ALT_TOOL_CALL_CONTENT_RE.search(current_content)
                or CALL_SYNTAX_CLEANUP_RE.search(current_content)
                or FUNC_CALL_CLEANUP_RE.search(current_content)
            )
            final_content = MCP_TOOL_BLOCK_RE.sub("", current_content).strip()
            final_content = ALT_TOOL_CALL_CONTENT_RE.sub("", final_content).strip()
            final_content = CALL_SYNTAX_CLEANUP_RE.sub("", final_content).strip()
            final_content = FUNC_CALL_CLEANUP_RE.sub("", final_content).strip()
            # If the cleanup left nothing but the original was a tool call,
            # don't restore the raw tool call text — return empty instead.
            if not final_content and not had_tool_blocks:
                final_content = current_content

            # ── Empty-response backstop ──
            # Models sometimes end their turn with only a tool call and no
            # visible text. Re-prompt without tools so the model answers the
            # user's question directly instead of the UI showing
            # "No response.".
            empty_reprompts = 0
            while not final_content and empty_reprompts < EMPTY_REPROMPT_LIMIT:
                if stop_event is not None and stop_event.is_set():
                    raise ChatStoppedError()
                empty_reprompts += 1
                logger.warning(
                    "Empty final content | re-prompting without tools (attempt %d/%d)",
                    empty_reprompts, EMPTY_REPROMPT_LIMIT,
                )
                current_messages.append({
                    "role": "system",
                    "content": (
                        "Your previous response contained no visible text. "
                        "Answer the user's latest question directly with text "
                        "now. Do not call any tools."
                    ),
                })
                # Local reasoning builds burn hidden tokens before visible
                # text, so give the re-prompt at least EMPTY_REPROMPT_MAX_TOKENS
                # of budget — the original limit may have been exhausted
                # invisibly (empty content + finish_reason=length).
                retry_max_tokens = req.maxTokens
                if _is_local_provider(req.apiProvider, req.apiUrl):
                    retry_max_tokens = max(req.maxTokens, EMPTY_REPROMPT_MAX_TOKENS)
                logger.info(
                    "Empty re-prompt budget | req=%d retry=%d provider=%s",
                    req.maxTokens, retry_max_tokens, req.apiProvider,
                )
                retry_payload = _build_provider_payload(
                    req.apiProvider, current_messages, req.model,
                    max_tokens=retry_max_tokens,
                    temperature=req.temperature,
                    tools=None,
                )
                current_content, _ = await _query_provider(
                    client, req.apiUrl, headers, retry_payload, req.apiProvider,
                    logger_context=f"empty-reprompt-{empty_reprompts}",
                    stop_event=stop_event,
                )
                final_content = MCP_TOOL_BLOCK_RE.sub("", current_content).strip()
                final_content = ALT_TOOL_CALL_CONTENT_RE.sub("", final_content).strip()
                final_content = CALL_SYNTAX_CLEANUP_RE.sub("", final_content).strip()
                final_content = FUNC_CALL_CLEANUP_RE.sub("", final_content).strip()

            # Collect tool names used during the MCP tool loop. Native tool
            # calls don't leave `[Tool result: ...]` messages, so fall back
            # to the names captured while executing them.
            mcp_tool_names = _collect_tool_names(current_messages)
            if not mcp_tool_names and executed_tool_names:
                mcp_tool_names = list(dict.fromkeys(executed_tool_names))

            logger.info(
                "Returning response | final_chars=%d tool_turns=%d tools=%s empty=%s",
                len(final_content), tool_turns,
                mcp_tool_names or [],
                "yes" if not final_content else "no",
            )
            if not final_content:
                logger.warning(
                    "Empty final content after %d tool turns (%d re-prompts)",
                    tool_turns, empty_reprompts,
                )
                # Never surface a blank bubble: the UI would show "No response."
                # The re-prompt loop already burned EMPTY_REPROMPT_LIMIT queries,
                # so return an explicit fallback the user can act on instead.
                final_content = (
                    "I wasn't able to generate a response. "
                    "Please try rephrasing your question."
                )

            return {
                "content": final_content,
                "mcpToolTurns": tool_turns,
                "mcpToolNames": mcp_tool_names,
            }
        except ChatStoppedError:
            logger.info("Chat stopped by user | requestId=%s", req.requestId)
            return {"stopped": True}
        except ValueError as e:
            logger.error("API error | %s", str(e))
            return {"error": f"API error: {str(e)}"}
        except httpx.TimeoutException:
            logger.error("Request timed out")
            return {"error": "API request timed out before the model finished responding."}
        except httpx.HTTPError as e:
            logger.error("HTTP error | %s", str(e))
            return {"error": f"API request failed: {str(e)}"}
        finally:
            if req.requestId:
                _chat_stop_events.pop(req.requestId, None)
