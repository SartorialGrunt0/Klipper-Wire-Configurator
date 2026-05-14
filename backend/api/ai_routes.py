"""Klipper Wire Configurator - AI Chat Backend Proxy"""
from enum import Enum
from functools import lru_cache
from pathlib import Path
import re
from urllib.parse import urlparse, urlunparse

from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter()

REFERENCE_DIR = Path(__file__).parent.parent.parent / "reference"
KLIPPER_DOCS_DIR = REFERENCE_DIR / "reference_docs" / "klipper_docs"
CONFIG_REFERENCE_PATH = KLIPPER_DOCS_DIR / "Config_Reference.md"
KLIPPER_DOCS_SUMMARY_PATH = KLIPPER_DOCS_DIR / "Klipper_Docs_AI_Summary.md"
OFFICIAL_CONFIG_REFERENCE_URL = "https://www.klipper3d.org/Config_Reference.html"
OFFICIAL_KLIPPER_DOC_URL_TEMPLATE = "https://www.klipper3d.org/{document_name}.html"
QUERY_STOP_WORDS = {
    "a",
    "an",
    "and",
    "are",
    "can",
    "cfg",
    "config",
    "configuration",
    "do",
    "for",
    "from",
    "help",
    "how",
    "i",
    "in",
    "is",
    "it",
    "klipper",
    "me",
    "my",
    "of",
    "on",
    "or",
    "please",
    "printer",
    "set",
    "settings",
    "show",
    "tell",
    "that",
    "the",
    "this",
    "to",
    "use",
    "what",
    "with",
}
MAX_CONFIG_REFERENCE_RESULTS = 3
MAX_CONFIG_REFERENCE_SECTION_CHARS = 3200
MAX_KLIPPER_DOCS_SUMMARY_RESULTS = 4
MAX_KLIPPER_DOCS_SUMMARY_SECTION_CHARS = 2800
MAX_FULL_KLIPPER_DOC_RESULTS = 2
MAX_REFERENCE_LOOKBACK_USER_MESSAGES = 3
MAX_REFERENCE_LOOKUP_QUERY_CHARS = 1800
CONFIG_REFERENCE_SECTION_RE = re.compile(r"^### \[([^\]]+)\]\s*$", re.MULTILINE)
CONFIG_REFERENCE_ALIAS_RE = re.compile(r"^\[([^\]]+)\]\s*$", re.MULTILINE)
KLIPPER_DOCS_SUMMARY_SECTION_RE = re.compile(r"^## (?!#)(.+?)\s*$", re.MULTILINE)
REFERENCE_ALIASES_RE = re.compile(r"^Aliases:\s*(.+)\s*$", re.MULTILINE)
REFERENCE_SOURCE_DOCS_RE = re.compile(r"^Source docs:\s*(.+)\s*$", re.MULTILINE)
FULL_DOC_REQUEST_WORDS = {"complete", "entire", "full", "raw"}
FULL_DOC_TARGET_WORDS = {
    "content",
    "contents",
    "doc",
    "docs",
    "document",
    "markdown",
    "reference",
    "section",
    "source",
}
LM_STUDIO_KLIPPER_DOCS_PLUGIN_ID = "mcp/klipper-docs"
LM_STUDIO_MAX_INPUT_CHARS = 48000
LM_STUDIO_MAX_HISTORY_MESSAGES = 16
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
    "You are a klipper firmware and configuration expert who responds in clear, "
    "short, and concise answers to help with klipper firmware questions. If you edit a configuration section, always show the whole section in your response." \
    "If you suggest a content change, site the reference documentation section you used, and quote the exact section header and parameter names from the docs. " \
    "If you don't know the answer, say you don't know and suggest what to verify or ask next instead of guessing."
)
DOCS_GROUNDING_PROMPT = (
    "Ground all Klipper configuration guidance in documentation before answering. "
    "If your runtime exposes a `klipper-docs` MCP server or tool, call it first for "
    "configuration questions. If the tool is unavailable or the tool call fails, use "
    f"the official Klipper Config Reference at {OFFICIAL_CONFIG_REFERENCE_URL}. "
    "Treat any bundled Klipper_Docs_AI_Summary excerpts as condensed routing notes and "
    "any bundled Config_Reference excerpts included in this prompt as authoritative "
    "offline reference material for section names and parameters. If the summary is not "
    "enough, ask for the full Klipper source document by filename; if local markdown is "
    "unavailable, use https://www.klipper3d.org/<document_name>.html. Do not invent "
    "section names, parameters, defaults, units, commands, or supported behavior. If "
    "the docs do not confirm a detail, say that explicitly and ask one short clarifying "
    "question or state what must be verified. When suggesting config changes, use the "
    "exact Klipper section headers and parameter names from the docs and prefer minimal "
    "edits over full-file rewrites."
)


