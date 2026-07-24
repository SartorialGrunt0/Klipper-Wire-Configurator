"""Klipper Wire Configurator - AI Chat Backend Proxy"""
import json
import logging
from enum import Enum
from pathlib import Path
import re
from urllib.parse import urlparse, urlunparse

from fastapi import APIRouter
from pydantic import BaseModel

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
# Matches "call tool_name{...}" or "tool_name{...}" for non-JSON tool call text
CALL_SYNTAX_RE = re.compile(
    r"(?:^|\n)\s*(?:call[\s:]?\s*)?(\w+)\s*\{(.+)\}",
    re.DOTALL,
)
# Matches Python-style "function_name(arg1=\"val1\", arg2=123)" or
# "function_name(arg1: \"val1\")" without curly braces
FUNC_CALL_RE = re.compile(
    r"(?:^|\n)\s*(?:call[\s:]?\s*)?(\w+)\s*\(" +
    r"(.+?)" +
    r"\)\s*(?:\n|$)",
    re.DOTALL,
)
# Cleanup regexes for stripping bare function call text from output.
# These match on line boundaries to avoid mangling prose.
CALL_SYNTAX_CLEANUP_RE = re.compile(
    r"(?:^|\n)\s*(?:call[\s:]?\s*)?\w+\s*\{[^}]*\}\s*(?=\n|$)",
    re.DOTALL,
)
FUNC_CALL_CLEANUP_RE = re.compile(
    r"(?:^|\n)\s*(?:call[\s:]?\s*)?\w+\s*\([^)]*\)\s*(?=\n|$)",
    re.DOTALL,
)

LM_STUDIO_KLIPPER_DOCS_PLUGIN_ID = "mcp/klipper-docs"
LM_STUDIO_MAX_INPUT_CHARS = 48000
LM_STUDIO_MAX_HISTORY_MESSAGES = 16
LM_STUDIO_ESTIMATED_CHARS_PER_TOKEN = 4
LM_STUDIO_INPUT_TRUNCATED_NOTICE = (
    "[Conversation context truncated before sending to the LM Studio REST chat endpoint.]"
)
LM_STUDIO_MCP_FALLBACK_HINTS = (
    "allow calling servers from mcp.json",
    "allow per-request mcps",
    "api token",
    "authorization",
    "integration",
    "mcp",
    "plugin",
)

SYSTEM_PROMPT = (
    "You are an expert Klipper firmware, configuration, and macro assistant. "
    "Answer Klipper questions, edit existing configs, and draft macros without inventing details.\n\n"
    "Keeps answers short and focused.\n\n"
    "Operating rules:\n"
    "1. Treat bundled Klipper docs, Config_Reference excerpts, tool output, and user-provided config text as the source of truth.\n"
    "2. Never invent section names, parameter names, defaults, units, commands, or supported behavior. "
    "If the docs in context do not confirm a detail, say that explicitly.\n"
    "3. Separate verified facts from assumptions. If the request depends on unknown printer details such as kinematics, probe type, MCU, toolhead, bed size, macro names, or sensors, ask one short clarifying question unless the provided config already resolves it.\n"
    "4. Prefer minimal targeted edits over rewrites. Preserve unrelated settings, comments, and file structure unless the user explicitly asks for a larger refactor.\n"
    "5. When editing config, return only the changed or new Klipper sections inside fenced cfg code blocks. For each changed section, output the full final section using the exact Klipper section header and exact parameter names from the docs.\n"
    "6. When the app asks for per-file output, keep each file in a separate fenced cfg block and include any required '# file: <filename>' hint line exactly as requested.\n"
    "7. When drafting macros, produce valid Klipper syntax, keep motion and temperature behavior conservative, and make mode changes explicit. If a macro changes motion or extrusion state, preserve or restore that state unless the user clearly wants persistent changes.\n"
    "8. Keep prose short. After config or macro code, briefly explain what changed, why, and cite the exact documentation section header and parameter or command names you relied on.\n"
    "9. If no safe grounded answer is possible, say what must be verified next instead of guessing."
)



class AiProvider(str, Enum):
    chatgpt = "chatgpt"
    google = "google"
    anthropic = "anthropic"
    github = "github"
    openai_compatible = "openai-compatible"
    lm_studio = "lm-studio"
    ollama = "ollama"

    @classmethod
    def is_openai_compatible(cls, provider: str) -> bool:
        """Check if the provider uses OpenAI-compatible chat format."""
        return provider in (cls.chatgpt, cls.google, cls.openai_compatible, cls.lm_studio, cls.ollama)


class ChatRequest(BaseModel):
    messages: list[dict]
    apiKey: str
    model: str = "gpt-4o"
    apiUrl: str = "https://api.openai.com/v1/chat/completions"
    apiProvider: AiProvider = AiProvider.chatgpt
    lmStudioMcpPluginId: str | None = None


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


def _is_local_provider(provider: str) -> bool:
    """Check if the provider is a local server (LM Studio, Ollama, OpenAI Compatible)."""
    return provider in ("lm-studio", "ollama", "openai-compatible")


def _is_openai_compatible_provider(provider: str) -> bool:
    """Check if the provider uses OpenAI-compatible chat format."""
    return provider in ("chatgpt", "google", "openai-compatible", "lm-studio", "ollama")


def _get_openai_compatible_default_url(provider: str) -> str:
    """Get the default API URL for an OpenAI-compatible provider."""
    defaults = {
        "chatgpt": "https://api.openai.com/v1/chat/completions",
        "google": "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
        "openai-compatible": "http://localhost:11434/api/chat",
        "lm-studio": "http://localhost:1234/v1/chat/completions",
        "ollama": "http://localhost:11434/api/chat",
    }
    return defaults.get(provider, "")


def _prepare_messages(messages: list[dict]) -> list[dict]:
    """Build a clean system prompt with MCP tool descriptions and user messages.

    No longer injects keyword-matched doc excerpts — the model fetches
    documentation on demand via MCP tools (search_klipper_docs, etc.).
    """
    system_parts = [SYSTEM_PROMPT, _build_mcp_tool_context()]
    system_parts.append(
        "Use the tools you have available to help you answer the following question."
    )

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
        "Prepared messages | system=%d chars user_msgs=%d",
        len(system_text), len(prepared)
    )
    return [{"role": "system", "content": system_text}] + prepared


# ── MCP Tool Integration ───────────────────────────────────────────


def _build_mcp_tool_context() -> str:
    """Build an 'Available Tools' section for the system prompt.

    Describes the embedded MCP tools so the AI model can request them
    regardless of whether the provider supports native function calling.
    """
    tools = _mcp_server._list_tools()

    parts = [
        "# Available MCP Tools",
        "",
        "You have access to the following tools through the application's built-in ",
        "documentation and config system. Use them to look up Klipper documentation,",
        "validate configs, get section schemas, detect boards, and more.",
        "",
        "To call a tool, include a JSON code block with `tool` as the language tag:",
        "",
        "```tool",
        """{"name": "tool_name", "arguments": {"key": "value"}}""",
        "```",
        "",
        "The application will execute the tool and return the result as a follow-up ",
        "message. Use the tool result to ground your answer in real documentation.",
        "",
        "---",
        "",
    ]

    for tool in tools:
        name = tool["name"]
        desc = tool.get("description", "").replace("\n", " ")
        schema = tool.get("inputSchema", {})
        props = schema.get("properties", {})
        required = schema.get("required", [])

        parts.append(f"## {name}")
        parts.append(f"{desc}")
        if props:
            parts.append("")
            parts.append("Parameters:")
            for param_name, param_info in props.items():
                ptype = param_info.get("type", "string")
                pdesc = param_info.get("description", "")
                req_mark = " (required)" if param_name in required else ""
                parts.append(f"  - {param_name} [{ptype}]{req_mark}: {pdesc}")
        parts.append("")

    parts.append("---")
    parts.append("")
    parts.append(
        "When to use each tool:"
    )
    parts.append(
        "- **search_klipper_docs**: Use FIRST when the user asks about any Klipper "
        "feature, parameter, config section, or troubleshooting topic. "
        "This grounds your answer in actual documentation."
    )
    parts.append(
        "- **get_config_reference_section**: Use when the user specifically asks about "
        "a config section's exact parameters, defaults, or syntax. "
        "Only use this if search_klipper_docs didn't give enough detail."
    )
    parts.append(
        "- **read_klipper_doc**: Use when the user asks for the full contents of a "
        "specific documentation page, or when you need more context than a search snippet provides."
    )
    parts.append(
        "- **validate_klipper_config**: Use when the user provides a config snippet "
        "and asks you to check it for errors, or when you want to verify your own "
        "config suggestion before presenting it."
    )
    parts.append(
        "- **get_section_schema**: Use when the user asks what parameters a section "
        "type supports, what values are valid, or what defaults exist."
    )
    parts.append(
        "- **search_example_configs**: Use when the user asks for a complete working "
        "config example for a specific board or printer model."
    )
    parts.append(
        "- **detect_board**: Use when the user asks what board their config targets, "
        "or when you need to identify the MCU from pin definitions."
    )
    parts.append(
        "- **list_klipper_docs**: Use when the user asks what documentation is available "
        "or wants to browse the full set of Klipper docs."
    )
    parts.append("")
    parts.append(
        "Rules of thumb:"
    )
    parts.append(
        "1. When in doubt, search first. Real docs are always better than your training data."
    )
    parts.append(
        "2. You can call multiple tools in a single response if needed."
    )
    parts.append(
        "3. If the tool returns information, use it to answer. Don't ignore the tool result."
    )
    parts.append(
        "4. If you're confident about a simple config parameter from your training, "
        "you can answer without tools. But for anything specific to Klipper syntax, "
        "check the docs first."
    )

    return "\n".join(parts)


# ── Auto-search fallback ────────────────────────────────────────────