class AiProvider(str, Enum):
    chatgpt = "chatgpt"
    google = "google"
    anthropic = "anthropic"
    github = "github"
    openai_compatible = "openai-compatible"
    lm_studio = "lm-studio"
    ollama = "ollama"


class ChatRequest(BaseModel):
    messages: list[dict]
    apiKey: str
    model: str = "gpt-4o"
    apiUrl: str = "https://api.openai.com/v1/chat/completions"
    apiProvider: AiProvider = AiProvider.chatgpt
    lmStudioMcpPluginId: str | None = None


def _tokenize_query(text: str) -> list[str]:
    tokens = re.findall(r"[a-z0-9_\-]{2,}", text.lower())
    return [token for token in tokens if token not in QUERY_STOP_WORDS]


def _read_reference_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def _extract_markdown_sections(content: str, section_re: re.Pattern[str]) -> list[tuple[str, str]]:
    matches = list(section_re.finditer(content))
    sections: list[tuple[str, str]] = []

    for index, match in enumerate(matches):
        header = match.group(1).strip()
        start = match.start()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(content)
        sections.append((header, content[start:end].strip()))

    return sections


def _split_reference_csv(value: str) -> tuple[str, ...]:
    return tuple(item.strip() for item in value.split(",") if item.strip())


def _build_doc_aliases(document_name: str) -> set[str]:
    stem = Path(document_name).stem
    spaced_stem = stem.replace("_", " ").replace("-", " ")
    aliases = {
        document_name,
        stem,
        spaced_stem,
        spaced_stem.replace(" ", ""),
    }
    return {alias for alias in aliases if alias}


def _build_official_klipper_doc_url(document_name: str) -> str:
    return OFFICIAL_KLIPPER_DOC_URL_TEMPLATE.format(document_name=Path(document_name).stem)


@lru_cache(maxsize=1)
def _load_config_reference_sections() -> list[tuple[str, str, set[str]]]:
    if not CONFIG_REFERENCE_PATH.exists():
        return []

    try:
        content = _read_reference_text(CONFIG_REFERENCE_PATH)
    except OSError:
        return []

    sections: list[tuple[str, str, set[str]]] = []

    for header, section_text in _extract_markdown_sections(content, CONFIG_REFERENCE_SECTION_RE):
        aliases = {header}
        aliases.update(alias.strip() for alias in CONFIG_REFERENCE_ALIAS_RE.findall(section_text))
        sections.append((header, section_text, {alias for alias in aliases if alias}))

    return sections


@lru_cache(maxsize=1)
def _load_klipper_docs_summary_sections() -> list[tuple[str, str, set[str], tuple[str, ...]]]:
    if not KLIPPER_DOCS_SUMMARY_PATH.exists():
        return []

    try:
        content = _read_reference_text(KLIPPER_DOCS_SUMMARY_PATH)
    except OSError:
        return []

    sections: list[tuple[str, str, set[str], tuple[str, ...]]] = []

    for header, section_text in _extract_markdown_sections(content, KLIPPER_DOCS_SUMMARY_SECTION_RE):
        aliases = {header}
        alias_match = REFERENCE_ALIASES_RE.search(section_text)
        if alias_match:
            aliases.update(_split_reference_csv(alias_match.group(1)))

        source_docs: tuple[str, ...] = ()
        source_docs_match = REFERENCE_SOURCE_DOCS_RE.search(section_text)
        if source_docs_match:
            source_docs = _split_reference_csv(source_docs_match.group(1))
            for document_name in source_docs:
                aliases.update(_build_doc_aliases(document_name))

        sections.append((header, section_text, {alias for alias in aliases if alias}, source_docs))

    return sections


@lru_cache(maxsize=1)
def _load_klipper_doc_catalog() -> list[tuple[str, Path, set[str]]]:
    if not KLIPPER_DOCS_DIR.exists():
        return []

    catalog: list[tuple[str, Path, set[str]]] = []
    for path in sorted(KLIPPER_DOCS_DIR.glob("*.md")):
        if path.name == KLIPPER_DOCS_SUMMARY_PATH.name:
            continue
        catalog.append((path.name, path, _build_doc_aliases(path.name)))

    return catalog