AUTO_SEARCH_FALLBACK_MAX_CHARS = 4000


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
                arguments = _parse_kwargs(args_text)
                calls.append({"name": name, "arguments": arguments})
                continue

        # Try parsing multi-line YAML-style: call:name\nkey: val\nkey2: val2
        # (used by some Gemma variants)
        # ALT_TOOL_CALL_CONTENT_RE only captured first line, so read rest
        # of the tool call from the original text starting after the match.
        name_match = re.match(r"(?:call[\s:]?\s*)?(\w+)", content)
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
        f"[End tool result. Continue answering the user's original request using the information above.]"
    )


MAX_MCP_TOOL_TURNS = 5


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


def _process_tool_calls_in_response(
    content: str,
    current_messages: list[dict],
    provider: str,
    model: str,
) -> tuple[str, list[dict], int]:
    """Process any tool calls in the model's response.

    Returns:
        (final_content, updated_messages, tool_turns_used)
    """
    tool_calls = _extract_tool_calls(content)
    if not tool_calls:
        return content, current_messages, 0

    # Strip tool call blocks from the visible response so the user
    # doesn't see raw JSON in the chat UI
    clean_content = MCP_TOOL_BLOCK_RE.sub("", content).strip()
    clean_content = ALT_TOOL_CALL_CONTENT_RE.sub("", clean_content).strip()
    clean_content = CALL_SYNTAX_CLEANUP_RE.sub("", clean_content).strip()
    clean_content = FUNC_CALL_CLEANUP_RE.sub("", clean_content).strip()

    for turn_index, tool_call in enumerate(tool_calls[:MAX_MCP_TOOL_TURNS]):
        result_text = _execute_tool_call(tool_call)
        tool_message = _build_tool_result_message(tool_call, result_text)

        # Add the assistant's partial response (with tool calls) and the tool result
        current_messages.append({"role": "assistant", "content": content})
        current_messages.append({"role": "user", "content": tool_message})

    return clean_content, current_messages, len(tool_calls)


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


def _normalize_lm_studio_mcp_plugin_id(plugin_id: str | None) -> str | None:
    if plugin_id is None:
        return LM_STUDIO_KLIPPER_DOCS_PLUGIN_ID

    normalized = plugin_id.strip()
    return normalized or None


def _truncate_lm_studio_input(text: str) -> str:
    if len(text) <= LM_STUDIO_MAX_INPUT_CHARS:
        return text

    keep_chars = max(0, LM_STUDIO_MAX_INPUT_CHARS - len(LM_STUDIO_INPUT_TRUNCATED_NOTICE) - 2)
    return f"{LM_STUDIO_INPUT_TRUNCATED_NOTICE}\n\n{text[-keep_chars:]}"


def _format_lm_studio_chat_input(messages: list[dict]) -> str:
    non_system_messages = [msg for msg in messages if msg.get("role") in {"user", "assistant"}]
    if not non_system_messages:
        return ""

    recent_messages = non_system_messages[-LM_STUDIO_MAX_HISTORY_MESSAGES:]
    latest_message = recent_messages[-1]
    prior_messages = recent_messages[:-1]

    if not prior_messages and latest_message.get("role") == "user":
        return _truncate_lm_studio_input(str(latest_message.get("content", "")).strip())

    parts: list[str] = []
    if prior_messages:
        history_parts = []
        for msg in prior_messages:
            role = "User" if msg.get("role") == "user" else "Assistant"
            content = str(msg.get("content", "")).strip()
            if not content:
                continue
            history_parts.append(f"{role}:\n{content}")
        if history_parts:
            parts.append("Conversation so far:")
            parts.append("\n\n".join(history_parts))

    latest_content = str(latest_message.get("content", "")).strip()
    if latest_content:
        if latest_message.get("role") == "user":
            parts.append("Current user request:")
            parts.append(latest_content)
        else:
            parts.append(f"Assistant:\n{latest_content}")

    return _truncate_lm_studio_input("\n\n".join(part for part in parts if part))


def _build_lm_studio_chat_url(api_url: str) -> str:
    return f"{_build_api_base_url(api_url)}/api/v1/chat"


def _build_lm_studio_chat_payload(messages: list[dict], model: str, mcp_plugin_id: str | None = LM_STUDIO_KLIPPER_DOCS_PLUGIN_ID) -> dict:
    system_prompt = ""
    for msg in messages:
        if msg.get("role") == "system":
            system_prompt = str(msg.get("content", "")).strip()
            break

    payload = {
        "model": model,
        "input": _format_lm_studio_chat_input(messages),
        "store": False,
    }

    if system_prompt:
        payload["system_prompt"] = system_prompt
    if mcp_plugin_id:
        payload["integrations"] = [mcp_plugin_id]

    return payload


def _extract_int_value(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        normalized = value.strip()
        if normalized.isdigit():
            return int(normalized)
    return None


def _extract_lm_studio_usage_metrics(data: dict) -> tuple[int | None, int | None, int | None]:
    usage = data.get("usage")
    if not isinstance(usage, dict):
        return None, None, None

    prompt_tokens = _extract_int_value(usage.get("prompt_tokens"))
    completion_tokens = _extract_int_value(usage.get("completion_tokens"))
    total_tokens = _extract_int_value(usage.get("total_tokens"))
    if total_tokens is None and prompt_tokens is not None and completion_tokens is not None:
        total_tokens = prompt_tokens + completion_tokens

    return prompt_tokens, completion_tokens, total_tokens


def _extract_lm_studio_context_window_from_model(model_data: dict) -> int | None:
    for key in (
        "context_length",
        "max_context_length",
        "contextLength",
        "maxContextLength",
        "n_ctx",
    ):
        value = _extract_int_value(model_data.get(key))
        if value is not None and value > 0:
            return value

    model_info = model_data.get("model_info")
    if isinstance(model_info, dict):
        for key in (
            "context_length",
            "max_context_length",
            "contextLength",
            "maxContextLength",
            "n_ctx",
        ):
            value = _extract_int_value(model_info.get(key))
            if value is not None and value > 0:
                return value

    return None


def _extract_lm_studio_context_window(data: dict) -> int | None:
    return _extract_lm_studio_context_window_from_model(data)


def _count_message_chars(messages: list[dict]) -> int:
    total = 0
    for msg in messages:
        content = str(msg.get("content", "")).strip()
        if content:
            total += len(content)
    return total


def _count_lm_studio_payload_chars(payload: dict) -> int:
    input_text = str(payload.get("input", ""))
    system_prompt = str(payload.get("system_prompt", ""))
    return len(input_text) + len(system_prompt)


def _lm_studio_payload_truncated(payload: dict) -> bool:
    return str(payload.get("input", "")).startswith(LM_STUDIO_INPUT_TRUNCATED_NOTICE)


async def _fetch_lm_studio_model_context_window(client, api_url: str, headers: dict, model: str) -> int | None:
    if not model:
        return None

    base_url = _build_api_base_url(api_url)
    model_urls = (
        f"{base_url}/api/v1/models",
        f"{base_url}/api/v0/models",
        f"{base_url}/v1/models",
    )

    for model_url in model_urls:
        try:
            resp = await client.get(model_url, headers=headers)
            resp.raise_for_status()
            data = resp.json()
        except Exception:
            continue

        model_items = data.get("data") if isinstance(data, dict) else None
        if not isinstance(model_items, list):
            continue

        for item in model_items:
            if not isinstance(item, dict) or str(item.get("id", "")).strip() != model:
                continue

            context_window = _extract_lm_studio_context_window_from_model(item)
            if context_window is not None:
                return context_window

    return None


async def _resolve_lm_studio_context_window(client, api_url: str, headers: dict, model: str, data: dict) -> int | None:
    context_window = _extract_lm_studio_context_window(data)
    if context_window is not None:
        return context_window

    return await _fetch_lm_studio_model_context_window(client, api_url, headers, model)


def _build_lm_studio_context_metadata(
    data: dict,
    *,
    request_chars: int,
    truncated: bool,
    context_window: int | None = None,
) -> dict:
    if context_window is None:
        context_window = _extract_lm_studio_context_window(data)

    prompt_tokens, completion_tokens, total_tokens = _extract_lm_studio_usage_metrics(data)
    estimated_prompt_tokens = None
    if prompt_tokens is None and request_chars > 0:
        estimated_prompt_tokens = (
            request_chars + LM_STUDIO_ESTIMATED_CHARS_PER_TOKEN - 1
        ) // LM_STUDIO_ESTIMATED_CHARS_PER_TOKEN

    used_tokens = total_tokens
    if used_tokens is None:
        used_tokens = prompt_tokens
    if used_tokens is None:
        used_tokens = estimated_prompt_tokens

    utilization = None
    if context_window is not None and context_window > 0 and used_tokens is not None:
        utilization = round(min(used_tokens / context_window, 1.0), 4)

    return {
        "requestChars": request_chars,
        "truncated": truncated,
        "promptTokens": prompt_tokens,
        "completionTokens": completion_tokens,
        "totalTokens": total_tokens,
        "estimatedPromptTokens": estimated_prompt_tokens,
        "contextWindow": context_window,
        "usedTokens": used_tokens,
        "utilization": utilization,
    }


def _extract_lm_studio_message_content(data: dict) -> str:
    output = data.get("output")
    if not isinstance(output, list):
        return ""

    messages: list[str] = []
    for item in output:
        if item.get("type") != "message":
            continue
        content = str(item.get("content", "")).strip()
        if content:
            messages.append(content)

    return "\n\n".join(messages)


def _lm_studio_response_needs_fallback(data: dict) -> bool:
    output = data.get("output")
    if not isinstance(output, list):
        return False
    return any(item.get("type") == "invalid_tool_call" for item in output)


def _extract_lm_studio_tool_names(data: dict, plugin_id: str | None) -> list[str]:
    if not plugin_id:
        return []

    output = data.get("output")
    if not isinstance(output, list):
        return []

    tool_names: list[str] = []
    for item in output:
        if item.get("type") != "tool_call":
            continue
        provider_info = item.get("provider_info") or {}
        if provider_info.get("type") != "plugin":
            continue
        if provider_info.get("plugin_id") != plugin_id:
            continue

        tool_name = str(item.get("tool", "")).strip()
        if tool_name:
            tool_names.append(tool_name)

    return tool_names


def _build_lm_studio_mcp_metadata(
    plugin_id: str | None,
    route: str,
    *,
    tool_names: list[str] | None = None,
    fallback_reason: str | None = None,
) -> dict:
    normalized_tool_names = tool_names or []
    return {
        "requested": plugin_id is not None,
        "pluginId": plugin_id,
        "route": route,
        "toolUsed": bool(normalized_tool_names),
        "toolNames": normalized_tool_names,
        "fallbackUsed": fallback_reason is not None,
        "fallbackReason": fallback_reason,
    }


def _summarize_lm_studio_fallback_reason(default_message: str, response_text: str | None = None) -> str:
    if not response_text:
        return default_message

    normalized = re.sub(r"\s+", " ", response_text).strip()
    if not normalized:
        return default_message
    if len(normalized) > 160:
        normalized = f"{normalized[:157].rstrip()}..."
    return f"{default_message} {normalized}"


async def _post_openai_compatible_chat(client, api_url: str, headers: dict, payload: dict) -> tuple[dict, str]:
    resp = await client.post(api_url, headers=headers, json=payload)
    resp.raise_for_status()
    data = resp.json()
    error_message = _extract_api_error_message(data)
    if error_message:
        raise ValueError(error_message)
    return data, _extract_provider_content("lm-studio", data)


def _should_fallback_lm_studio_request(status_code: int, response_text: str) -> bool:
    if status_code in {404, 405}:
        return True
    if status_code not in {400, 401, 403, 422, 500, 502, 503}:
        return False

    normalized = response_text.lower()
    return any(hint in normalized for hint in LM_STUDIO_MCP_FALLBACK_HINTS)


@router.get("/ai/models")
async def list_models(apiUrl: str = None, apiKey: str = None):
    """List available models from a local server (LM Studio, Ollama, etc.)."""
    import httpx
    from urllib.parse import urlparse, urlunparse

    if not apiUrl:
        return {"models": []}

    # Strip the path (e.g., /v1/chat/completions) to get the base URL
    parsed = urlparse(apiUrl)
    base_url = urlunparse((parsed.scheme, parsed.netloc, '', '', '', ''))
    models_url = f"{base_url}/v1/models"

    headers = {"Content-Type": "application/json"}
    if apiKey and apiKey.strip():
        headers["Authorization"] = f"Bearer {apiKey}"

    async with httpx.AsyncClient(timeout=10.0) as client:
        try:
            resp = await client.get(models_url, headers=headers)
            resp.raise_for_status()
            data = resp.json()
            model_ids = [m["id"] for m in data.get("data", [])]
            return {"models": model_ids}
        except httpx.HTTPError as e:
            return {"models": [], "error": str(e)}


@router.post("/ai/chat")
async def chat_proxy(req: ChatRequest):
    """Proxy chat messages to the user's configured API provider."""
    import httpx

    messages = _prepare_messages(req.messages)

    # ── Log request summary ──
    msg_count = len(messages)
    system_msgs = [m for m in messages if m.get("role") == "system"]
    non_system_msgs = [m for m in messages if m.get("role") != "system"]
    total_chars = sum(len(str(m.get("content", ""))) for m in messages)
    system_chars = sum(len(str(m.get("content", ""))) for m in system_msgs)
    query_chars = sum(len(str(m.get("content", ""))) for m in non_system_msgs)
    logger.info(
        "Chat request | provider=%s model=%s msgs=%d (sys=%d user=%d) chars=%d (system=%d query=%d)",
        req.apiProvider.value if hasattr(req.apiProvider, 'value') else req.apiProvider, req.model, msg_count,
        len(system_msgs), len(non_system_msgs),
        total_chars, system_chars, query_chars
    )

    # Local providers don't require an API key
    if not _is_local_provider(req.apiProvider) and not req.apiKey:
        return {"error": "AI settings not configured. Please configure your API key in settings."}

    # Build headers based on provider
    if req.apiProvider == "anthropic":
        # Anthropic uses x-api-key header instead of Bearer
        headers = {
            "x-api-key": req.apiKey,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        }
    elif _is_local_provider(req.apiProvider):
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

    # Build payload based on provider
    if req.apiProvider == "anthropic":
        # Claude uses a different format - extract system message
        system = None
        filtered_messages = []
        for msg in messages:
            if msg["role"] == "system":
                system = msg["content"]
            else:
                filtered_messages.append(msg)
        if system:
            payload = {
                "model": req.model,
                "messages": filtered_messages,
                "system": system,
            }
        else:
            payload = {
                "model": req.model,
                "messages": filtered_messages,
            }
    else:
        # OpenAI-compatible chat providers use the standard messages format.
        # temperature=0 makes tool call decisions more deterministic.
        payload = {
            "model": req.model,
            "messages": messages,
            "temperature": 0.1,
            "max_tokens": 4096,
        }

    timeout = httpx.Timeout(connect=15.0, read=None, write=120.0, pool=120.0)

    async with httpx.AsyncClient(timeout=timeout) as client:
        try:
            if req.apiProvider == "lm-studio":
                lm_studio_mcp_plugin_id = _normalize_lm_studio_mcp_plugin_id(req.lmStudioMcpPluginId)
                lm_studio_mcp_metadata: dict
                lm_studio_context_metadata: dict

                if lm_studio_mcp_plugin_id:
                    if not req.apiKey:
                        data, content = await _post_openai_compatible_chat(client, req.apiUrl, headers, payload)
                        context_window = await _resolve_lm_studio_context_window(
                            client,
                            req.apiUrl,
                            headers,
                            req.model,
                            data,
                        )
                        lm_studio_context_metadata = _build_lm_studio_context_metadata(
                            data,
                            request_chars=_count_message_chars(messages),
                            truncated=False,
                            context_window=context_window,
                        )
                        lm_studio_mcp_metadata = _build_lm_studio_mcp_metadata(
                            lm_studio_mcp_plugin_id,
                            "openai-compatible",
                            fallback_reason=(
                                "LM Studio MCP plugin access requires an API token, so the proxy used the OpenAI-compatible endpoint."
                            ),
                        )
                    else:
                        lm_studio_url = _build_lm_studio_chat_url(req.apiUrl)
                        lm_studio_payload = _build_lm_studio_chat_payload(messages, req.model, lm_studio_mcp_plugin_id)

                        try:
                            resp = await client.post(lm_studio_url, headers=headers, json=lm_studio_payload)
                            resp.raise_for_status()
                            data = resp.json()
                            error_message = _extract_api_error_message(data)
                            if error_message:
                                return {"error": f"API error: {error_message}"}

                            tool_names = _extract_lm_studio_tool_names(data, lm_studio_mcp_plugin_id)
                            content = _extract_lm_studio_message_content(data)
                            if not content and _lm_studio_response_needs_fallback(data):
                                fallback_reason = "LM Studio returned invalid MCP tool output, so the proxy retried on the OpenAI-compatible endpoint."
                                data, content = await _post_openai_compatible_chat(client, req.apiUrl, headers, payload)
                                context_window = await _resolve_lm_studio_context_window(
                                    client,
                                    req.apiUrl,
                                    headers,
                                    req.model,
                                    data,
                                )
                                lm_studio_context_metadata = _build_lm_studio_context_metadata(
                                    data,
                                    request_chars=_count_message_chars(messages),
                                    truncated=False,
                                    context_window=context_window,
                                )
                                lm_studio_mcp_metadata = _build_lm_studio_mcp_metadata(
                                    lm_studio_mcp_plugin_id,
                                    "openai-compatible",
                                    fallback_reason=fallback_reason,
                                )
                            else:
                                context_window = await _resolve_lm_studio_context_window(
                                    client,
                                    req.apiUrl,
                                    headers,
                                    req.model,
                                    data,
                                )
                                lm_studio_context_metadata = _build_lm_studio_context_metadata(
                                    data,
                                    request_chars=_count_lm_studio_payload_chars(lm_studio_payload),
                                    truncated=_lm_studio_payload_truncated(lm_studio_payload),
                                    context_window=context_window,
                                )
                                lm_studio_mcp_metadata = _build_lm_studio_mcp_metadata(
                                    lm_studio_mcp_plugin_id,
                                    "api-v1-chat",
                                    tool_names=tool_names,
                                )
                        except httpx.HTTPStatusError as exc:
                            response_text = exc.response.text if exc.response is not None else ""
                            if not _should_fallback_lm_studio_request(exc.response.status_code, response_text):
                                raise

                            fallback_reason = _summarize_lm_studio_fallback_reason(
                                "LM Studio MCP routing was unavailable, so the proxy retried on the OpenAI-compatible endpoint.",
                                response_text,
                            )
                            data, content = await _post_openai_compatible_chat(client, req.apiUrl, headers, payload)
                            context_window = await _resolve_lm_studio_context_window(
                                client,
                                req.apiUrl,
                                headers,
                                req.model,
                                data,
                            )
                            lm_studio_context_metadata = _build_lm_studio_context_metadata(
                                data,
                                request_chars=_count_message_chars(messages),
                                truncated=False,
                                context_window=context_window,
                            )
                            lm_studio_mcp_metadata = _build_lm_studio_mcp_metadata(
                                lm_studio_mcp_plugin_id,
                                "openai-compatible",
                                fallback_reason=fallback_reason,
                            )
                        except httpx.TimeoutException:
                            data, content = await _post_openai_compatible_chat(client, req.apiUrl, headers, payload)
                            context_window = await _resolve_lm_studio_context_window(
                                client,
                                req.apiUrl,
                                headers,
                                req.model,
                                data,
                            )
                            lm_studio_context_metadata = _build_lm_studio_context_metadata(
                                data,
                                request_chars=_count_message_chars(messages),
                                truncated=False,
                                context_window=context_window,
                            )
                            lm_studio_mcp_metadata = _build_lm_studio_mcp_metadata(
                                lm_studio_mcp_plugin_id,
                                "openai-compatible",
                                fallback_reason=(
                                    "LM Studio MCP routing timed out, so the proxy retried on the OpenAI-compatible endpoint."
                                ),
                            )
                else:
                    data, content = await _post_openai_compatible_chat(client, req.apiUrl, headers, payload)
                    context_window = await _resolve_lm_studio_context_window(
                        client,
                        req.apiUrl,
                        headers,
                        req.model,
                        data,
                    )
                    lm_studio_context_metadata = _build_lm_studio_context_metadata(
                        data,
                        request_chars=_count_message_chars(messages),
                        truncated=False,
                        context_window=context_window,
                    )
                    lm_studio_mcp_metadata = _build_lm_studio_mcp_metadata(None, "openai-compatible")
            else:
                logger.info(
                    "Sending to provider | url=%s msgs=%d chars=%d",
                    req.apiUrl, len(payload.get("messages", [])),
                    sum(len(str(m.get("content", ""))) for m in payload.get("messages", []))
                )
                resp = await client.post(req.apiUrl, headers=headers, json=payload)
                resp.raise_for_status()
                data = resp.json()

                error_message = _extract_api_error_message(data)
                if error_message:
                    logger.error("Provider returned error | %s", error_message)
                    return {"error": f"API error: {error_message}"}

                content = _extract_provider_content(req.apiProvider, data)
                logger.info(
                    "Provider response | chars=%d has_tool_call=%s preview=%s",
                    len(content) if content else 0,
                    "yes" if _extract_tool_calls(content or "") else "no",
                    repr((content or "")[:120])
                )

            if not content:
                # Log the full response structure when content is empty — this
                # helps diagnose if the model returned tool_calls or other fields.
                logger.warning(
                    "Empty content in provider response | keys=%s finish_reason=%s tool_calls=%s",
                    list(data.keys()) if isinstance(data, dict) else "N/A",
                    data.get("choices", [{}])[0].get("finish_reason", "N/A") if isinstance(data, dict) else "N/A",
                    "yes" if isinstance(data, dict) and data.get("choices", [{}])[0].get("message", {}).get("tool_calls") else "no"
                )
                return {"error": "Empty response from API. Make sure a model is loaded in your local server."}

            # ── MCP Tool Call Processing Loop ──
            # After getting a response from ANY provider, check if the model
            # requested tool calls. If so, execute them and re-query the provider.
            # This makes all MCP tools available to every provider transparently.
            tool_turns = 0
            current_content = content
            current_messages = list(messages)

            # ── Auto-search fallback ──
            # If the model didn't call any tools on the first pass, do a backend
            # search and inject the results so it still gets grounded docs even
            # if it doesn't support tool calling.
            if not _extract_tool_calls(current_content):
                reference_query = _build_reference_lookup_query(req.messages)
                auto_context = _auto_search_context(reference_query)
                if auto_context:
                    logger.info(
                        "Auto-search fallback triggered | query_chars=%d result_chars=%d",
                        len(reference_query), len(auto_context)
                    )
                    tool_message = _build_tool_result_message(
                        {"name": "search_klipper_docs", "arguments": {"query": reference_query}},
                        auto_context,
                    )
                    current_messages.append({"role": "assistant", "content": current_content})
                    current_messages.append({"role": "user", "content": tool_message})
                    tool_turns += 1

                    # Re-query the model with the injected search results
                    if req.apiProvider == "anthropic":
                        system = None
                        filtered_messages = []
                        for msg in current_messages:
                            if msg.get("role") == "system":
                                system = msg["content"]
                            else:
                                filtered_messages.append(msg)
                        tool_payload: dict = {
                            "model": req.model,
                            "messages": filtered_messages,
                            "temperature": 0.1,
                        }
                        if system:
                            tool_payload["system"] = system
                    else:
                        tool_payload = {
                            "model": req.model,
                            "messages": current_messages,
                            "temperature": 0.1,
                        }

                    if req.apiProvider == "lm-studio" and req.apiKey:
                        lm_studio_url = _build_lm_studio_chat_url(req.apiUrl)
                        lm_studio_payload = _build_lm_studio_chat_payload(
                            current_messages, req.model, None
                        )
                        try:
                            resp = await client.post(lm_studio_url, headers=headers, json=lm_studio_payload)
                            resp.raise_for_status()
                            data = resp.json()
                            current_content = _extract_lm_studio_message_content(data) or ""
                        except Exception:
                            data, current_content = await _post_openai_compatible_chat(
                                client, req.apiUrl, headers, tool_payload
                            )
                    else:
                        logger.info(
                            "Auto-search re-query | msgs=%d chars=%d",
                            len(tool_payload.get("messages", [])),
                            sum(len(str(m.get("content", ""))) for m in tool_payload.get("messages", []))
                        )
                        resp = await client.post(req.apiUrl, headers=headers, json=tool_payload)
                        resp.raise_for_status()
                        data = resp.json()
                        current_content = _extract_provider_content(req.apiProvider, data) or ""
                        logger.info(
                            "Auto-search re-query response | chars=%d has_tool_call=%s preview=%s",
                            len(current_content),
                            "yes" if _extract_tool_calls(current_content) else "no",
                            repr(current_content[:120])
                        )

            while tool_turns < MAX_MCP_TOOL_TURNS:
                tool_calls = _extract_tool_calls(current_content)
                if not tool_calls:
                    if tool_turns > 0:
                        logger.info("Tool call loop done | turns=%d final_chars=%d", tool_turns, len(current_content))
                    break

                logger.info(
                    "Tool calls detected | turn=%d count=%d first=%s content_preview=%s",
                    tool_turns + 1, len(tool_calls),
                    tool_calls[0]["name"],
                    repr(current_content[:80])
                )

                # Process all tool calls found in the response
                for tool_call in tool_calls[:MAX_MCP_TOOL_TURNS]:
                    result_text = _execute_tool_call(tool_call)
                    logger.info(
                        "Tool executed | name=%s result_chars=%d",
                        tool_call["name"], len(result_text)
                    )
                    tool_message = _build_tool_result_message(tool_call, result_text)
                    # Strip tool call blocks from the assistant message so the
                    # re-query doesn't confuse native-function-calling models
                    # (Gemma, Llama 3.1+, Qwen, etc.) with raw special tokens.
                    clean_content = MCP_TOOL_BLOCK_RE.sub("", current_content).strip()
                    clean_content = ALT_TOOL_CALL_CONTENT_RE.sub("", clean_content).strip()
                    clean_content = CALL_SYNTAX_CLEANUP_RE.sub("", clean_content).strip()
                    clean_content = FUNC_CALL_CLEANUP_RE.sub("", clean_content).strip()
                    # Only append assistant message if there's actual text content.
                    # If the model ONLY emitted a tool call (no text), skip the
                    # assistant message entirely to avoid confusing the model
                    # with artificial placeholder text during re-query.
                    if clean_content:
                        current_messages.append({"role": "assistant", "content": clean_content})
                    current_messages.append({"role": "user", "content": tool_message})
                    tool_turns += 1

                # Build a new payload with the updated messages and re-query
                if req.apiProvider == "anthropic":
                    system = None
                    filtered_messages = []
                    for msg in current_messages:
                        if msg.get("role") == "system":
                            system = msg["content"]
                        else:
                            filtered_messages.append(msg)
                    tool_payload: dict = {
                        "model": req.model,
                        "messages": filtered_messages,
                        "temperature": 0.1,
                    }
                    if system:
                        tool_payload["system"] = system
                else:
                    tool_payload = {
                        "model": req.model,
                        "messages": current_messages,
                        "temperature": 0.1,
                    }

                # Re-query (skip LM Studio MCP plugin for tool follow-ups)
                if req.apiProvider == "lm-studio" and req.apiKey:
                    lm_studio_url = _build_lm_studio_chat_url(req.apiUrl)
                    lm_studio_payload = _build_lm_studio_chat_payload(
                        current_messages, req.model, None  # No MCP plugin for tool follow-ups
                    )
                    try:
                        resp = await client.post(lm_studio_url, headers=headers, json=lm_studio_payload)
                        resp.raise_for_status()
                        data = resp.json()
                        current_content = _extract_lm_studio_message_content(data) or ""
                    except Exception:
                        # Fall back to OpenAI-compatible
                        data, current_content = await _post_openai_compatible_chat(
                            client, req.apiUrl, headers, tool_payload
                        )
                else:
                    logger.info(
                        "Re-query | turn=%d msgs=%d chars=%d",
                        tool_turns, len(tool_payload.get("messages", [])),
                        sum(len(str(m.get("content", ""))) for m in tool_payload.get("messages", []))
                    )
                    resp = await client.post(req.apiUrl, headers=headers, json=tool_payload)
                    resp.raise_for_status()
                    data = resp.json()
                    current_content = _extract_provider_content(req.apiProvider, data) or ""
                    logger.info(
                        "Re-query response | turn=%d chars=%d has_tool_call=%s preview=%s",
                        tool_turns, len(current_content),
                        "yes" if _extract_tool_calls(current_content) else "no",
                        repr(current_content[:120])
                    )

            # Clean up any remaining tool call blocks in the final content
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

            # Collect tool names used during the MCP tool loop
            mcp_tool_names = _collect_tool_names(current_messages)

            logger.info(
                "Returning response | final_chars=%d tool_turns=%d tools=%s empty=%s",
                len(final_content), tool_turns,
                mcp_tool_names or [],
                "yes" if not final_content else "no"
            )
            if not final_content:
                logger.warning("Empty final content after %d tool turns", tool_turns)

            if req.apiProvider == "lm-studio":
                return {
                    "content": final_content,
                    "lmStudioMcp": lm_studio_mcp_metadata,
                    "lmStudioContext": lm_studio_context_metadata,
                    "mcpToolTurns": tool_turns,
                    "mcpToolNames": mcp_tool_names,
                }

            return {
                "content": final_content,
                "mcpToolTurns": tool_turns,
                "mcpToolNames": mcp_tool_names,
            }
        except ValueError as e:
            logger.error("API error | %s", str(e))
            return {"error": f"API error: {str(e)}"}
        except httpx.TimeoutException:
            logger.error("Request timed out")
            return {"error": "API request timed out before the model finished responding."}
        except httpx.HTTPError as e:
            logger.error("HTTP error | %s", str(e))
            return {"error": f"API request failed: {str(e)}"}