def _normalize_lookup_text(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


def _score_reference_section(query_text: str, aliases: set[str]) -> int:
    query_words = set(query_text.split())
    score = 0

    for alias in aliases:
        alias_text = _normalize_lookup_text(alias)
        if not alias_text:
            continue

        alias_words = set(alias_text.split())
        if query_text == alias_text:
            score = max(score, 100)
            continue
        if alias_text in query_text:
            score = max(score, 70)
            continue
        if alias_words and alias_words.issubset(query_words):
            score = max(score, 50)
            continue

        overlap = len(alias_words & query_words)
        if overlap:
            score = max(score, overlap * 10)

    return score


def _trim_reference_section(section_text: str, max_chars: int) -> str:
    if len(section_text) <= max_chars:
        return section_text

    return (
        f"{section_text[:max_chars].rstrip()}\n\n"
        f"[Section truncated after {max_chars} characters.]"
    )


def _get_config_reference_context(query: str, limit: int = MAX_CONFIG_REFERENCE_RESULTS) -> list[str]:
    query_text = _normalize_lookup_text(query)
    if not query_text:
        return []

    scored_sections: list[tuple[int, str]] = []

    for _header, section_text, aliases in _load_config_reference_sections():
        score = _score_reference_section(query_text, aliases)
        if score == 0:
            continue

        scored_sections.append((score, _trim_reference_section(section_text, MAX_CONFIG_REFERENCE_SECTION_CHARS)))

    scored_sections.sort(key=lambda item: item[0], reverse=True)
    return [section_text for _, section_text in scored_sections[:limit]]


def _get_scored_klipper_docs_summary_sections(query: str) -> list[tuple[int, str, tuple[str, ...]]]:
    query_text = _normalize_lookup_text(query)
    if not query_text:
        return []

    scored_sections: list[tuple[int, str, tuple[str, ...]]] = []

    for _header, section_text, aliases, source_docs in _load_klipper_docs_summary_sections():
        score = _score_reference_section(query_text, aliases)
        if score == 0:
            continue
        scored_sections.append((score, section_text, source_docs))

    scored_sections.sort(key=lambda item: item[0], reverse=True)
    return scored_sections


def _get_klipper_docs_summary_context(query: str, limit: int = MAX_KLIPPER_DOCS_SUMMARY_RESULTS) -> list[str]:
    return [
        _trim_reference_section(section_text, MAX_KLIPPER_DOCS_SUMMARY_SECTION_CHARS)
        for _score, section_text, _source_docs in _get_scored_klipper_docs_summary_sections(query)[:limit]
    ]


def _query_requests_full_doc(query: str) -> bool:
    query_tokens = set(_tokenize_query(query))
    return bool(query_tokens & FULL_DOC_REQUEST_WORDS) and bool(query_tokens & FULL_DOC_TARGET_WORDS)


def _get_requested_klipper_doc_names(query: str, limit: int = MAX_FULL_KLIPPER_DOC_RESULTS) -> list[str]:
    query_text = _normalize_lookup_text(query)
    if not query_text:
        return []

    scored_docs: list[tuple[int, str]] = []
    for document_name, _path, aliases in _load_klipper_doc_catalog():
        score = _score_reference_section(query_text, aliases)
        if score == 0:
            continue
        scored_docs.append((score, document_name))

    scored_docs.sort(key=lambda item: (-item[0], item[1]))
    return [document_name for _score, document_name in scored_docs[:limit]]


def _get_full_klipper_docs_context(query: str, limit: int = MAX_FULL_KLIPPER_DOC_RESULTS) -> list[str]:
    if not _query_requests_full_doc(query):
        return []

    document_names = _get_requested_klipper_doc_names(query, limit=limit)
    if not document_names:
        for _score, _section_text, source_docs in _get_scored_klipper_docs_summary_sections(query):
            for document_name in source_docs:
                if document_name in document_names:
                    continue
                document_names.append(document_name)
                if len(document_names) >= limit:
                    break
            if len(document_names) >= limit:
                break

    contexts: list[str] = []
    for document_name in document_names[:limit]:
        document_path = KLIPPER_DOCS_DIR / document_name
        if not document_path.exists():
            continue
        try:
            document_text = _read_reference_text(document_path)
        except OSError:
            continue
        contexts.append(
            f"Full bundled Klipper document: {document_name}\n"
            f"Official HTML mirror: {_build_official_klipper_doc_url(document_name)}\n\n"
            f"{document_text}"
        )

    return contexts


def _build_reference_lookup_query(messages: list[dict]) -> str:
    recent_user_messages: list[str] = []

    for msg in reversed(messages):
        if msg.get("role") != "user":
            continue

        content = str(msg.get("content", "")).strip()
        if not content:
            continue

        recent_user_messages.append(content)
        if len(recent_user_messages) >= MAX_REFERENCE_LOOKBACK_USER_MESSAGES:
            break

    if not recent_user_messages:
        return ""

    combined = "\n\n".join(reversed(recent_user_messages))
    if len(combined) <= MAX_REFERENCE_LOOKUP_QUERY_CHARS:
        return combined
    return combined[-MAX_REFERENCE_LOOKUP_QUERY_CHARS:]


def _is_local_provider(provider: str) -> bool:
    return provider in ("lm-studio", "ollama")


def _prepare_messages(messages: list[dict]) -> list[dict]:
    system_parts = [SYSTEM_PROMPT, DOCS_GROUNDING_PROMPT]
    reference_lookup_query = _build_reference_lookup_query(messages)
    klipper_docs_summary_context = _get_klipper_docs_summary_context(reference_lookup_query)
    config_reference_context = _get_config_reference_context(reference_lookup_query)
    full_klipper_docs_context = _get_full_klipper_docs_context(reference_lookup_query)
    if klipper_docs_summary_context:
        system_parts.append(
            "Relevant sections from the bundled Klipper_Docs_AI_Summary.md for the recent user request(s):\n\n"
            + "\n\n---\n\n".join(klipper_docs_summary_context)
        )
    if config_reference_context:
        system_parts.append(
            "Relevant sections from the bundled Config_Reference.md for the recent user request(s):\n\n"
            + "\n\n---\n\n".join(config_reference_context)
        )
    if full_klipper_docs_context:
        system_parts.append(
            "Full bundled Klipper markdown document(s) requested explicitly by the user:\n\n"
            + "\n\n---\n\n".join(full_klipper_docs_context)
        )
    if not klipper_docs_summary_context and not config_reference_context and not full_klipper_docs_context:
        system_parts.append(
            "No bundled Klipper docs summary, Config_Reference, or full-document excerpts were matched "
            "for the recent user request(s). "
            f"If you cannot use `klipper-docs`, fall back to {OFFICIAL_CONFIG_REFERENCE_URL} "
            "and avoid guessing."
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

    return [{"role": "system", "content": "\n\n".join(system_parts)}] + prepared


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
        # OpenAI, Gemini OpenAI-compat, GitHub Copilot, and OpenAI Compatible all use Bearer auth
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
        # OpenAI-compatible chat providers use the standard messages format
        payload = {
            "model": req.model,
            "messages": messages,
        }

    timeout = httpx.Timeout(connect=15.0, read=None, write=120.0, pool=120.0)

    async with httpx.AsyncClient(timeout=timeout) as client:
        try:
            if req.apiProvider == "lm-studio":
                lm_studio_mcp_plugin_id = _normalize_lm_studio_mcp_plugin_id(req.lmStudioMcpPluginId)
                lm_studio_mcp_metadata: dict

                if lm_studio_mcp_plugin_id:
                    if not req.apiKey:
                        data, content = await _post_openai_compatible_chat(client, req.apiUrl, headers, payload)
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
                                lm_studio_mcp_metadata = _build_lm_studio_mcp_metadata(
                                    lm_studio_mcp_plugin_id,
                                    "openai-compatible",
                                    fallback_reason=fallback_reason,
                                )
                            else:
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
                            lm_studio_mcp_metadata = _build_lm_studio_mcp_metadata(
                                lm_studio_mcp_plugin_id,
                                "openai-compatible",
                                fallback_reason=fallback_reason,
                            )
                        except httpx.TimeoutException:
                            data, content = await _post_openai_compatible_chat(client, req.apiUrl, headers, payload)
                            lm_studio_mcp_metadata = _build_lm_studio_mcp_metadata(
                                lm_studio_mcp_plugin_id,
                                "openai-compatible",
                                fallback_reason=(
                                    "LM Studio MCP routing timed out, so the proxy retried on the OpenAI-compatible endpoint."
                                ),
                            )
                else:
                    data, content = await _post_openai_compatible_chat(client, req.apiUrl, headers, payload)
                    lm_studio_mcp_metadata = _build_lm_studio_mcp_metadata(None, "openai-compatible")
            else:
                resp = await client.post(req.apiUrl, headers=headers, json=payload)
                resp.raise_for_status()
                data = resp.json()

                error_message = _extract_api_error_message(data)
                if error_message:
                    return {"error": f"API error: {error_message}"}

                content = _extract_provider_content(req.apiProvider, data)

            if not content:
                return {"error": "Empty response from API. Make sure a model is loaded in your local server."}

            if req.apiProvider == "lm-studio":
                return {"content": content, "lmStudioMcp": lm_studio_mcp_metadata}

            return {"content": content}
        except ValueError as e:
            return {"error": f"API error: {str(e)}"}
        except httpx.TimeoutException:
            return {"error": "API request timed out before the model finished responding."}
        except httpx.HTTPError as e:
            return {"error": f"API request failed: {str(e)}"}
