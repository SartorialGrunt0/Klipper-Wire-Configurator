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

from api.printer_memory_routes import (  # noqa: E402
    derive_hardware_inventory,
    derive_machine_facts,
    format_hardware_inventory,
    load_printer_memory,
    printer_memory_to_context,
    is_printer_memory_blank,
)
from mcp_server import McpServer
from services.ai_draft_apply import extract_config_code_blocks
from services.ai_edit_tools import (
    APPROVAL_TIMEOUT_SECONDS,
    EDIT_NUDGE_TEXT,
    EDIT_NUDGE_TEXT_NATIVE,
    EDIT_PROTOCOL_PROMPT,
    EDIT_TOOL_NAMES,
    EDIT_TOOL_SPECS,
    EditSession,
    create_approval,
    find_approval_for_request,
    format_approval_result,
    get_approval,
    remove_approval,
)

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
    # The closing fence may sit on the SAME line as the JSON
    # (`{"name": ...}```) — qwen3.5-4b does this constantly (observed live
    # 2026-09-09 accuracy bank, LIVE-06/07). Requiring a newline before the
    # closer made such calls undetectable AND un-strippable: raw markup
    # reached the chat bubble. Consumers strip() the group themselves.
    r"```tool\s*\n(.+?)```",
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
# Matches "call tool_name{...}" or "tool_name{...}" for non-JSON tool call text.
# Also accepts the llama.cpp/Qwen-style "call:tool_call:tool_name{...}" prefix
# emitted inside <|tool_call|> tokens by models with native tool templates.
# Guarded against Klipper macro syntax: the brace must NOT be a Jinja tag
# ({% / {{) and the args must contain a key-value signature (':' or '=') —
# otherwise legit macro content like "G28\n    {% endif %}" or
# "{action_respond_info(...)}" is misparsed as a tool call and the final
# cleanup strips it from the visible reply (2026-08-02: this was eating
# BED_MESH_CALIBRATE + {% endif %} and G28 + {% else %} out of correct
# model replies).
# Key-signature lookahead (`(?=[^}]*[:=])`): the args must contain a ':' or
# '=' before the first '}'. Klipper macro bodies contain the idiom
# `RESUME_BASE {get_params}` — a macro call followed by a Jinja dict — and
# without this guard it extracted a phantom zero-arg RESUME_BASE tool call
# inside a correct macro-move answer (AMBI-02 r3b run 2026-09-15). Real
# text-protocol calls always carry key=value or key: value.
CALL_SYNTAX_RE = re.compile(
    r"(?:^|\n)\s*(?:call[\s:]?\s*)?(?:tool_call[\s:]*)?(\w+)\s*\{(?!%|\{)"
    r"(?=[^}]*[:=])(.+)\}",
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
# Same Jinja/key-value guards as CALL_SYNTAX_RE so Klipper macro bodies
# (G-code lines followed by {% ... %} or {action_respond_info(...)}) are
# never stripped from the visible reply.
CALL_SYNTAX_CLEANUP_RE = re.compile(
    r"(?:^|\n)\s*(?:call[\s:]?\s*)?(?:tool_call[\s:]*)?\w+\s*\{(?!%|\{)[^}]*[:=][^}]*\}\s*(?=\n|$)",
    re.DOTALL,
)
FUNC_CALL_CLEANUP_RE = re.compile(
    r"(?:^|\n)\s*(?:call[\s:]?\s*)?(?:tool_call[\s:]*)?\w+\s*\([^)]*\)\s*(?=\n|$)",
    re.DOTALL,
)
# Bracket-wrapped Python-style calls: [tool_name(arg1="val1", arg2=val2)].
# Emitted as plain text by models that know the OpenAI-style [tool(args)]
# rendering but not the configured protocol (observed 2026-08 on local
# models: [read_user_config(filename=Hotkey.cfg)] leaked into chat because
# FUNC_CALL_RE is line-anchored and the '[' defeats it). Extraction and
# cleanup are gated on KNOWN tool names so config headers ([probe]) and
# prose with parens are never treated as calls.
BRACKET_CALL_RE = re.compile(
    r"\[\s*(\w+)\s*\(\s*(.+?)\s*\)\s*\]",
    re.DOTALL,
)
# DeepSeek DSML (Data Structure Markup Language) native tool-call markup.
# DeepSeek V3.2/V4 models emit tool calls as:
#   <||DSML||tool_calls>
#   <||DSML||invoke name="search_klipper_docs">
#   <||DSML||parameter name="limit" string="false">10</||DSML||parameter>
#   <||DSML||parameter name="query" string="true">bed_mesh adaptive</||DSML||parameter>
#   </||DSML||invoke>
#   </||DSML||tool_calls>
# Some serving stacks (vLLM/sglang bugs, plain-text content mode) return this
# markup inside message.content instead of structured tool_calls, so KWC must
# parse it from text. Tolerates both ||DSML|| and |DSML| delimiters and stray
# whitespace around the pipes.
DSML_INVOKE_RE = re.compile(
    r"<\|{1,2}\s*DSML\s*\|{1,2}\s*invoke\s+name=\"([^\"]*)\"[^>]*>(.*?)"
    r"</\|{1,2}\s*DSML\s*\|{1,2}\s*invoke\s*>",
    re.DOTALL,
)
DSML_PARAM_RE = re.compile(
    r"<\|{1,2}\s*DSML\s*\|{1,2}\s*parameter\s+name=\"([^\"]*)\"[^>]*>(.*?)"
    r"</\|{1,2}\s*DSML\s*\|{1,2}\s*parameter\s*>",
    re.DOTALL,
)
# Full DSML tool_calls block; used to strip leaked markup from final content.
DSML_CLEANUP_RE = re.compile(
    r"<\|{1,2}\s*DSML\s*\|{1,2}\s*tool_calls\s*>.*?</\|{1,2}\s*DSML\s*\|{1,2}\s*tool_calls\s*>",
    re.DOTALL,
)

# Bare XML tool-call blocks (Anthropic/DeepSeek style) emitted as plain
# text when the model cannot use native tool_calls (e.g. an empty-reprompt
# sent without the tools parameter). DeepSeek V3.2/V4 "flash" models ignore
# the no-tools instruction and emit:
#   <tool_calls>
#   <invoke name="search_example_configs">
#   <parameter name="query" string="true">PC2 PB9 PC3</parameter>
#   </invoke>
#   </tool_calls>
XML_INVOKE_RE = re.compile(
    r"<invoke\s+name=\"([^\"]*)\"[^>]*>(.*?)</invoke>",
    re.DOTALL,
)
XML_PARAM_RE = re.compile(
    r"<parameter\s+name=\"([^\"]*)\"[^>]*>(.*?)</parameter>",
    re.DOTALL,
)
# Full <tool_calls>...</tool_calls> wrapper; stripped from visible content.
XML_TOOL_CALLS_CLEANUP_RE = re.compile(
    r"<tool_calls>.*?</tool_calls>",
    re.DOTALL,
)

# Prose edit protocol (fenced cfg blocks / mini-diff) RETIRED 2026-09-22 with
# the Phase-4 ratchet (.hermes/plans/2026-09-10_tool-mediated-config-editing.md):
# config edits go through config_edit/config_write + the approval card; fenced
# cfg output is display-only text. Models may still paste cfg fences in prose —
# that is fine, nothing consumes them as edits anymore.


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
    "content with read_user_config (or list_user_configs to see which files "
    "exist) if it is not already in your context. Never ask the user to paste "
    "content the tools can fetch.\n"
    "- When the request covers a CLASS of items ('all my LEDs', 'every fan', "
    "'all my macros'), enumerate the whole class BEFORE drafting: class "
    "members frequently live in OTHER files (toolhead/board configs), not "
    "just the attached ones. Seeing some members in the attached context is "
    "NOT proof the class is complete — sections in files you cannot see are "
    "invisible to you. Call list_hardware(type='led'|'fan'|'stepper'|...) "
    "FIRST — it enumerates EVERY member of the class in one call from "
    "the working state, with full section text and file+line (text "
    "search finds only sections whose name contains the keyword). "
    "search_user_configs with the class keyword (e.g. query='neopixel') "
    "remains a fallback for things list_hardware has no class for. "
    "Edit every member "
    "found, and before finishing, check your edit lines against the "
    "enumerated list: every member must be covered. Never silently handle "
    "only the subset visible in your context; if some files cannot be "
    "checked, name what you covered and what you could not verify.\n"
    "- When the user asks to ADD or SETUP a section or parameter, verify the "
    "exact section name and its valid parameters BEFORE writing the draft: "
    "list the supported sections with list_config_reference_sections, then "
    "fetch the exact one with get_config_reference_section(section_name=...) "
    "(or search_klipper_docs). A section absent from the user's config may "
    "still be valid Klipper. Do not invent section names or parameters from "
    "memory. Never claim a section 'does not support' a parameter or that "
    "Klipper 'lacks' a feature from memory either — check "
    "get_section_schema(section='...') first; if the schema lists it, use "
    "it. If the user did not specify values, use the documented defaults "
    "or a safe standard value and SAY what you chose — do not ask the user "
    "to provide values the reference already documents.\n"
    "- For macros: valid Klipper syntax, conservative motion and temperature behavior. Never "
    "drop, reorder, or reword lines that were not part of the request.\n"
    "- When asked to validate or error-check a macro or g-code, check execution "
    "prerequisites, not just syntax — e.g. BED_MESH_CALIBRATE needs homed axes (G28 "
    "first), G1 E moves need an active extruder with temperature. Name the missing "
    "prerequisite explicitly in your answer.\n"
    "- After config or macro code, briefly explain what changed, why, and cite the exact "
    "documentation section header and parameter or command names you relied on.\n"
    "- Klipper G-code commands and macro names (G28, M104, BED_MESH_CALIBRATE, "
    "SET_FAN_SPEED, PRINT_START, etc.) are NOT tools — never invoke them as "
    "tool calls.\n"
)


class AiProvider(str, Enum):
    chatgpt = "chatgpt"
    google = "google"
    anthropic = "anthropic"
    github = "github"
    openai_compatible = "openai-compatible"

class ModelsRequest(BaseModel):
    """Model-list proxy request — mirrors the fields the chat proxy needs."""
    apiKey: str = ""
    apiUrl: str = "https://api.openai.com/v1/chat/completions"
    apiProvider: AiProvider = AiProvider.chatgpt


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
    # Loaded user-config content sent by the frontend (filename ->
    # {"content", "label"}) for the config-grounding fallback. Held
    # server-side only — it is NOT injected into the first prompt; the
    # fallback uses it when the model answers without calling any tool.
    contextFiles: dict[str, dict[str, str]] = {}
    # Tool-calling protocol override (frontend setting / harness runs).
    # "auto" (default) uses NATIVE function calling for every provider,
    # local llama.cpp included — the machine channel keeps protocol text out
    # of prompts and results out of user-role messages (verified b456
    # --jinja 2026-09); the loop still regex-extracts text calls as a
    # fallback. "text" forces the ```tool protocol (escape hatch for
    # servers that advertise tools but emit template garbage); "native"
    # pins native explicitly. scripts/ai_chat_accuracy_test.py A/Bs these.
    toolProtocol: str = "auto"
    # Tool-mediated editing override (harness A/B runs ONLY; the frontend
    # never sends it). None = env KWC_EDIT_TOOLS decides; True/False forces
    # the write tools on/off for this request. Mirrors the toolProtocol
    # precedent so A/B runs don't need backend restarts.
    editTools: bool | None = None
    # Phase 3 skill-gate override (harness A/B runs ONLY; the frontend
    # never sends it). True forces the skill ACTIVE for the request (write
    # tools advertised immediately) so SKILL-* evals can grade traces on
    # both arms; None/False = env KWC_EDIT_SKILL_GATE decides and the
    # model must call load_skill itself to unlock the write tools.
    editSkill: bool | None = None
    # Approval-gate override (harness A/B runs ONLY; the frontend never
    # sends it). Production default is human-only approval: with the edit
    # tools on, every validated write suspends for a card. The accuracy
    # bank must see model behavior PAST the gate, so it sets this True —
    # which bypasses ONLY the Future await, never re-validation (invalid
    # ops still kick back identically).
    autoApproveEdits: bool = False
    # Merge every system message into a single leading system message.
    # Default off: most OpenAI-compatible servers accept multiple system
    # messages and the trailing task anchor is positionally meaningful
    # (it points the model at the last user message after tool rounds).
    # Some strict chat templates (e.g. models enforcing "system message
    # must be at the beginning") reject any non-leading system message.
    # Merge is now the DEFAULT for every OpenAI-compatible request — a
    # single leading system message is the canonical shape every server
    # accepts. Set False explicitly only for A/B testing the trailing
    # task-anchor position.
    mergeSystemMessages: bool = True
    # Prose-draft machinery (the fullRewriteGuard request field, server-side
    # draft validation/audit, and the KWC_SERVER_DRAFT_VALIDATION /
    # KWC_POST_APPLY_AUDIT env switches) was removed with the Phase-4 ratchet
    # (2026-09-22): prose→draft ingestion no longer exists.


@router.get("/ai/chat/approval")
async def chat_approval_poll(requestId: str = ""):
    """Poll the pending approval card for an in-flight /ai/chat request.

    The chat request itself stays open while the loop suspends on the
    approval Future (plan §97); the frontend discovers the card through
    this lightweight poll. ``{pending: false}`` when no card is open.
    """
    if not requestId:
        return {"pending": False}
    approval = find_approval_for_request(requestId)
    if approval is None:
        return {"pending": False}
    return {"pending": True, **approval.card_payload()}


class ApprovalDecisionRequest(BaseModel):
    approvalId: str
    decision: str  # "approve" | "decline"
    reason: str = ""
    # Frontend's latest working content at decision time ({file: {content,
    # label}}). An approve re-applies the op against THIS state — a manual
    # edit during the pending window can invalidate an anchor or create a
    # new error (never clobber).
    contextFiles: dict[str, dict[str, str]] = {}


@router.post("/ai/chat/approval")
async def chat_approval_decide(req: ApprovalDecisionRequest):
    """Resolve a pending approval card.

    approve  → op re-validated+committed against contextFiles (when
               provided); decision accepted only if clean. On anchor
               miss / new errors the decision is NOT accepted:
               {status: 'invalidated', reason} and the card stays open
               (user can decline or resolve the conflict and retry).
    decline  → accepted immediately; the model loop resumes with an
               honest declined tool result.
    """
    approval = get_approval(req.approvalId)
    if approval is None:
        return {"status": "not_found"}
    if req.decision not in ("approve", "decline"):
        return {"status": "invalid", "reason": "decision must be approve or decline"}
    outcome = approval.decide(
        req.decision,
        reason=req.reason[:500],
        context_files=req.contextFiles or None,
    )
    logger.info(
        "Approval decision | approvalId=%s decision=%s outcome=%s",
        req.approvalId, req.decision, outcome.get("status"),
    )
    return outcome


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


def _prepare_messages(messages: list[dict],
                      edit_capable: bool = False, *,
                      skill_gate: bool = False,
                      skill_active: bool = False,
                      native_mode: bool = False,
                      context_files: dict | None = None) -> list[dict]:
    """Build a clean system prompt with MCP tool descriptions, printer memory,
    and user messages.
    """
    minimal = _minimal_prompt_enabled()
    system_prompt = SYSTEM_PROMPT
    no_system = _no_system_prompt_enabled()

    # ── Inject printer memory context ──
    memory = load_printer_memory()
    memory_context = printer_memory_to_context(memory)
    memory_blank = is_printer_memory_blank(memory)

    if no_system:
        # Experiment gate: no system content at all — no tools, no prompt,
        # no memory, no anchor. Just the conversation.
        system_parts: list[str] = []
    elif minimal:
        # Experiment gate: tools only — no SYSTEM_PROMPT, no printer memory,
        # no auto-fill, no task anchor.
        system_parts = [_build_mcp_tool_context()]
    else:
        # All tools are advertised unconditionally (native/text parity);
        # detect_board and other niche helpers live under "Specialized tools".
        tool_context = _build_mcp_tool_context(edit_capable=edit_capable,
                                               skill_gate=skill_gate,
                                               skill_active=skill_active,
                                               native_mode=native_mode)
        system_parts = [system_prompt, tool_context, memory_context]
        if edit_capable and not skill_gate:
            # Edit law only when the write tools are advertised (lazy
            # context). With skill_gate the law travels inside the
            # load_skill tool result (skill body) instead, persisting in
            # conversation history exactly once.
            system_parts.append(EDIT_PROTOCOL_PROMPT)

        # If printer memory is completely blank and there are user messages
        # to work with, add an auto-fill instruction asking the AI to
        # investigate.
        if memory_blank:
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
                "JSON — no surrounding explanation or markdown inside the block. Only these 9 fields "
                "are allowed; unsupported fields will be rejected: mainboard, toolheadBoard, "
                "expanderBoards, printerName, kinematics, probe, buildVolume, extruderType, "
                "additionalNotes. extruderType accepts ONLY 'direct' or 'bowden'. Omit fields you "
                "cannot determine — never guess.\n"
                "   ```printer-memory\n"
                "   {\"mainboard\": \"BTT Octopus Pro v1.1\", \"kinematics\": \"CoreXY\", "
                "\"buildVolume\": \"250x250x210\", \"extruderType\": \"direct\"}\n"
                "   ```\n"
                "The user confirms in a review dialog before anything is saved — do NOT save printer "
                "memory directly."
            )
            if skill_gate:
                # The full fact-finding playbook lives in the
                # printer-memory skill; the prompt points there instead
                # of duplicating it.
                auto_fill_prompt += (
                    "\nCall load_skill(name='printer-memory') first — it "
                    "lists exactly where each field's evidence lives in "
                    "the config."
                )
            # Mechanical head-start: kinematics and build volume are
            # derivable from stepper limits (Macro Designer parity —
            # derive_machine_facts), so the server derives them NOW and
            # hands them over verbatim. The model must not re-derive
            # them, and must not ASK for a value the server already
            # computed.
            texts = [
                str((entry or {}).get("content", ""))
                for entry in (context_files or {}).values()
            ]
            try:
                facts = derive_machine_facts(texts)
            except Exception:
                facts = {}
            if facts:
                known = ", ".join(f"{k}={v}" for k, v in facts.items())
                auto_fill_prompt += (
                    "\n\nDERIVED MACHINE FACTS (computed from the user's "
                    f"config by the app, treat as ground truth): {known}. "
                    "Include these in your block verbatim — do NOT ask "
                    "the user about them."
                )
            # Board roster + major components: the graph view already
            # draws every [mcu] card and probe/accel with this same
            # classification, so the model gets the identical roster
            # instead of struggling to spot boards by prose inference.
            try:
                inv = derive_hardware_inventory(texts)
            except Exception:
                inv = {}
            inv_line = format_hardware_inventory(inv) if inv else ""
            if inv_line:
                auto_fill_prompt += (
                    "\n\nDERIVED HARDWARE INVENTORY (parsed from the "
                    f"config by the app — ground truth): {inv_line}. "
                    "Use it to fill toolheadBoard, expanderBoards, and "
                    "probe verbatim (board NAMES are facts even when the "
                    "board model chip is unknown; a CAN uuid board is "
                    "still that named board). Say 'model unconfirmed' "
                    "only for the chip/model nuance, never drop a named "
                    "board."
                )
            system_parts.append(auto_fill_prompt)

    prepared: list[dict] = []
    for msg in messages:
        role = msg.get("role")
        content = str(msg.get("content", "")).strip()
        if role not in {"system", "user", "assistant"} or not content:
            continue
        if role == "system":
            if content != system_prompt:
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
            *([] if no_system else [{"role": "system", "content": system_text}]),
            *prepared,
            *([] if (minimal or no_system) else [{"role": "system", "content": task_anchor}]),
        ]
    return ([] if no_system else [{"role": "system", "content": system_text}]) + prepared


# ── MCP Tool Integration ───────────────────────────────────────────


_SPECIALIZED_TOOL_SNIPPETS: dict[str, str] = {
    "detect_board": (
        "Detect the likely printer board/MCU family from a config snippet "
        "(config_text='...') — feed it the user's config to identify the "
        "mainboard for printer memory"
    ),
    "calculate_rotation_distance": (
        "Calculate rotation_distance for a stepper "
        "(method='leadscrew'|'belt'|'from_steps_per_mm')"
    ),
}


_MCP_TOOL_SNIPPETS: dict[str, str] = {
    "search_klipper_docs": (
        "Search the bundled Klipper docs (query='...', limit=N) — ranked "
        "results with snippets to find which doc covers a topic"
    ),
    "read_klipper_doc": (
        "Read a bundled Klipper doc file (filename='Klipper_GCode_Macro_AI_Summary.md' "
        "for macro/Jinja formatting: single-brace { } delimiters, {% if %}/{% endif %} "
        "block closing, comment stripping; supports offset/limit pagination)"
    ),
    "list_klipper_docs": "List all bundled Klipper documentation files (filenames + headings)",
    "list_config_reference_sections": (
        "List every Klipper config section supported by Config_Reference "
        "(e.g. [printer], [bed_mesh], [gcode_arcs]); use BEFORE adding or "
        "editing a section to get the exact name, then read it with "
        "get_config_reference_section(section_name=...)"
    ),
    "get_config_reference_section": (
        "READ the Config_Reference PROSE for a section — what the parameters "
        "do, setup examples, detailed semantics (section_name="
        "'firmware_retraction'). Use when designing a section you don't "
        "fully understand yet. For a quick check of allowed param names, "
        "defaults, enums, and bounds, call get_section_schema instead — "
        "never invent section names or params from memory either way. "
        "list_sections=true returns ONLY the section headers to pick from; "
        "sections=['a','b'] fetches several in one call"
    ),
    "read_user_config": (
        "Read a user config file (filename='printer.cfg' required): "
        "section='extruder' for one section, sections=['a','b'] for several in "
        "one call, list_sections=true for just the section headers, "
        "whole_file=true for one whole file, files=['a.cfg','b.cfg'] for "
        "several whole files. Call list_user_configs (no args) to see all "
        "available user files."
    ),
    "list_user_configs": (
        "List all user config files (from the Pi's native config path and "
        "imported user configs). Use when the user names a macro or section "
        "without saying which file it is in, then read the best candidate."
    ),
    "list_user_config_sections": (
        "List the section headers inside one user config file "
        "(filename='printer.cfg'); use to see what a file already contains "
        "before editing, then read_user_config(section=...)"
    ),
    "search_user_configs": (
        "Search the user's config files by filename or content keyword "
        "(query='level_bed'|'skr'|'bed_mesh', limit=N). Use when the user names "
        "a macro or section without saying which file it is in."
    ),
    "search_example_configs": "Search example configs by board or printer (query='voron', limit=N)",
    "read_example_config": "Read a full example config file (filename='generic-....cfg')",
    "validate_klipper_config": (
        "VERIFY config TEXT for errors (config_text='...' required) — "
        "'check this for errors' / 'is this section correct' about ANY "
        "config text you can see, pasted by the user or written by you: "
        "required params, types, ranges. A schema or reference list CANNOT "
        "check text — never approve config text from a listing alone. For "
        "the user's saved files use validate_config_project"
    ),
    "validate_macro": (
        "Validate a gcode_macro against Klipper's Jinja rules (macro_text='...' required)"
    ),
    "validate_config_project": (
        "Validate the user's CURRENT config project on this host (all files, "
        "includes expanded) against the full schema — errors/warnings/infos "
        "with file+line. Call this for 'validate/check/review my config', "
        "'is my config OK?', 'what's wrong with my config' — instead of "
        "reading config files and judging by eye. No args validates "
        "everything; filenames=['printer.cfg'] for a subset. Use before "
        "advising FIRMWARE_RESTART; validate_klipper_config is for drafts "
        "you wrote"
    ),
    "list_connected_devices": (
        "List USB serial (/dev/serial/by-id paths for [mcu] serial:), UART, "
        "and CAN devices on this host, with CAN UUIDs from canbus_query "
        "(scan_can_uuids=false skips the bus scan). Use for serial:/canbus_uuid "
        "lines and 'which board is plugged in?'"
    ),
    "get_section_schema": (
        "LIST a section's allowed parameters from the schema "
        "(section='bed_mesh' or sections=['extruder','gcode_arcs']): types, "
        "defaults, required flags, enum values, numeric bounds. Use to "
        "learn WHICH params/values are legal BEFORE writing a new section; "
        "it cannot check text — for 'is this config correct?' use "
        "validate_klipper_config; get_config_reference_section only for "
        "prose explanations and examples"
    ),
    "get_klippy_status": (
        "Get Klipper's live state (ready / startup error / shutdown), the "
        "active print job, and klippy.log error context (attached "
        "automatically when not ready; include_log_excerpt=true with optional "
        "section_name/error_text forces it while ready). Call BEFORE "
        "recommending FIRMWARE_RESTART — it warns if a print would be "
        "interrupted"
    ),
    "generate_macro_template": (
        "Generate a ready-to-use macro template (macro_name='PRINT_START'|'PRINT_END'|"
        "'PAUSE'|'RESUME'|'CANCEL_PRINT'; include_bed_mesh option)"
    ),
}


# Snippets for the chat-loop write tools (advertised only when
# KWC_EDIT_TOOLS is on; they are NOT registered MCP server tools — the
# chat proxy routes them request-scoped. Parity with the native surface
# is enforced by tests/test_ai_edit_tools.py.
_EDIT_TOOL_SNIPPETS: dict[str, str] = {
    "config_edit": (
        "Apply one mechanical edit to the user's config "
        "(file='printer.cfg', op='set_param'|'add_section'|'replace_section'"
        "|'delete_section'|'patch_gcode'|'delete_file'|'add_include'"
        "|'remove_include'|'comment_include', section='bed_mesh', key='speed', value='50', "
        "text='body for add/replace_section — replace_section replaces "
        "the ENTIRE body, include every param to keep', old_text='exact lines to "
        "replace', new_text='replacement lines — new_text REPLACES "
        "old_text; repeat the anchor lines inside new_text when adding', "
        "target_file='x.cfg' for "
        "include ops (comment_include disables an include as '#[include x.cfg]' "
        "instead of deleting it). value must be ONE LINE — "
        "multi-line values (gcode:) are dropped by some tool-call "
        "channels, write those with replace_section/patch_gcode. "
        "One op per call; changes are "
        "validated and staged "
        "for user review"
    ),
    "config_write": (
        "Create a NEW config file (file='new.cfg', content='full file "
        "content') — new files only; edit existing files with config_edit"
    ),
}


# ── Phase 3: model-triggered edit skill (KWC_EDIT_SKILL_GATE) ──────────
# The heavy edit protocol is lazy-loaded like an agent skill: a tiny index
# block always advertises the skill's NAME+DESCRIPTION; the write tools and
# the edit law stay hidden until the model itself calls load_skill. No
# regex auto-activation — intent guessing would re-admit the half-edit-on-
# a-question failure this gating exists to kill (plan 2026-09-10, Q4).
EDIT_SKILL_GATE_ENV = "KWC_EDIT_SKILL_GATE"
EDIT_SKILL_NAME = "config-editing"
MEMORY_SKILL_NAME = "printer-memory"
MEMORY_SKILL_DESCRIPTION = (
    "Fills in the user's printer memory with hardware facts (boards, "
    "kinematics, build volume, extruder type, probe). Use when the printer "
    "memory shows blank or missing fields, when the user asks to set up or "
    "correct their printer profile, or when a needed hardware fact is "
    "unknown and guessable-but-risky. Do NOT use when memory already "
    "contains the fact you need."
)
EDIT_SKILL_DESCRIPTION = (
    "Applies edits to the user's Klipper config files. Use when the request "
    "asks to change, add, remove, fix, or comment out a section, parameter, "
    "or macro, or the user approves a proposed edit. Do NOT use for "
    "questions about settings, validating pasted config text, drafting or "
    "showing config/macro text to read over or discuss without applying it, "
    "or any request that says not to change the files."
)

LIST_HARDWARE_SPEC = {
    "name": "list_hardware",
    "description": (
        "List every section of a hardware class in the user's CURRENT "
        "config project (working state, including approved unsaved "
        "edits), each with its full text and file+line location. Use "
        "this BEFORE editing or advising on a component CLASS so the "
        "answer covers ALL of them — text search finds only sections "
        "whose name contains the keyword and misses e.g. [dotstar] or "
        "[output_pin casing_light]. type must be EXACTLY one of: 'led' "
        "(also lights/rgb), 'fan', 'stepper' (includes [tmc2240 "
        "stepper_x]), 'extruder', 'heater', 'probe', 'accelerometer', "
        "'mcu'/'board', 'servo', 'display', 'filament_sensor', "
        "'endstop', 'macro'; or any literal section type ('bed_mesh', "
        "'idle_timeout'). Any other type fails and the result lists "
        "the valid classes. No type returns a one-line-per-group "
        "summary of everything present."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "type": {
                "type": "string",
                "description": (
                    "Hardware class ('led', 'fan', 'stepper', ...) or "
                    "literal section type; empty for a summary"),
            },
        },
    },
}

LOAD_SKILL_SPEC = {
    "name": "load_skill",
    "description": (
        "Load the full instructions for a listed skill and unlock its "
        "tools. Call this BEFORE attempting to use a skill; load each "
        "skill at most once per conversation."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "name": {
                "type": "string",
                "enum": [EDIT_SKILL_NAME, MEMORY_SKILL_NAME],
                "description": "Skill name from <available_skills>",
            },
        },
        "required": ["name"],
    },
}

_LOAD_SKILL_SNIPPET = (
    "Load a skill's full instructions before using it — "
    "name='config-editing' (unlocks the edit tools) or 'printer-memory' "
    "(hardware fact-finding playbook)"
)

# Nudge replacement while the skill gate is CLOSED: pointing at a locked
# write tool (EDIT_NUDGE_TEXT) would be incoherent; the correction is the
# load step itself. Placeholder-only law (no real keys/values).
# EXCEPTION-FIRST shape (SKILL-* eval r1-r4, 2026-09-17): pure
# conditionals made gemma ACK the policy and stop (activation 4/5->2/5);
# imperative with a TAIL exception made the exception invisible
# (N04 FP returned). Leading the sentence with the exception ("Unless
# the user explicitly said NOT...") puts the negation first — gemma
# honors it on review-only requests — while the action clause stays the
# only executable path, so edit requests cannot dissolve into an ack.
_LOAD_SKILL_NUDGE_TEXT = (
    "Unless the user explicitly said NOT to change their files, the block "
    "you just wrote in chat text is inert and must be redone through the "
    "tools: call load_skill(name='config-editing') now, then apply the "
    "change with the edit tool, one operation per call."
)


def _edit_skill_gate_enabled() -> bool:
    """Gate defaults ON (Phase-5 A/B, 2026-09-23: full-bank gate-ON leg
    matched gate-OFF at 91/94 with verified 5/5 activation and equal-or-
    better edit families; env =0 opts back out to always-on write tools).
    """
    return os.environ.get(EDIT_SKILL_GATE_ENV, "1").strip().lower() in (
        "1", "true", "yes", "on")


def _edit_skill_body() -> str:
    """The skill body returned by load_skill: the edit law plus the
    unlocked tools' arg shapes (text-protocol models receive no JSON
    schema, so the tool snippets travel WITH the body)."""
    tool_lines = "\n".join(
        f"- {name}: {snippet}" for name, snippet in _EDIT_TOOL_SNIPPETS.items())
    return (
        f"Skill '{EDIT_SKILL_NAME}' loaded — the tools below are now "
        "available for this conversation.\n\n"
        f"{EDIT_PROTOCOL_PROMPT}\n\n"
        "Unlocked tools:\n" + tool_lines
    )


_SKILL_INDEX_BLOCK = (
    "<available_skills>\n"
    f"- {EDIT_SKILL_NAME}: {EDIT_SKILL_DESCRIPTION}\n"
    f"- {MEMORY_SKILL_NAME}: {MEMORY_SKILL_DESCRIPTION}\n"
    "</available_skills>\n"
    "If the user's request is about editing their config, call load_skill "
    "with the skill name FIRST — the edit tools are not available until "
    "you do. If the printer memory has blank fields you need (or you are "
    "about to guess a hardware fact), load_skill(name='printer-memory') "
    "and follow its playbook instead of guessing. Questions about Klipper "
    "that need neither never need a skill."
)


def _memory_skill_body() -> str:
    """The skill body returned by load_skill(name='printer-memory'):
    the hardware fact-finding playbook. No tools unlock — every tool it
    uses (read_user_config, search_example_configs, ...) is already
    advertised; what the body adds is WHERE to look for each field."""
    return (
        f"Skill '{MEMORY_SKILL_NAME}' loaded.\n\n"
        "Goal: fill the printer memory fields with FACTS, never guesses.\n"
        "For each field: (1) look for evidence in the user's config and "
        "bundled example configs; (2) ask the user only what you cannot "
        "determine; (3) never invent a value.\n\n"
        "Where to look:\n"
        "- mainboard / toolheadBoard / expanderBoards: check the "
        "DERIVED HARDWARE INVENTORY in this conversation FIRST \u2014 "
        "the app parses every [mcu] section (names, roles, chips, "
        "hosting) and it is ground truth; copy board names from it "
        "verbatim. Without it: the [mcu] sections name MCUs; board "
        "models come from canbus_query-style notes, "
        "# comments, or search_example_configs with the MCU chip + "
        "pin-style clues, confirmed via read_example_config. If the exact "
        "model stays unconfirmed, STILL record the certain part as a "
        "factual description (e.g. 'STM32F446 board — model unconfirmed') "
        "— stating what IS known is not a guess; leaving a known chip "
        "out is worse than a hedged entry.\n"
        "- printerName: user messages or config comments first (e.g. "
        "'# Voron Trident 250'); never guess from kinematics alone.\n"
        "- kinematics: the [printer] section's kinematics: key — read it, "
        "do not infer.\n"
        "- probe: the [probe] / [bltouch] / [load_cell] sections and "
        "probe pin comments (Voron Tap = [probe] with no bltouch).\n"
        "- buildVolume: MECHANICALLY DERIVABLE — do not ask for it if "
        "the config is available. Cartesian/CoreXY: width/depth/height "
        "from [stepper_x]/[stepper_y]/[stepper_z] position_max minus "
        "position_min (position_min defaults to 0), e.g. 250x250x210. "
        "Delta/rotary_delta: 'round Ø' twice the [printer] "
        "print_radius (or delta_radius). The app's Macro Designer "
        "derives it this same way programmatically. If the auto-fill "
        "prompt already gives you derived machine facts, USE them "
        "verbatim.\n"
        "- extruderType: 'direct' or 'bowden' ONLY. Evidence: bowden "
        "tubes show up as long bowden_length / pressure_advance "
        "discussion, Titan/BMG paired with a remote motor, or the user "
        "saying so; typical modern Voron toolheads (AbbottCluster, "
        "Afterwise, Orbiter-on-carriage) are direct drive. If the config "
        "does not settle it, ASK — one short question, both options "
        "named.\n\n"
        "Return the proposal in a fenced `printer-memory` code block "
        "with ONLY these 9 fields (omit the ones that stay unknown):\n"
        "mainboard, toolheadBoard, expanderBoards, printerName, "
        "kinematics, probe, buildVolume, extruderType, additionalNotes.\n"
        "   ```printer-memory\n"
        "   {\"kinematics\": \"CoreXY\", \"buildVolume\": \"250x250x210\", "
        "\"extruderType\": \"direct\"}\n"
        "   ```\n"
        "The user confirms before anything is saved. Leave a field out "
        "rather than guessing — an omitted field is honest; a wrong one "
        "poisons every later answer.\n\n"
        "ALWAYS return the block in the SAME reply, even when you are "
        "also asking questions: emit every fact you have determined NOW "
        "(a partial profile saves fine), then ask about the rest. Never "
        "wait for answers before returning what you already know — your "
        "facts are lost if the conversation moves on."
    )


def _load_skill_active(messages: list[dict]) -> bool:
    """True once the model has actually invoked load_skill in this
    conversation. Mechanical evidence only (tool-result markers / echoed
    native tool_calls) — never keyword heuristics."""
    for msg in messages:
        if str(msg.get("role", "")) not in ("user", "assistant"):
            continue
        content = str(msg.get("content", ""))
        # Name-anchored (r4b trap): a printer-memory skill load in the
        # history must NOT count as the edit skill being active. The
        # tool-result marker carries `name=config-editing` verbatim.
        if re.search(r"\[Tool result: load_skill\(name=?['\"]?"
                     + re.escape(EDIT_SKILL_NAME), content):
            return True
        for call in msg.get("tool_calls") or []:
            fn = call.get("function") if isinstance(call, dict) else None
            if not isinstance(fn, dict) or fn.get("name") != "load_skill":
                continue
            args = fn.get("arguments")
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except (json.JSONDecodeError, ValueError):
                    args = {}
            name = str((args or {}).get("name", ""))
            if not name or name == EDIT_SKILL_NAME:
                return True
    return False


def _build_mcp_tool_context(edit_capable: bool = False, *,
                            skill_gate: bool = False,
                            skill_active: bool = False,
                            native_mode: bool = False) -> str:
    """Build the 'Available Tools' section for the system prompt.

    Every registered tool is advertised so text-protocol and native providers
    see the SAME tool surface (parity). The everyday tools get a one-line
    snippet each; niche helpers (board detection, rotation_distance math) are
    grouped under a "Specialized tools" heading so they stay visible without
    distracting from the tools that matter for the current task.

    Param-coverage note: every inputSchema param of an advertised tool must
    appear in its snippet (enforced by test_api_routes
    test_tool_context_snippets_cover_schema_params) so text-protocol models
    can discover the same affordances as native function calling.
    """

    parts = [
        "# Available Tools",
        "",
        "Use these tools proactively. They are how you access the user's "
        "configs, the bundled Klipper docs, and validation. Before asking "
        "the user for information, prefer a tool that can fetch or verify "
        "it — read_user_config for config files, search_klipper_docs or "
        "get_config_reference_section for docs, validate_klipper_config / "
        "validate_macro for drafts. Do not guess when a tool can answer. "
        "read_user_config / list_user_config_sections show only what ALREADY "
        "exists in the user's files; list_config_reference_sections / "
        "get_config_reference_section / get_section_schema / "
        "search_klipper_docs show what Klipper SUPPORTS. When the user asks "
        "to ADD or SETUP a section or parameter, look it up first — a valid "
        "Klipper section may not be in the user's config yet. To verify "
        "which PARAMETERS and values a section accepts, call "
        "get_section_schema (fast, exact types/defaults/enums/bounds); use "
        "get_config_reference_section only when you need the prose "
        "explanation or examples of what the section does.",
        "",
        # Format law is protocol-specific. Advertising the ```tool block to
        # a native server is what teaches small models to narrate the
        # protocol back at the user ("I see you've shared the tool-call
        # instructions..."), so native turns get the short machine-channel
        # statement instead. The ```tool block stays for tool_protocol=text.
        *([
            "Use your tools by calling them directly — the tool results come",
            "back to you automatically; never write tool calls as text.",
        ] if native_mode else [
            "Text format (used by providers without native function calling): put a JSON ",
            "code block tagged `tool` in your reply:",
            "",
            "```tool",
            """{"name": "tool_name", "arguments": {"key": "value"}}""",
            "```",
            "",
            "The tool runs and the result is returned as a follow-up message — use it to answer.",
        ]),
        "",
        "Tools:",
    ]
    for name, snippet in _MCP_TOOL_SNIPPETS.items():
        parts.append(f"- {name}: {snippet}")
    parts.append("")
    parts.append("Specialized tools (use only for specific problems):")
    for name, snippet in _SPECIALIZED_TOOL_SNIPPETS.items():
        parts.append(f"- {name}: {snippet}")
    parts.append("")
    parts.append(
        "- list_hardware: List EVERY section of a hardware class "
        "(type='led'|'fan'|'stepper'|'extruder'|'heater'|'probe'|"
        "'accelerometer'|'mcu'|'servo'|'display'|'filament_sensor'|"
        "'endstop'|'macro' — exactly one of these, or a literal section "
        "type like 'bed_mesh'; any other type fails and lists the "
        "valid ones) from the CURRENT working state, "
        "each with full text + file+line — use before class-wide edits "
        "or advice so nothing is missed (text search misses [dotstar] "
        "or [output_pin led_strips]); no type = summary of everything "
        "present"
    )
    if edit_capable:
        if skill_gate and not skill_active:
            # Model-triggered skill: advertise the skill INDEX; write tools
            # unlock only after the model calls load_skill itself.
            parts.append("")
            parts.append(_SKILL_INDEX_BLOCK)
        else:
            parts.append("")
            parts.append("Config edit tools (changes are staged for user review, never saved directly):")
            for name, snippet in _EDIT_TOOL_SNIPPETS.items():
                parts.append(f"- {name}: {snippet}")
        if skill_gate:
            parts.append("")
            parts.append(f"- load_skill: {_LOAD_SKILL_SNIPPET}")
    parts.append("")
    parts.append(
        "Klipper G-code commands and macro names (e.g. G28, M104, BED_MESH_CALIBRATE, "
        "SET_FAN_SPEED, PRINT_START) are NOT tools — never wrap them in tool blocks."
    )

    return "\n".join(parts)


# ── Edit-request heuristic ──────────────────────────────────────────────
# Drives the edit-prose nudge gate in chat_proxy. Edit requests must
# never be doc/config-injection targets (models regenerate macros lossily
# under extra load — verified 2026-08 on gemma-4-12b/qwen3.5-9b).

_EDIT_VERB_RE = re.compile(
    r"\b(?:change|update|modify|edit|add|remove|delete|fix|create|set|rename|"
    r"enable|disable|tweak|adjust|comment\s*out|calibrat\w*|move|"
    r"raise|lower|increase|decrease)\b",
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
    question after an edit must not be gated. Drives the edit-prose nudge
    gate (the doc/config injection fallbacks this once gated were deleted in
    the Phase-5 gate sweep, 2026-09).
    """
    for msg in reversed(messages):
        if msg.get("role") != "user":
            continue
        content = str(msg.get("content", "")).strip()
        if not content:
            continue
        return bool(_EDIT_VERB_RE.search(content) and _EDIT_TARGET_RE.search(content))
    return False


def _no_system_prompt_enabled() -> bool:
    """Experiment gate (env KWC_NO_SYSTEM=1): send NO system content at all.

    No SYSTEM_PROMPT, no tool list, no printer memory, no task anchor — the
    request is just the conversation, exactly like a bare chat UI. Measures
    the model's raw behavior with zero harness interference.
    """
    return os.environ.get("KWC_NO_SYSTEM", "0") != "0"


def _minimal_prompt_enabled() -> bool:
    """Experiment gate (env KWC_MINIMAL_PROMPT=1): send ONLY the tool list.

    The system prompt, printer memory, auto-fill, and task anchor are all
    omitted so the model's raw behavior with tools can be measured without
    the harness prompt engineering getting in the way. Restart the backend
    with the env var set, then run the accuracy harness.
    """
    return os.environ.get("KWC_MINIMAL_PROMPT", "0") != "0"


def _edit_tools_enabled() -> bool:
    """Tool-mediated config editing (config_edit/config_write write tools).

    DEFAULT-ON since the Phase-4 ratchet (2026-09-22): the prose draft path
    is deleted, so the write tools are the ONLY edit path. Set env
    KWC_EDIT_TOOLS=0 only to disable edits entirely (read-only chat). The
    tools are advertised (native + text protocol parity), routed
    request-scoped through services.ai_edit_tools.EditSession (seeded from
    contextFiles; no per-conversation draft store), and the loop cap rises
    to MAX_MCP_TOOL_TURNS_EDIT. With no contextFiles the session mirror-
    seeds from the backend user-config store (TRIDENT-16).
    """
    return os.environ.get("KWC_EDIT_TOOLS", "1") != "0"


# PYTHONIC native tool template leaked as plain text by llama.cpp when the
# SERVED model's chat template has native tool tokens (observed 2026-09 on
# gemma-4-12b @ 192.168.1.135 — the shape comes from the model's training,
# NOT from our advertised text protocol, so no prompt-side format change can
# prevent it; same reason formats 5-6 exist for DSML/XML):
#   <|tool_call>call:NAME{content:<|"|>...multiline value...<|"|>,file: 'macros.cfg'}
#   plus terminator tokens like <tool_call|> / <|tool_call|> around the region.
# The head pipe placement varies (leading-only seen in live traffic). The
# <|"|> sentinel NEVER occurs in legit Klipper/prose text, so sentinel-gated
# regions are deterministic. Fullbank ON run 2026-09-14 AMBI-02: a correct
# config_write with a full macro-file body was lost — ALT_TOOL_CALL_CONTENT_RE
# stops the content group at the first newline, the value is multi-line, and
# the line-bounded cleanup then ATE the visible reply up to the first '}' in
# the body.
TEMPLATE_CALL_HEAD_RE = re.compile(
    r"<\|?tool_call\|?>\s*call:(?:tool_call[\s:]*)?([\w-]+)\s*\{")
TEMPLATE_SENTINEL = '<|"|>'
TEMPLATE_TERM_RE = re.compile(r"</?\|?tool_call\|?>")
# Non-sentineled variant of the same template: call:tool_call:NAME{k: "v"}
# with NO sentinel anywhere. Extraction of the single-line shape already
# works via Format 2/4 (values survive); this regex only removes the leaked
# head/tail tokens from the visible reply. Key-signature guarded like
# CALL_SYNTAX_CLEANUP_RE so macro bodies are never stripped.
TEMPLATE_CALL_CLEANUP_RE = re.compile(
    r"<\|?tool_call\|?>\s*call:(?:tool_call[\s:]*)?[\w-]+\s*\{"
    r"(?!%|\{)[^{}]*[:=][^{}]*\}\s*(?:</?\|?tool_call\|?>)?",
    re.DOTALL,
)


def _parse_pythonic_args(region: str) -> tuple[dict, int]:
    """Parse 'key:<|"|>value<|"|>,key2: raw}' template arguments.

    Scans from the region START so a 'key:' inside a sentineled value
    (gcode: inside a macro body) is consumed as data, never re-read as an
    argument. Non-sentineled values stop at ',' or '}' and are kept only
    when single-line; anything else ends parsing with what was collected.
    Returns (args, consumed_chars).
    """
    args: dict = {}
    pos = 0
    # Optional single/double quotes around the key (JSON-style template
    # rendering: {"file": <S>macros.cfg<S>, "content": <S>...}).
    key_re = re.compile(r"\s*['\"]?(\w+)['\"]?\s*:\s*")
    while pos < len(region):
        rest = region[pos:]
        if rest.startswith(TEMPLATE_SENTINEL):
            # Canonical Hermes joins `,` then re-opens the quote before the
            # key: `...<|"|>,<|"|>content:<|"|>...`. Skip the quoting token.
            pos += len(TEMPLATE_SENTINEL)
            continue
        m = key_re.match(rest)
        if not m:
            break
        key = m.group(1)
        v = pos + m.end()
        if region.startswith(TEMPLATE_SENTINEL, v):
            v += len(TEMPLATE_SENTINEL)
            close = region.find(TEMPLATE_SENTINEL, v)
            if close == -1:
                # Truncated stream: keep the partial value honestly.
                args[key] = region[v:]
                return args, len(region)
            args[key] = region[v:close]
            pos = close + len(TEMPLATE_SENTINEL)
            if pos < len(region) and region[pos] in ",}":
                pos += 1
            continue
        # Non-sentineled value: up to the next ',' or '}' (no braces — a
        # brace here means we ran past the args region).
        end = len(region)
        for i in range(v, len(region)):
            if region[i] in ",}\n":
                end = i
                break
        value = region[v:end].strip()
        if not value:
            break
        args[key] = value.strip("'\"")
        pos = end
        if pos < len(region) and region[pos] in ",}":
            pos += 1
    return args, pos


def _template_call_regions(
    text: str,
) -> list[tuple[int, int, str, dict]]:
    """Locate pythonic template calls: (start, stop, name, args).

    Returns [] unless the literal <|"|> sentinel AND a call head are both
    present — no ordinary text (or a Klipper macro full of {braces}) can
    trigger this path. The region runs from the head through the end of the
    parsed args plus any trailing terminator tokens; if the args can't
    parse at all (prose happened to sit between head and sentinel) the
    region is dropped entirely.
    """
    if TEMPLATE_SENTINEL not in text:
        return []
    regions: list[tuple[int, int, str, dict]] = []
    for head in TEMPLATE_CALL_HEAD_RE.finditer(text):
        name = head.group(1)
        args, consumed = _parse_pythonic_args(text[head.end():])
        if not args:
            continue
        stop = head.end() + consumed
        # Consume trailing terminator tokens (<tool_call|>, <|tool_call|>,
        # </|tool_call|>) and any '}' the parser stopped before.
        while True:
            if stop < len(text) and text[stop] == "}":
                stop += 1
                continue
            m = TEMPLATE_TERM_RE.match(text, stop)
            if m:
                stop = m.end()
                continue
            break
        regions.append((head.start(), stop, name, args))
    return regions


def _extract_template_pythonic_calls(text: str) -> list[dict]:
    return [
        {"name": name, "arguments": args}
        for _start, _stop, name, args in _template_call_regions(text)
    ]


def _strip_template_pythonic_calls(text: str) -> str:
    """Remove template call regions from visible text.

    Sentinel-gated regions (see _template_call_regions) plus the leaked
    head/tail tokens of non-sentineled variants. Regions are code-
    determined — never prose. The generic line-bounded cleanups only ate
    the FIRST line of a region, leaking the rest of a macro body into the
    chat bubble (AMBI-02).
    """
    regions = _template_call_regions(text)
    if regions:
        out: list[str] = []
        cursor = 0
        for start, stop, _name, _args in regions:
            out.append(text[cursor:start])
            cursor = max(cursor, stop)
        out.append(text[cursor:])
        text = "".join(out)
    return TEMPLATE_CALL_CLEANUP_RE.sub("", text)


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
      4. name{arg1="val1", arg2="val2"}
         (brace-style call without wrapper tokens)
      5. DeepSeek DSML:
         <||DSML||invoke name="name">
           <||DSML||parameter name="arg1" string="true">val1</||DSML||parameter>
         </||DSML||invoke>
         (DeepSeek V3.2/V4 native format; returned as plain text by some
         serving stacks instead of structured tool_calls)
      6. Bare XML:
         <tool_calls><invoke name="name">
           <parameter name="arg1">val1</parameter>
         </invoke></tool_calls>
         (Anthropic/DeepSeek style, emitted as plain text by models that
         ignore a no-tools re-prompt)
    """
    calls: list[dict] = []
    seen_contents: set[str] = set()

    # Format 0: pythonic native-template calls with <|"|>-quoted values
    # (multi-line macro bodies the line-bounded formats cannot see). Gated
    # on the sentinel AND known tool names — see TEMPLATE_CALL_HEAD_RE.
    tmpl_known = {t["name"] for t in _mcp_server._list_tools()} | set(EDIT_TOOL_NAMES)
    if _edit_skill_gate_enabled():
        tmpl_known.add(LOAD_SKILL_SPEC["name"])
    tmpl_known.add(LIST_HARDWARE_SPEC["name"])
    for _start, _stop, t_name, t_args in _template_call_regions(text):
        if t_name not in tmpl_known:
            continue
        key = repr((t_name, sorted(t_args.items())))
        if key in seen_contents:
            continue
        seen_contents.add(key)
        calls.append({"name": t_name, "arguments": t_args})

    # Format 1: standard fenced ```tool block
    for match in MCP_TOOL_BLOCK_RE.finditer(text):
        raw_json = match.group(1).strip()
        if not raw_json or raw_json in seen_contents:
            continue
        seen_contents.add(raw_json)
        try:
            parsed = json.loads(raw_json)
        except json.JSONDecodeError:
            parsed = None
        if not isinstance(parsed, dict):
            # Broken JSON inside an explicit tool fence — attempt mechanical
            # recovery (python-call form, smart/single quotes) before giving
            # up. The fence is unambiguous tool intent, not prose.
            recovered_call = _recover_fenced_tool_call(raw_json)
            if recovered_call:
                # Counted so the A/B can separate silent recoveries from
                # re-prompt corrections (only the latter logs a WARNING).
                logger.debug(
                    "Recovered malformed tool fence | name=%s preview=%s",
                    recovered_call["name"], raw_json[:100].replace("\n", " "),
                )
                calls.append(recovered_call)
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
        if TEMPLATE_SENTINEL in content:
            # Pythonic template head (Format 0 owns these): this format is
            # line-bounded and would extract a truncated duplicate call
            # from the first line of a multi-line sentinel value.
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

    # Format 5: DeepSeek DSML (Data Structure Markup Language) tool calls.
    # DeepSeek V3.2/V4 native format; some serving stacks return the markup
    # in message.content instead of structured tool_calls.
    for invoke_match in DSML_INVOKE_RE.finditer(text):
        name = invoke_match.group(1).strip()
        body = invoke_match.group(2)
        if not name or body in seen_contents:
            continue
        seen_contents.add(body)
        arguments: dict = {}
        for param_match in DSML_PARAM_RE.finditer(body):
            key = param_match.group(1).strip()
            value = param_match.group(2).strip()
            if key:
                arguments[key] = value
        calls.append({"name": name, "arguments": arguments})

    # Format 6: bare XML tool-call blocks (Anthropic/DeepSeek style):
    #   <tool_calls><invoke name="name"><parameter name="k">v</parameter>
    #   </invoke></tool_calls>
    # Emitted as plain text by models that ignore the no-tools instruction
    # during an empty-response re-prompt.
    for xml_match in XML_INVOKE_RE.finditer(text):
        name = xml_match.group(1).strip()
        body = xml_match.group(2)
        if not name or body in seen_contents:
            continue
        seen_contents.add(body)
        arguments = {}
        for param_match in XML_PARAM_RE.finditer(body):
            key = param_match.group(1).strip()
            value = param_match.group(2).strip()
            if key:
                arguments[key] = value
        calls.append({"name": name, "arguments": arguments})

    # Format 7: bracket-wrapped calls [name(k=v, ...)] (see BRACKET_CALL_RE).
    # Gated on known tool names — config headers ([probe]) and prose with
    # parens must never extract as calls.
    known_tool_names = {t["name"] for t in _mcp_server._list_tools()}
    known_tool_names.add(LIST_HARDWARE_SPEC["name"])
    for bracket_match in BRACKET_CALL_RE.finditer(text):
        content = bracket_match.group(0).strip()
        if not content or content in seen_contents:
            continue
        name = bracket_match.group(1).strip()
        if name not in known_tool_names:
            continue
        seen_contents.add(content)
        arguments = _parse_kwargs(bracket_match.group(2).strip())
        calls.append({"name": name, "arguments": arguments})

    calls = _unwrap_generic_tool_calls(calls)
    if calls:
        names = [c["name"] for c in calls]
        logger.debug("Extracted %d tool call(s): %s", len(calls), names)
    return calls


# Generic wrapper names a template can emit around the REAL call:
#   call:tool{name: "search_klipper_docs", arguments: {...}}
# No real KWC/MCP tool uses any of these names, so seeing one with a
# `name` argument that resolves to a known tool is a literal-shape
# unwrap, not intent inference.
GENERIC_TOOL_WRAPPERS = frozenset({
    "tool", "tool_call", "function", "functions", "call", "invoke",
})


def _balanced_json_object(s: str) -> str | None:
    """Return the first balanced {...} object in s (quote-aware), else None."""
    start = s.find("{")
    if start < 0:
        return None
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(s)):
        ch = s[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return s[start:i + 1]
    return None


def _unwrap_generic_tool_calls(calls: list[dict]) -> list[dict]:
    """Unwrap call:tool{name: X, arguments: {...}} to name=X.

    Observed live 2026-09-15 (TRIDENT-16, gemma-4-12b via llama.cpp): the
    served template rendered `call:tool{name: "search_klipper_docs",
    arguments: {...}}`; the line-bounded extractor took `tool` as the
    function name and stringified the inner arguments, so the hallucination
    guard skipped a LEGITIMATE call and the answer degraded to ungrounded
    prose. Only unwraps when the wrapper name is generic AND the inner
    name is a known tool (literal-shape inspection only).
    """
    known = {t["name"] for t in _mcp_server._list_tools()} | set(EDIT_TOOL_NAMES)
    if _edit_skill_gate_enabled():
        known.add(LOAD_SKILL_SPEC["name"])
    known.add(LIST_HARDWARE_SPEC["name"])
    out: list[dict] = []
    for call in calls:
        name = call.get("name", "")
        args = call.get("arguments")
        inner_name = args.get("name") if isinstance(args, dict) else None
        if (
            name in GENERIC_TOOL_WRAPPERS
            and isinstance(inner_name, str)
            and inner_name.strip() in known
        ):
            inner = args.get("arguments", {})
            if isinstance(inner, str):
                obj_text = _balanced_json_object(inner)
                parsed = None
                if obj_text:
                    try:
                        parsed = json.loads(obj_text)
                    except json.JSONDecodeError:
                        parsed = None
                inner = parsed if isinstance(parsed, dict) else _parse_kwargs(inner)
            if not isinstance(inner, dict):
                inner = {}
            call = {"name": inner_name.strip(), "arguments": inner}
        if call not in out:
            out.append(call)
    return out


_KWARG_PAIR_RE = re.compile(r"\s*(\w+)\s*[=:]\s*(.*)$", re.DOTALL)
_KWARG_AHEAD_RE = re.compile(r"\s*\w+\s*[=:]")
# Body-carrying write args. The lenient inner-quote scanner below is only
# sound for these values (Klipper/Jinja bodies are quote-heavy and its
# lookahead rule converges there); among SHORT identifier values a dropped
# quote is genuinely ambiguous and must route to the re-prompt instead of
# being "recovered" into plausible-but-wrong args.
_WRITE_BODY_ARG_RE = re.compile(r'"(?:content|text|new_text|old_text)"\s*:')


def _parse_kwargs(args_text: str) -> dict:
    """Parse keyword arguments from text like 'arg1="val1", arg2=123, key="value"'.

    Handles both colon and equals separators, quoted and unquoted values.
    Splitting is nesting- and quote-aware (Phase-5 text-protocol parity,
    2026-09-24): a value may itself be an object — the llama.cpp wrapper
    renders `call:tool{name: "config_edit", arguments: {op: "set_param",
    file: "printer.cfg", ...}}` with UNQUOTED inner keys, and the old lazy
    regex stopped at the first nested brace, keeping only the opening pair
    and silently dropping every later argument (a write call survived with
    `{"op": "set_param"}` while file/section/key/value vanished). A comma
    separates arguments only at depth 0, outside quotes, and only when what
    follows looks like `key=`/`key:`. An object wrapper around the WHOLE
    text is unwrapped first (the inner fragment arrives braced).
    """
    text = args_text.strip()
    if text.startswith("{") and text.endswith("}"):
        text = text[1:-1]
    parts: list[str] = []
    depth = 0
    quote: str | None = None
    start = 0
    for i, ch in enumerate(text):
        if quote is not None:
            if ch == quote:
                quote = None
            continue
        if ch in "\"'":
            quote = ch
        elif ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth = max(0, depth - 1)
        elif ch == "," and depth == 0 and _KWARG_AHEAD_RE.match(text, i + 1):
            parts.append(text[start:i])
            start = i + 1
    parts.append(text[start:])
    arguments: dict = {}
    for part in parts:
        arg_match = _KWARG_PAIR_RE.match(part)
        if not arg_match:
            continue
        arg_name = arg_match.group(1)
        arg_value = arg_match.group(2).strip()
        # Strip ONE matched surrounding quote pair. The old .strip('"\'')
        # also ate quotes that belonged to the value itself.
        if len(arg_value) >= 2 and arg_value[0] == arg_value[-1] \
                and arg_value[0] in "\"'":
            arg_value = arg_value[1:-1]
        arguments[arg_name] = arg_value
    return arguments


# Unterminated ```tool fence: the model opened a tool block and the stream
# ended (or it forgot the closing fence). Such a fence is never legitimate
# content. Bounded at the first BLANK line (review finding #11): fence
# bodies never contain blank lines, but qwen-class models sometimes open a
# broken fence and then recover with real prose — consuming to
# end-of-content silently deleted that answer.
UNTERMINATED_TOOL_FENCE_RE = re.compile(
    r"```tool\b(?:[^\n]*\n)?(?:(?!```)[^\n]+\n)*(?:(?!```)[^\n]*$)?"
)
# Python-call form inside a ```tool fence: name(k=v, ...) / call name(...).
_FENCED_PY_CALL_RE = re.compile(
    r"^(?:call[\s:]?\s*)?(\w+)\s*\((.*)\)\s*$",
    re.DOTALL,
)
# Brace-call form inside a ```tool fence: name{k=v, ...} / call name{...}.
_FENCED_BRACE_CALL_RE = re.compile(
    r"^(?:call[\s:]?\s*)?(\w+)\s*\{(.*)\}\s*$",
    re.DOTALL,
)


def _escape_inner_quotes_json(raw_json: str) -> str | None:
    """Normalize a JSON object whose string values contain unescaped
    double quotes.

    Deterministic scanner, fence-scoped only (a ```tool fence is
    explicit tool intent, never prose): inside a string value, a quote
    terminates the string ONLY when the next non-space character is
    one of , : } ] or the input ends; otherwise it is escaped into the
    value. Klipper macro bodies are full of quotes (SET_LED, Jinja
    string comparisons) and gemma-4-12b emits them raw inside
    config_write JSON content strings (AMBI-02 r6 2026-09-15: the same
    unparseable fence reappeared across 3 nudge rounds + 2 empty
    re-prompts, nothing staged). Genuinely ambiguous shapes close
    early, the retry fails, and the existing re-prompt path takes
    over - fail-closed, same as before.
    """
    Q = chr(34)   # double-quote
    B = chr(92)   # backslash
    WS = " " + chr(9) + chr(13) + chr(10)
    CLOSE = ",:}]"
    out: list[str] = []
    in_str = False
    depth = 0
    i = 0
    n = len(raw_json)
    while i < n:
        c = raw_json[i]
        if in_str:
            if c == B and i + 1 < n:
                out.append(c)
                out.append(raw_json[i + 1])
                i += 2
                continue
            if c == Q:
                j = i + 1
                while j < n and raw_json[j] in WS:
                    j += 1
                if j >= n or raw_json[j] in CLOSE:
                    in_str = False
                    out.append(c)
                else:
                    out.append(B + Q)
            else:
                out.append(c)
        else:
            if c == Q:
                in_str = True
            elif c in "{[":
                depth += 1
            elif c in "}]":
                depth -= 1
            out.append(c)
        i += 1
    # Truncated stream (model hit max_tokens mid-fence — observed live:
    # fence ends `...rear"}` with the closing outer brace missing). Close
    # the open string and append the missing closers; the delta validator
    # still gates the result, so a partial body fails honestly instead of
    # the whole write vanishing.
    if in_str:
        out.append(Q)
    if depth < 0 or depth > 2:
        return None
    if depth:
        out.append("}" * depth)
    return "".join(out)


def _recover_fenced_tool_call(raw_json: str) -> dict | None:
    """Recover a tool call from a ```tool fence whose JSON failed to parse.

    A ```tool fence is explicit tool-call intent, so repairs are scoped to
    fence bodies ONLY (never guessed from prose, per the intent law). Small
    models (qwen 4B class) produce three recurring breakage shapes here:
    python-style ``name(k=v)``, single/smart-quoted pseudo-JSON, and
    unescaped quotes inside values. All are mechanically recoverable.
    """
    # 0) Relaxed JSON retry: `strict=False` accepts LITERAL newlines/tabs
    #    inside string values. The config_write/config_edit content values
    #    ARE multi-line files, and gemma-4-12b emits the macro body with
    #    raw newlines instead of \n escapes (AMBI-02 r4 2026-09-15: the
    #    fence was valid-looking, repeated across 3 nudge rounds, burned
    #    31k tokens, then truncated). Fence-boundary only, so prose is
    #    never touched — the fence is explicit tool intent.
    try:
        parsed = json.loads(raw_json, strict=False)
    except json.JSONDecodeError:
        parsed = None
    if isinstance(parsed, dict):
        name = parsed.get("name", "")
        arguments = parsed.get("arguments", {})
        if isinstance(name, str) and name and isinstance(arguments, dict):
            return {"name": name, "arguments": arguments}
    # 1) Smart quotes → ASCII, then plain JSON retry.
    normalized = (
        raw_json.replace("\u201c", '"').replace("\u201d", '"')
        .replace("\u2018", "'").replace("\u2019", "'")
    )
    if normalized != raw_json:
        try:
            parsed = json.loads(normalized)
        except json.JSONDecodeError:
            parsed = None
        if isinstance(parsed, dict):
            name = parsed.get("name", "")
            arguments = parsed.get("arguments", {})
            if isinstance(name, str) and name and isinstance(arguments, dict):
                return {"name": name, "arguments": arguments}
    # 2) Python call form: name(k=v, ...).
    call_match = _FENCED_PY_CALL_RE.match(normalized.strip())
    if call_match and call_match.group(1):
        return {
            "name": call_match.group(1),
            "arguments": _parse_kwargs(call_match.group(2)),
        }
    # 3) Brace call form: name{k=v, ...}. The brace body may itself be
    #    JSON (llama.cpp `call:tool{"name": ..., "arguments": {...}}`
    #    decoration) — try that before treating it as bare kwargs.
    brace_match = _FENCED_BRACE_CALL_RE.match(normalized.strip())
    if brace_match and brace_match.group(1):
        try:
            parsed = json.loads("{" + brace_match.group(2) + "}")
        except json.JSONDecodeError:
            parsed = None
        if isinstance(parsed, dict):
            name = parsed.get("name", "")
            arguments = parsed.get("arguments", {})
            if isinstance(name, str) and name and isinstance(arguments, dict):
                return {"name": name, "arguments": arguments}
        return {
            "name": brace_match.group(1),
            "arguments": _parse_kwargs(brace_match.group(2)),
        }
    # 4) Single-quoted pseudo-JSON (only when there are no double quotes to
    #    protect): {"name": ...} with ' throughout.
    if "'" in normalized and '"' not in normalized:
        try:
            parsed = json.loads(normalized.replace("'", '"'))
        except json.JSONDecodeError:
            parsed = None
        if isinstance(parsed, dict):
            name = parsed.get("name", "")
            arguments = parsed.get("arguments", {})
            if isinstance(name, str) and name and isinstance(arguments, dict):
                return {"name": name, "arguments": arguments}
    # 5) Unescaped double quotes inside string VALUES (macro bodies).
    # Gated to the write tools AND to a body-carrying argument: only
    # config_write/config_edit carry file bodies full of quotes, where the
    # lookahead rule converges. For short identifier values (read_user_config
    # etc., and write calls whose only args are op/file/section/key/value),
    # unescaped quotes are genuinely ambiguous and MUST route to the
    # re-prompt instead of executing corrupted args (locked by
    # test_chat_proxy_malformed_tool_call_gets_one_format_reprompt for reads
    # and test_config_edit_short_value_corruption_routes_to_reprompt for
    # writes — the scanner used to run on ANY config_edit fence and
    # "recovered" a corrupted set_param with the section swallowing
    # `printer" key: max_accel`, Phase-5 parity probe 2026-09-24).
    if re.search(r'"name"\s*:\s*"(?:config_write|config_edit)"', normalized) \
            and _WRITE_BODY_ARG_RE.search(normalized):
        escaped = _escape_inner_quotes_json(normalized)
    else:
        escaped = None
    if escaped:
        try:
            parsed = json.loads(escaped, strict=False)
        except json.JSONDecodeError:
            parsed = None
        if isinstance(parsed, dict):
            name = parsed.get("name", "")
            arguments = parsed.get("arguments", {})
            if isinstance(name, str) and name and isinstance(arguments, dict):
                return {"name": name, "arguments": arguments}
    return None


def _known_tool_names() -> set[str]:
    """Every tool name the chat loop can dispatch.

    MCP server tools plus the chat-layer extras: the write tools, `load_skill`
    (only behind the edit-skill gate) and `list_hardware`. Three copies of this
    set used to live inline (extractor, generic-wrapper unwrap, loop) — they are
    ONE surface, so keep them from drifting.
    """
    known = {t["name"] for t in _mcp_server._list_tools()} | set(EDIT_TOOL_NAMES)
    if _edit_skill_gate_enabled():
        known.add(LOAD_SKILL_SPEC["name"])
    known.add(LIST_HARDWARE_SPEC["name"])
    return known


# A ```json-fenced block (models use json/json5/javascript labels) whose body
# is a bare tool call. The ```tool extractor cannot see these, so without the
# malformed guard the loop reads the reply as prose and ships the raw JSON
# into the chat bubble (qwen3.5-4b text arm, EDIT-06, 2026-09-24).
_JSON_FENCE_RE = re.compile(
    r"```(?:json|jsonc|json5|javascript|js)[ \t]*\n(.*?)```", re.DOTALL
)


def _json_fence_tool_call(text: str) -> bool:
    """True when a ```json fence IS a tool call, not display JSON.

    Literal shape only, fail-closed: the fence body must parse as ONE object
    carrying a `name` that is a KNOWN tool plus an `arguments` object. Unknown
    names, config content, and JSON examples in prose are never treated as
    intent — the guard only asks for one format correction (it never executes
    the fenced call; execution stays a ```tool-fence privilege).
    """
    known: set[str] | None = None
    for match in _JSON_FENCE_RE.finditer(text):
        try:
            obj = json.loads(match.group(1).strip(), strict=False)
        except (json.JSONDecodeError, ValueError):
            continue
        if not isinstance(obj, dict):
            continue
        name = obj.get("name")
        # `arguments` must be PRESENT and an object: a bare {"name": …} is a
        # fragment (often a prose example), not a call shape.
        if "arguments" not in obj or not isinstance(obj.get("arguments"), dict):
            continue
        if not isinstance(name, str):
            continue
        if known is None:
            known = _known_tool_names()
        if name.strip() in known:
            return True
    return False


def _malformed_tool_call_detected(text: str, calls: list[dict]) -> bool:
    """True when the reply contains tool-call intent that failed to parse.

    Deterministic post-hoc detection over explicit ```tool protocol fences
    only: a fence body that mentions a name/call shape but yielded no call,
    or an unterminated ```tool fence (truncated stream). Prose that merely
    mentions tools never triggers this.
    """
    if calls:
        return False
    if _json_fence_tool_call(text):
        return True
    for fence in MCP_TOOL_BLOCK_RE.finditer(text):
        body = fence.group(1)
        if re.search(r"\bname\b|\bcall\b|\w+\s*[({]", body):
            return True
    return bool(UNTERMINATED_TOOL_FENCE_RE.search(text))


# One protocol-correction re-prompt for a malformed tool call. The broken
# call is NEVER quoted (REPAIR-01: models copy broken drafts verbatim) —
# the model only gets the exact format and a clean path back.
MALFORMED_TOOL_REPROMPT_LIMIT = 1
MALFORMED_TOOL_FORMAT_FEEDBACK = (
    "Your previous response contained a tool call that could not be parsed, "
    "so it was not executed. Do not copy or repeat your previous response. "
    'To call a tool, respond with exactly one fenced block in this format:\n\n'
    "```tool\n"
    '{"name": "<tool_name>", "arguments": {"key": "value"}}\n'
    "```\n\n"
    'Use double quotes around every name and string value, keep the JSON on '
    'valid one-line or multi-line form, and always close the fence. If you '
    "no longer need a tool, answer the user's question directly in text "
    "instead."
)


# ── Repeat-read guard ───────────────────────────────────────────────────
#
# Live flash-next full-bank 2026-09-23: every timeout-class ERROR was a
# tool-loop that stopped CONVERGING and started re-reading — read_user_config
# x10 (LIVE-01), x12 (SKILL-05), x6 (TRIDENT-16); search_klipper_docs x9/x6.
# Identical (name, arguments) calls return identical text, so rounds 2..n
# add tokens and wall-clock but zero information — and the bigger context
# makes each following turn slower, ending at the harness timeout with no
# answer. The guard serves a lean directive instead of re-executing a
# call it already ran THIS request.
#
# Scope is deliberately narrow (intent law): literal (name, canonical-JSON
# args) equality only — never similarity, never intent. Only idempotent
# PURE-READ tools are guarded; validation tools are excluded because a
# re-validate after an edit is a legitimate convergence check, and write
# tools already have their own identical-failure ladder in EditSession.
REPEAT_GUARD_TOOLS = frozenset({
    "read_user_config",
    "list_user_configs",
    "list_user_config_sections",
    "search_user_configs",
    "read_klipper_doc",
    "search_klipper_docs",
    "list_klipper_docs",
    "get_config_reference_section",
    "list_config_reference_sections",
    "read_example_config",
    "search_example_configs",
    "get_section_schema",
})

REPEAT_READ_FEEDBACK = (
    "ALREADY RETRIEVED — this exact call ran earlier in this request and "
    "returned the identical result, which is still in this conversation. "
    "It was not executed again. Repeating identical reads will never add "
    "information: use the result you already have (apply the edit, or "
    "answer the user), or change strategy with a DIFFERENT query."
)


def _repeat_read_key(tool_call: dict) -> str:
    """Literal dedup key: tool name + canonical JSON of its arguments.

    Returns '' for anything outside REPEAT_GUARD_TOOLS so callers can skip
    cheaply. sort_keys makes argument ordering irrelevant; everything else
    is exact.
    """
    name = tool_call.get("name", "")
    if name not in REPEAT_GUARD_TOOLS:
        return ""
    try:
        args = json.dumps(tool_call.get("arguments") or {},
                          sort_keys=True, default=str)
    except (TypeError, ValueError):
        args = repr(tool_call.get("arguments"))
    return f"{name}|{args}"


def _strip_bracket_tool_calls(text: str) -> str:
    """Strip bracket-wrapped tool calls whose name is a REAL tool.

    Name-gated mirror of BRACKET_CALL_RE: only known tool names are removed,
    so config section headers ([probe], [include printer.cfg]) and prose with
    parens survive the cleanup chain.
    """
    known_tool_names = {t["name"] for t in _mcp_server._list_tools()}
    known_tool_names.add(LIST_HARDWARE_SPEC["name"])
    return BRACKET_CALL_RE.sub(
        lambda m: "" if m.group(1).strip() in known_tool_names else m.group(0),
        text,
    )


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
    """Execute a single MCP tool call and return the text result.

    SYNC — some handlers (list_connected_devices, get_klippy_status) do
    blocking host I/O for seconds. From the async chat loop call
    _execute_tool_call_async instead; direct calls are for sync contexts
    only (tests).
    """
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


async def _execute_tool_call_async(tool_call: dict) -> str:
    """Off-thread wrapper for the chat loop (review finding #14).

    list_connected_devices runs CAN/USB scans and get_klippy_status probes
    host endpoints; both block for seconds. Running them inline froze the
    event loop — every other request (health checks, saves, other chats)
    stalled behind one tool call. asyncio.to_thread keeps the loop free.
    """
    return await asyncio.to_thread(_execute_tool_call, tool_call)


async def _run_approval_gate(
    session: EditSession,
    tool_call: dict,
    stop_event: asyncio.Event | None,
    request_id: str | None,
    log,
) -> tuple[str, dict | None]:
    """Approval-gated write (Phase 2). Returns (lean content, details-or-None)
    with the same contract as EditSession.execute().

    Invalid calls kick back immediately — the gate NEVER produces a card
    for a call with new validation errors (plan law). A validated call
    suspends IN-REQUEST: the frontend polls GET /ai/chat/approval for the
    card, POST /ai/chat/approval resolves the Future (approve re-validates
    against the latest frontend state before committing), and a 90s
    non-response auto-declines with an honest reason. The model loop never
    sees a fabricated user intent.
    """
    name = tool_call.get("name", "")
    content, result, _preview_state = session.prepare(tool_call)
    if result is None:
        return content, None  # kickback; no card, no wait

    op = EditSession.tool_call_to_op(name, tool_call.get("arguments", {}) or {})
    approval = create_approval(name, op or {}, result, session, request_id)
    log.info(
        "Approval card opened | approvalId=%s name=%s file=%s timeout=%ds",
        approval.approval_id, name, result.get("file", ""),
        int(APPROVAL_TIMEOUT_SECONDS),
    )
    try:
        decision = await approval.wait_or_stop(APPROVAL_TIMEOUT_SECONDS, stop_event)
    finally:
        remove_approval(approval.approval_id)
    log.info(
        "Approval resolved | approvalId=%s decision=%s waited=%.1fs",
        approval.approval_id, decision.get("decision"),
        approval.loop.time() - approval.created_at,
    )
    if decision.get("decision") != "approved":
        # Decline / timeout / user-stop is USER-GATED: the prose nudge
        # must not pressure the model to retry a decision the user just
        # made (live smoke evidence: post-decline nudge looped into
        # repeated cards for the same target). Only an approve leaves
        # 'success'.
        session.last_write_outcome = "user_gated"
    return format_approval_result(name, decision)


# Client-facing tool-call detail records are capped so a huge tool output
# (e.g. a whole config file read) never bloats the chat response JSON.
TOOL_CALL_ARGS_MAX_CHARS = 2000
TOOL_CALL_OUTPUT_MAX_CHARS = 4000


def _build_executed_tool_call(tool_call: dict, result_text: str) -> dict:
    """Build a bounded {name, arguments, output} record for the client."""
    name = tool_call.get("name", "unknown")
    arguments = tool_call.get("arguments", {})
    try:
        arguments_json = json.dumps(arguments, ensure_ascii=False, sort_keys=True)
    except (TypeError, ValueError):
        arguments_json = json.dumps({"raw": str(arguments)}, ensure_ascii=False)

    if len(arguments_json) > TOOL_CALL_ARGS_MAX_CHARS:
        arguments_json = arguments_json[:TOOL_CALL_ARGS_MAX_CHARS] + "...[truncated]"

    output_text = str(result_text or "")
    output_truncated = len(output_text) > TOOL_CALL_OUTPUT_MAX_CHARS
    if output_truncated:
        output_text = output_text[:TOOL_CALL_OUTPUT_MAX_CHARS] + "...[truncated]"

    return {
        "name": name,
        "arguments": arguments_json,
        "output": output_text,
        "outputTruncated": output_truncated,
    }


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


MAX_MCP_TOOL_TURNS = 10
# With the write tools on, multi-edit requests chain read->edit->retry
# round-trips; 10 exhausted too early (plan Phase 1).
MAX_MCP_TOOL_TURNS_EDIT = 20
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


def _native_tool_object(tool: dict) -> dict:
    return {
        "type": "function",
        "function": {
            "name": tool["name"],
            "description": tool.get("description", "").replace("\n", " "),
            "parameters": tool.get("inputSchema", {"type": "object", "properties": {}}),
        },
    }


def _build_native_tools(edit_capable: bool = False, *,
                        skill_gate: bool = False,
                        skill_active: bool = False) -> list[dict]:
    """Build native function-calling tool definitions from the MCP server.

    Returns OpenAI-style tool objects:
        {"type": "function", "function": {"name", "description", "parameters"}}

    With edit_capable, the request-scoped write tools (config_edit/
    config_write, defined in services.ai_edit_tools, not registered on the
    MCP server) join the advertisement — kept in lock-step with the text
    protocol surface (test_edit_tool_native_text_parity). With skill_gate
    they unlock only after load_skill, and load_skill itself is advertised
    (parity with the text surface's skill index).
    """
    native: list[dict] = []
    for tool in _mcp_server._list_tools():
        native.append(_native_tool_object(tool))
    # Chat-layer read tool (working-state backed, see dispatch):
    # advertised on both protocols for parity.
    native.append(_native_tool_object(LIST_HARDWARE_SPEC))
    if edit_capable:
        if skill_gate:
            native.append(_native_tool_object(LOAD_SKILL_SPEC))
            if skill_active:
                for tool in EDIT_TOOL_SPECS:
                    native.append(_native_tool_object(tool))
        else:
            for tool in EDIT_TOOL_SPECS:
                native.append(_native_tool_object(tool))
    return native


def _resolve_native_tools(provider: str, api_url: str, tool_protocol: str,
                          edit_capable: bool = False, *,
                          skill_gate: bool = False,
                          skill_active: bool = False) -> list[dict] | None:
    """Decide whether to pass native function-calling tools to the provider.

    tool_protocol values (frontend setting / harness via ChatRequest):
      - "auto" (default) NATIVE FIRST for every provider, local llama.cpp
        included. Modern llama.cpp (b456+ --jinja) handles tool templates
        cleanly (verified 2026-09: finish_reason=tool_calls, empty content,
        valid JSON args on gemma-4-12b), and the native machine channel is
        what stops models from reading protocol text back at the user —
        results travel as role=tool turns instead of user-role
        "[Tool result: ...]" lookalikes. Servers that ignore the tools
        array still work: the loop keeps regex text extraction as a
        fallback (native_calls or _extract_tool_calls).
      - "text"   force the text ```tool protocol (escape hatch for a
                 server that advertises tools but emits template garbage).
      - "native" explicit native (identical to auto today; kept as the
                 selector value the UI can pin).
    """
    if tool_protocol == "text":
        return None
    return _build_native_tools(edit_capable=edit_capable,
                               skill_gate=skill_gate,
                               skill_active=skill_active)


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
    merge_system: bool = True,
) -> dict:
    """Build the request payload for the given provider.

    Handles Anthropic's separate system field and OpenAI-compatible
    formats with temperature settings. When tools is provided, native
    function-calling tool definitions are included.

    merge_system: when True (DEFAULT), collapse every system message into a
    single leading system message. OpenAI-compatible servers that use strict
    chat templates (e.g. ones that enforce "system message must be at the
    beginning") reject multiple system messages; a single merged message is
    valid everywhere. Pass False explicitly to preserve the trailing task
    anchor as its own message (positionally meaningful for permissive
    templates) — kept for A/B testing.
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
        if merge_system:
            # Some strict chat templates (e.g. models that enforce "system
            # message must be at the beginning") reject any system message
            # that isn't first. Merge every system message (main prompt,
            # config context, and the trailing task anchor) into a single
            # leading system message — valid everywhere, and preserves the
            # anchor's content alongside the main prompt.
            system_parts = []
            filtered_messages = []
            for msg in messages:
                if msg["role"] == "system":
                    system_parts.append(str(msg["content"]))
                else:
                    filtered_messages.append(msg)
            if system_parts:
                filtered_messages.insert(0, {"role": "system", "content": "\n\n".join(system_parts)})
        else:
            filtered_messages = messages
        payload = {
            "model": model,
            "messages": filtered_messages,
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


def _extract_usage_info(data: dict) -> dict | None:
    """Extract token usage + finish_reason from a provider response.

    Used to surface per-turn budget consumption in /ai/chat responses so the
    accuracy harness can tell a truncated answer (finish_reason=length) from
    a genuinely wrong one. Thinking models report reasoning tokens under
    usage.completion_tokens_details.reasoning_tokens — those count against the
    same max_tokens budget as visible content.
    """
    if not isinstance(data, dict):
        return None
    usage = data.get("usage")
    if not isinstance(usage, dict):
        return None
    choice = (data.get("choices") or [{}])[0]
    completion_tokens = usage.get("completion_tokens")
    if not isinstance(completion_tokens, int):
        return None
    details = usage.get("completion_tokens_details")
    reasoning_tokens = None
    if isinstance(details, dict):
        rt = details.get("reasoning_tokens")
        if isinstance(rt, int):
            reasoning_tokens = rt
    return {
        "completionTokens": completion_tokens,
        "reasoningTokens": reasoning_tokens,
        "finishReason": choice.get("finish_reason") or "",
    }


def _build_api_base_url(api_url: str) -> str:
    parsed = urlparse(api_url)
    if not parsed.scheme or not parsed.netloc:
        return api_url.rstrip("/")
    return urlunparse((parsed.scheme, parsed.netloc, "", "", "", "")).rstrip("/")


def _models_url_from_chat_url(api_url: str) -> str:
    """Derive the provider's model-list URL from its chat-completions URL.

    Every provider we proxy exposes model listing at the same base as chat,
    with the trailing chat path swapped for /models:

      https://api.openai.com/v1/chat/completions
          -> https://api.openai.com/v1/models
      https://generativelanguage.googleapis.com/v1beta/openai/chat/completions
          -> https://generativelanguage.googleapis.com/v1beta/openai/models
      https://models.github.ai/inference/chat/completions
          -> https://models.github.ai/inference/models
      https://api.anthropic.com/v1/messages
          -> https://api.anthropic.com/v1/models
      http://localhost:11434/v1/chat/completions
          -> http://localhost:11434/v1/models
    """
    parsed = urlparse(api_url)
    if not parsed.scheme or not parsed.netloc:
        return ""
    path = parsed.path
    for suffix in ("/chat/completions", "/completions", "/messages"):
        if path.endswith(suffix):
            path = path[: -len(suffix)]
            break
    models_path = f"{path.rstrip('/')}/models"
    return urlunparse((parsed.scheme, parsed.netloc, models_path, "", "", ""))


def _provider_auth_headers(provider: str, api_url: str, api_key: str) -> dict:
    """Build auth headers for the configured provider.

    Anthropic uses x-api-key; local OpenAI-compatible servers make auth
    optional (include a Bearer token only when a key was provided);
    everything else uses a Bearer token.
    """
    if provider == "anthropic":
        return {
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        }
    if _is_local_provider(provider, api_url):
        headers = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        return headers
    return {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }


@router.post("/ai/models")
async def list_models(req: ModelsRequest):
    """Proxy the provider's model-list endpoint (server-side).

    The browser can't reliably call cloud /v1/models endpoints directly
    (CORS) and must not put the API key in a query string. This route
    derives the model URL from the chat URL and fetches it with the same
    auth the chat proxy uses, returning just the model ids.
    """
    provider = req.apiProvider.value if hasattr(req.apiProvider, "value") else req.apiProvider
    models_url = _models_url_from_chat_url(req.apiUrl)
    if not models_url:
        return {"models": []}

    headers = _provider_auth_headers(provider, req.apiUrl, req.apiKey)
    timeout = httpx.Timeout(connect=15.0, read=30.0, write=30.0, pool=30.0)
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            res = await client.get(models_url, headers=headers)
            res.raise_for_status()
            data = res.json()
    except httpx.TimeoutException:
        logger.warning("Model list timeout | url=%s", models_url)
        return {"models": [], "error": "Timed out listing models"}
    except httpx.HTTPError as e:
        logger.warning("Model list failed | url=%s error=%s", models_url, e)
        return {"models": [], "error": f"Failed to list models: {e}"}

    ids: list[str] = []
    if isinstance(data, dict):
        entries = data.get("data")
        if isinstance(entries, list):
            for m in entries:
                if isinstance(m, dict) and isinstance(m.get("id"), str):
                    ids.append(m["id"])
    logger.info("Model list | provider=%s url=%s count=%d", provider, models_url, len(ids))
    return {"models": ids}


# Mirror-seed caps (Pi 3B+ memory): per-file and total content limits so a
# misconfigured scan root can never load gigabytes into an edit session.
_MIRROR_MAX_FILE_BYTES = 512 * 1024
_MIRROR_MAX_TOTAL_BYTES = 4 * 1024 * 1024


def _mirror_user_config_files() -> dict[str, dict]:
    """Read the backend's user-config mirror as a contextFiles-shaped dict.

    Same source and precedence as the read_user_config/list_user_configs
    MCP tools (system config path first, then the imported local dir;
    first occurrence of a relative path wins; SAVE_CONFIG backups
    skipped). Used to ARM the edit session when a client requests
    editTools but sends no contextFiles (TRIDENT-16: an un-armed session
    has no write tools, so the model correctly falls back to prose and
    the whole tool path silently disappears). The mirror is the disk
    truth; approval still re-validates against the client's latest
    contextFiles, so a stale mirror can never clobber unsaved edits.
    """
    from mcp_server import LOCAL_CONFIGS_DIR, _system_config_path
    from services.native_services import is_backup_config_file

    files: dict[str, str] = {}
    total = 0
    scan_paths: list[Path] = []
    system_path = _system_config_path()
    if system_path.is_dir():
        scan_paths.append(system_path)
    if LOCAL_CONFIGS_DIR.is_dir():
        scan_paths.append(LOCAL_CONFIGS_DIR)
    for scan_dir in scan_paths:
        try:
            for cfg_file in sorted(scan_dir.rglob("*.cfg")):
                if is_backup_config_file(cfg_file.name):
                    continue
                try:
                    rel = cfg_file.relative_to(scan_dir).as_posix()
                except ValueError:
                    continue
                if rel in files:
                    continue
                try:
                    size = cfg_file.stat().st_size
                    if size > _MIRROR_MAX_FILE_BYTES or total + size > _MIRROR_MAX_TOTAL_BYTES:
                        continue
                    content = cfg_file.read_bytes().decode("utf-8", errors="replace")
                except OSError:
                    continue
                files[rel] = {"content": content}
                total += size
        except OSError:
            continue
    return files


@router.post("/ai/chat")
async def chat_proxy(req: ChatRequest):
    """Proxy chat messages to the user's configured API provider."""
    # ── Tool-mediated config editing session (Phase 1, KWC_EDIT_TOOLS) ──
    # Request-scoped: seeded from this request's contextFiles (the app's
    # live working state), stacked edits returned as pendingEdits. No
    # per-conversation draft store by design. Without live files there is
    # nothing to edit — tools stay unadvertised.
    edit_enabled = req.editTools if req.editTools is not None else _edit_tools_enabled()
    edit_session: EditSession | None = None
    if edit_enabled and req.contextFiles:
        try:
            edit_session = EditSession(req.contextFiles)
            if not edit_session.has_files():
                edit_session = None
        except Exception:
            logger.exception("Edit session seed failed | edit tools disabled for request")
            edit_session = None
    if edit_enabled and edit_session is None:
        # TRIDENT-16: editTools requested without contextFiles (harness,
        # API clients, degraded UI state) used to leave the session
        # un-armed — no write tools advertised, so prose fallback was the
        # model's only option and every edit silently went inert. Seed
        # from the backend's user-config mirror instead.
        try:
            mirror = _mirror_user_config_files()
        except Exception:
            logger.exception("Mirror seed failed | edit tools disabled for request")
            mirror = {}
        if mirror:
            try:
                edit_session = EditSession(mirror)
                if not edit_session.has_files():
                    edit_session = None
                else:
                    logger.info(
                        "Edit session seeded from user-config mirror | files=%d",
                        len(mirror),
                    )
            except Exception:
                logger.exception("Mirror edit session failed | edit tools disabled")
                edit_session = None
    edit_capable = edit_session is not None

    # ── Phase 3: model-triggered edit skill gate ──
    # When gated, write tools start HIDDEN even though the session exists;
    # they unlock when the model calls load_skill itself (mechanical
    # evidence in message history — never a verb heuristic). Same-turn
    # unlock: every provider payload below re-resolves tools from
    # _skill_state, which flips as soon as the load_skill result lands.
    skill_gate = edit_capable and _edit_skill_gate_enabled()
    _skill_state = {'active': _load_skill_active(req.messages)}
    # Harness A/B: --edit-skill on forces activation evidence WITHOUT
    # requiring a live load_skill call (grades tool-call traces directly).
    if skill_gate and getattr(req, 'editSkill', None) is True:
        _skill_state['active'] = True

    def _current_skill_gate() -> bool:
        return skill_gate and not _skill_state['active']

    messages = _prepare_messages(req.messages,
                                 edit_capable=edit_capable,
                                 skill_gate=skill_gate,
                                 skill_active=_skill_state['active'],
                                 context_files=req.contextFiles,
                                 native_mode=_resolve_native_tools(
                                     req.apiProvider, req.apiUrl, req.toolProtocol,
                                     edit_capable=edit_capable,
                                     skill_gate=skill_gate,
                                     skill_active=_skill_state['active']) is not None)

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

    # Build headers based on provider (shared with the /ai/models proxy).
    headers = _provider_auth_headers(
        req.apiProvider.value if hasattr(req.apiProvider, "value") else req.apiProvider,
        req.apiUrl,
        req.apiKey,
    )

    # Tool protocol: native function calling is the DEFAULT for every
    # provider (see _resolve_native_tools). toolProtocol="text" forces the
    # ```tool fallback; the loop still regex-extracts text calls when a
    # native server ignores the tools array, so degradation is graceful.
    native_tools = _resolve_native_tools(req.apiProvider, req.apiUrl, req.toolProtocol,
                                         edit_capable=edit_capable,
                                         skill_gate=skill_gate,
                                         skill_active=_skill_state['active'])

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
                merge_system=req.mergeSystemMessages,
            )

            current_content, current_data = await _query_provider(
                client, req.apiUrl, headers, payload, req.apiProvider,
                logger_context="initial",
                stop_event=stop_event,
            )
            usage_events: list[dict] = []
            initial_usage = _extract_usage_info(current_data)
            if initial_usage:
                initial_usage["context"] = "initial"
                usage_events.append(initial_usage)

            tool_turns = 0
            current_messages = list(messages)
            executed_tool_names: list[str] = []
            executed_tool_calls: list[dict] = []
            # Literal (name, args) keys of every guarded READ executed this
            # request — see REPEAT_GUARD_TOOLS. Reset per request by
            # construction (local to chat_proxy).
            read_ledger: set[str] = set()
            # Re-prompts issued to correct a malformed ```tool fence (see the
            # malformed tool-call guard in the loop below).
            malformed_reprompts = 0

            # Edit-prose nudge budget (the nudge itself lives in the tool
            # loop's no-tool-calls branch — it must cover prose answers at
            # ANY turn: r6b found qwen3.5-9b calling read_user_config
            # legitimately, THEN answering with a ```cfg draft, which the
            # old pre-loop-only nudge missed).
            edit_nudges = 0

            turn_cap = (MAX_MCP_TOOL_TURNS_EDIT if edit_capable
                        else MAX_MCP_TOOL_TURNS)
            while tool_turns < turn_cap:
                if stop_event is not None and stop_event.is_set():
                    raise ChatStoppedError()

                # Native function calls come from the structured response body
                # (OpenAI tool_calls / Anthropic tool_use blocks); otherwise
                # fall back to regex extraction from the response text.
                native_calls = _extract_native_tool_calls(req.apiProvider, current_data)
                tool_calls = native_calls or _extract_tool_calls(current_content)
                if not tool_calls:
                    # ── Malformed tool-call guard ──
                    # A ```tool fence that failed to parse (or an unterminated
                    # fence) is unambiguous tool intent — without this, the
                    # loop sees "no tool calls, non-empty text", stops, and
                    # the raw broken markup leaks into the chat bubble. Issue
                    # ONE format-correction re-prompt (never quoting the
                    # broken call — REPAIR-01) instead of terminating.
                    if (
                        malformed_reprompts < MALFORMED_TOOL_REPROMPT_LIMIT
                        and _malformed_tool_call_detected(current_content, tool_calls)
                    ):
                        malformed_reprompts += 1
                        tool_turns += 1
                        logger.warning(
                            "Malformed tool call | re-prompting with format "
                            "correction (%d/%d) preview=%s",
                            malformed_reprompts, MALFORMED_TOOL_REPROMPT_LIMIT,
                            current_content[:120].replace("\n", " "),
                        )
                        current_messages.append({
                            "role": "user",
                            "content": MALFORMED_TOOL_FORMAT_FEEDBACK,
                        })
                        malformed_payload = _build_provider_payload(
                            req.apiProvider, current_messages, req.model,
                            max_tokens=req.maxTokens,
                            temperature=req.temperature,
                            tools=native_tools,
                            merge_system=req.mergeSystemMessages,
                        )
                        current_content, current_data = await _query_provider(
                            client, req.apiUrl, headers, malformed_payload, req.apiProvider,
                            logger_context=f"malformed-reprompt-{malformed_reprompts}",
                            stop_event=stop_event,
                        )
                        malformed_usage = _extract_usage_info(current_data)
                        if malformed_usage:
                            malformed_usage["context"] = f"malformed-reprompt-{malformed_reprompts}"
                            usage_events.append(malformed_usage)
                        continue
                    # ── Edit-prose nudge (KWC_EDIT_TOOLS) ──
                    # Edit request + write tools armed + prose answer (no
                    # tool call): prose edits are INERT — old draft-text
                    # semantics must not silently resume. Correction
                    # re-prompt (max 2), same escalation style as the
                    # malformed guard. Pure Q&A never matches this gate.
                    if (edit_session is not None
                            and _is_edit_request(req.messages)
                            # Nudge ONLY on mechanical evidence of an inert
                            # draft: (a) the write trace ENDED on a
                            # CORRECTABLE kickback (r4 give-up; r5
                            # multi-part give-up hiding behind a staged
                            # first half), or (b) the final answer CONTAINS
                            # a fenced cfg block — the inert-draft shape
                            # (r6: create succeeded, include re-drafted as
                            # prose cfg after the tool-side include
                            # failed). A staged change never proves the
                            # whole intent is covered; a cfg block in prose
                            # always proves inert drafting.
                            # NOT nudged on bare outcome=None: Q20 r3/B
                            # (2026-09-16) proved the verb+target heuristic
                            # misfires on pure Q&A ("which command SAVES
                            # ... into the config file") — the model
                            # ANSWERED correctly and the nudge gaslit it
                            # into "tell me what change you want". Prose
                            # with no draft and no write attempt is treated
                            # as an answer/refusal (r8 refusal-wins
                            # philosophy); user_gated refusals likewise
                            # protected.
                            and (
                                edit_session.last_write_outcome
                                == 'correctable'
                                or (bool(extract_config_code_blocks(
                                        current_content))
                                    # An honest user-gated outcome (decline,
                                    # timeout, stop, duplicate target) often
                                    # still illustrates with a ```cfg block;
                                    # nudging THAT pressure-cooks the model
                                    # into re-attempting an explicit user
                                    # decision. Refusal wins. (The commented-
                                    # param refusals this clause originally
                                    # guarded were removed 2026-09-20.)
                                    and edit_session.last_write_outcome
                                    != 'user_gated'
                                    # Echo guard (native-mode traces
                                    # 2026-09-17): after an APPROVED write
                                    # models re-quote the staged section in
                                    # a ```cfg block to show it. Structural
                                    # test — a block whose config lines all
                                    # exist in the working state is a
                                    # display echo; only content absent
                                    # from the project is an inert draft.
                                    # (outcome=='correctable' above still
                                    # nudges unconditionally.)
                                    and edit_session.has_inert_draft(
                                        extract_config_code_blocks(
                                            current_content)))
                            )
                            and edit_nudges < 3):
                        edit_nudges += 1
                        logger.info(
                            "Edit prose response nudged | attempt=%d turn=%d content_chars=%d",
                            edit_nudges, tool_turns, len(current_content),
                        )
                        if current_content.strip():
                            clean_prior = MCP_TOOL_BLOCK_RE.sub("", current_content).strip()
                            if clean_prior:
                                current_messages.append(
                                    {"role": "assistant", "content": clean_prior})
                        current_messages.append({
                            "role": "user",
                            # Protocol-aware nudge: the fence format law in
                            # EDIT_NUDGE_TEXT is text-protocol only. Under
                            # native function calling it actively breaks
                            # template-trained models (live native traces
                            # 2026-09-17: gemma-4-12b replied "I cannot use
                            # that specific fence format... my instructions
                            # require me to use the internal tool calling
                            # system"). Native arm keeps the argument
                            # shapes, drops the fence law.
                            "content": (_LOAD_SKILL_NUDGE_TEXT
                                        if _current_skill_gate()
                                        else EDIT_NUDGE_TEXT_NATIVE
                                        if native_tools is not None
                                        else EDIT_NUDGE_TEXT),
                        })
                        nudge_payload = _build_provider_payload(
                            req.apiProvider, current_messages, req.model,
                            max_tokens=req.maxTokens,
                            temperature=req.temperature,
                            tools=native_tools,
                            merge_system=req.mergeSystemMessages,
                        )
                        current_content, current_data = await _query_provider(
                            client, req.apiUrl, headers, nudge_payload,
                            req.apiProvider,
                            logger_context=f"edit-nudge-{edit_nudges}",
                            stop_event=stop_event,
                        )
                        nudge_usage = _extract_usage_info(current_data)
                        if nudge_usage:
                            nudge_usage["context"] = f"edit-nudge-{edit_nudges}"
                            usage_events.append(nudge_usage)
                        continue
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
                if edit_capable:
                    known_tool_names |= EDIT_TOOL_NAMES
                if skill_gate:
                    known_tool_names.add(LOAD_SKILL_SPEC["name"])
                known_tool_names.add(LIST_HARDWARE_SPEC["name"])
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
                    repeat_key = _repeat_read_key(tool_call)
                    if repeat_key and repeat_key in read_ledger:
                        # Literal repeat of a read already answered this
                        # request: no execution, no payload — the model
                        # gets the directive and nothing else (see
                        # REPEAT_GUARD_TOOLS).
                        result_text = REPEAT_READ_FEEDBACK
                        logger.info(
                            "Repeat read blocked | name=%s args=%.120s",
                            tool_call.get("name"),
                            json.dumps(tool_call.get("arguments") or {},
                                       sort_keys=True, default=str),
                        )
                        results.append(result_text)
                        continue
                    if skill_gate and tool_call.get('name') == 'load_skill':
                        # Dispatch by REQUESTED skill name — loading
                        # printer-memory must never unlock the edit tools
                        # (only the config-editing load flips the gate).
                        edit_details = None
                        requested = str(
                            (tool_call.get('arguments') or {}).get('name', ''))
                        if requested == MEMORY_SKILL_NAME:
                            result_text = _memory_skill_body()
                            logger.info(
                                "Printer-memory skill loaded "
                                "| requestId=%s", req.requestId or 'none')
                        elif requested in ('', EDIT_SKILL_NAME):
                            # Idempotent re-load after activation: body is
                            # already in history; serve it again. First
                            # load: flip the gate and re-resolve tools.
                            if not _skill_state['active']:
                                _skill_state['active'] = True
                                native_tools = _resolve_native_tools(
                                    req.apiProvider, req.apiUrl,
                                    req.toolProtocol,
                                    edit_capable=edit_capable,
                                    skill_active=True)
                                logger.info(
                                    "Edit skill activated | write tools "
                                    "unlocked mid-request requestId=%s",
                                    req.requestId or 'none')
                            result_text = _edit_skill_body()
                        else:
                            result_text = (
                                f"Unknown skill '{requested}'. Available "
                                f"skills: '{EDIT_SKILL_NAME}', "
                                f"'{MEMORY_SKILL_NAME}'.")
                    elif edit_session is not None and tool_call.get("name") in EDIT_TOOL_NAMES:
                        if _current_skill_gate():
                            # Write tool used WITHOUT loading the skill:
                            # kick back with the load step, not the edit.
                            result_text = (
                                f"'{tool_call.get('name')}' is not available yet. "
                                f"Call load_skill(name='{EDIT_SKILL_NAME}') "
                                "first — it returns the edit rules and "
                                "unlocks the edit tools.")
                            edit_details = None
                            logger.warning(
                                "Edit tool blocked | skill not loaded name=%s",
                                tool_call.get('name'))
                        else:
                            # Request-scoped write path (never the MCP server).
                            if req.autoApproveEdits:
                                # Harness override: skip ONLY the human wait;
                                # validation (execute's apply+delta gate) is
                                # unchanged.
                                result_text, edit_details = edit_session.execute(tool_call)
                            else:
                                result_text, edit_details = await _run_approval_gate(
                                    edit_session, tool_call, stop_event,
                                    req.requestId, logger)
                            logger.info(
                                "Edit tool executed | name=%s attempts=%d ok=%s",
                                tool_call["name"], edit_session.edit_attempts,
                                edit_details is not None,
                            )
                    elif (tool_call.get("name") == "list_hardware"):
                        # Chat-layer read tool (NOT the MCP server): the
                        # MCP server sees only disk, while the approval
                        # flow keeps the live project in the session's
                        # working state — a disk read could hand back
                        # stale section text and manufacture old_text
                        # mismatch kickbacks one edit later.
                        from services.hardware_lookup import (
                            list_hardware as _list_hardware)
                        # Working state first (approved unsaved edits win),
                        # with the user-config mirror as a FLOOR: class
                        # members live in files the frontend may not have
                        # loaded (TRIDENT-15 design: SB_LEDs in EBB.cfg),
                        # and the mirror is the same source
                        # search_user_configs reads.
                        hw_files = dict(edit_session.state.files) \
                            if edit_session is not None else {}
                        if not hw_files:
                            hw_files = {
                                name: str((meta or {}).get("content", ""))
                                for name, meta in
                                (req.contextFiles or {}).items()
                            }
                        try:
                            for mname, mmeta in (
                                    _mirror_user_config_files()).items():
                                hw_files.setdefault(
                                    mname,
                                    str((mmeta or {}).get("content", "")))
                        except Exception:
                            logger.debug(
                                "list_hardware mirror floor "
                                "unavailable", exc_info=True)
                        try:
                            result_text = _list_hardware(
                                hw_files,
                                str(tool_call.get("arguments", {})
                                    .get("type", "")))
                        except Exception:
                            logger.exception(
                                "list_hardware failed | type=%s",
                                tool_call.get("arguments", {}))
                            result_text = ("list_hardware failed "
                                           "unexpectedly — fall back "
                                           "to search_user_configs.")
                    else:
                        result_text = await _execute_tool_call_async(tool_call)
                    if repeat_key:
                        # Executed for the first time this request: any
                        # literal repeat now gets the lean directive.
                        read_ledger.add(repeat_key)
                    logger.info(
                        "Tool executed | name=%s result_chars=%d",
                        tool_call["name"], len(result_text),
                    )
                    executed_tool_names.append(tool_call["name"])
                    executed_tool_calls.append(
                        _build_executed_tool_call(tool_call, result_text)
                    )
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

                        clean_content = _strip_template_pythonic_calls(current_content).strip()
                        clean_content = MCP_TOOL_BLOCK_RE.sub("", clean_content).strip()
                        clean_content = ALT_TOOL_CALL_CONTENT_RE.sub("", clean_content).strip()
                        clean_content = CALL_SYNTAX_CLEANUP_RE.sub("", clean_content).strip()
                        clean_content = FUNC_CALL_CLEANUP_RE.sub("", clean_content).strip()
                        clean_content = _strip_bracket_tool_calls(clean_content).strip()
                        clean_content = DSML_CLEANUP_RE.sub("", clean_content).strip()
                        clean_content = XML_TOOL_CALLS_CLEANUP_RE.sub("", clean_content).strip()
                        if clean_content:
                            current_messages.append({"role": "assistant", "content": clean_content})
                        current_messages.append({"role": "user", "content": tool_message})
                    tool_turns += len(tool_calls)

                tool_payload = _build_provider_payload(
                    req.apiProvider, current_messages, req.model,
                    max_tokens=req.maxTokens,
                    temperature=req.temperature,
                    tools=native_tools,
                    merge_system=req.mergeSystemMessages,
                )
                current_content, current_data = await _query_provider(
                    client, req.apiUrl, headers, tool_payload, req.apiProvider,
                    logger_context=f"tool-turn-{tool_turns}",
                    stop_event=stop_event,
                )
                turn_usage = _extract_usage_info(current_data)
                if turn_usage:
                    turn_usage["context"] = f"tool-turn-{tool_turns}"
                    usage_events.append(turn_usage)

            # Clean up any remaining tool call blocks in the final content.
            # Check whether the content contained tool call blocks BEFORE cleanup
            # so we don't restore raw tool call text back into the visible output.
            had_tool_blocks = bool(
                TEMPLATE_CALL_HEAD_RE.search(current_content)
                or MCP_TOOL_BLOCK_RE.search(current_content)
                or ALT_TOOL_CALL_CONTENT_RE.search(current_content)
                or CALL_SYNTAX_CLEANUP_RE.search(current_content)
                or FUNC_CALL_CLEANUP_RE.search(current_content)
                or DSML_CLEANUP_RE.search(current_content)
                or XML_TOOL_CALLS_CLEANUP_RE.search(current_content)
                or UNTERMINATED_TOOL_FENCE_RE.search(current_content)
            )
            final_content = _strip_template_pythonic_calls(current_content).strip()
            final_content = MCP_TOOL_BLOCK_RE.sub("", final_content).strip()
            final_content = ALT_TOOL_CALL_CONTENT_RE.sub("", final_content).strip()
            final_content = CALL_SYNTAX_CLEANUP_RE.sub("", final_content).strip()
            final_content = FUNC_CALL_CLEANUP_RE.sub("", final_content).strip()
            final_content = _strip_bracket_tool_calls(final_content).strip()
            final_content = DSML_CLEANUP_RE.sub("", final_content).strip()
            # An unterminated ```tool fence (truncated broken call) would
            # otherwise leak raw markup into the bubble — it always extends
            # to end of content, so a tail-strip is safe.
            final_content = UNTERMINATED_TOOL_FENCE_RE.sub("", final_content).strip()
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
            reprompt_tool_turns = 0
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
                    merge_system=req.mergeSystemMessages,
                )
                current_content, current_data = await _query_provider(
                    client, req.apiUrl, headers, retry_payload, req.apiProvider,
                    logger_context=f"empty-reprompt-{empty_reprompts}",
                    stop_event=stop_event,
                )
                retry_usage = _extract_usage_info(current_data)
                if retry_usage:
                    retry_usage["context"] = f"empty-reprompt-{empty_reprompts}"
                    usage_events.append(retry_usage)

                # Some models (DeepSeek "flash", Qwen, ...) ignore the
                # no-tools instruction and emit tool calls as plain text —
                # bare <tool_calls> XML, DSML, or ```tool blocks. Execute them
                # so the turn isn't wasted on raw markup or the fallback
                # message; the tool results usually let the model answer.
                reprompt_calls = (
                    _extract_native_tool_calls(req.apiProvider, current_data)
                    or _extract_tool_calls(current_content)
                )
                if reprompt_calls and reprompt_tool_turns < MAX_MCP_TOOL_TURNS:
                    reprompt_tool_turns += len(reprompt_calls)
                    tool_turns += len(reprompt_calls)
                    empty_reprompts -= 1  # productive turn, not a failed attempt
                    logger.info(
                        "Empty re-prompt returned tool calls | executing %d (reprompt_turns=%d)",
                        len(reprompt_calls), reprompt_tool_turns,
                    )
                    clean_assistant = MCP_TOOL_BLOCK_RE.sub("", current_content).strip()
                    clean_assistant = ALT_TOOL_CALL_CONTENT_RE.sub("", clean_assistant).strip()
                    clean_assistant = CALL_SYNTAX_CLEANUP_RE.sub("", clean_assistant).strip()
                    clean_assistant = FUNC_CALL_CLEANUP_RE.sub("", clean_assistant).strip()
                    clean_assistant = _strip_bracket_tool_calls(clean_assistant).strip()
                    clean_assistant = DSML_CLEANUP_RE.sub("", clean_assistant).strip()
                    clean_assistant = XML_TOOL_CALLS_CLEANUP_RE.sub("", clean_assistant).strip()
                    if clean_assistant:
                        current_messages.append({"role": "assistant", "content": clean_assistant})
                    reprompt_results = [
                        (edit_session.execute(c)[0]
                         if edit_session is not None and c.get("name") in EDIT_TOOL_NAMES
                         else await _execute_tool_call_async(c))
                        for c in reprompt_calls[:MAX_MCP_TOOL_TURNS]
                    ]
                    for reprompt_call, result_text in zip(
                        reprompt_calls[:MAX_MCP_TOOL_TURNS],
                        reprompt_results,
                    ):
                        executed_tool_names.append(reprompt_call["name"])
                        executed_tool_calls.append(
                            _build_executed_tool_call(reprompt_call, result_text)
                        )
                        current_messages.append({
                            "role": "user",
                            "content": _build_tool_result_message(reprompt_call, result_text),
                        })
                    continue

                final_content = MCP_TOOL_BLOCK_RE.sub("", current_content).strip()
                final_content = ALT_TOOL_CALL_CONTENT_RE.sub("", final_content).strip()
                final_content = CALL_SYNTAX_CLEANUP_RE.sub("", final_content).strip()
                final_content = FUNC_CALL_CLEANUP_RE.sub("", final_content).strip()
                final_content = _strip_bracket_tool_calls(final_content).strip()
                final_content = DSML_CLEANUP_RE.sub("", final_content).strip()
                final_content = XML_TOOL_CALLS_CLEANUP_RE.sub("", final_content).strip()

            # Collect tool names used during the MCP tool loop. Native tool
            # calls don't leave `[Tool result: ...]` messages, so fall back
            # to the names captured while executing them.
            mcp_tool_names = _collect_tool_names(current_messages)
            if not mcp_tool_names and executed_tool_names:
                mcp_tool_names = list(dict.fromkeys(executed_tool_names))


            # ── Confabulated-completion guard (TRIDENT-15) ──
            # The write path was ATTEMPTED (>=1 config_edit/config_write
            # call) and the request ENDED with NOTHING staged: every op
            # was a correctable kickback, a user decline, or a 90s
            # approval timeout. Replies in this state habitually claim
            # the change "has been staged/applied" (r2: "the tool call
            # has already been executed and the changes are staged").
            # We do NOT parse the prose to judge the claim (intent law):
            # the trace is ground truth, so a note stating it is appended
            # whenever trace and expectation disagree. Fail-safe — a
            # wrong note is a useless observation; silence is the status
            # quo. Never fires when anything IS staged (coarse on
            # partial success, which the cards show honestly).
            if (edit_session is not None
                    and edit_session.edit_attempts
                    and not edit_session.pending_edits):
                logger.warning(
                    "Confab guard | write attempts=%d outcome=%s staged=0"
                    " | appending trace-truth note",
                    edit_session.edit_attempts,
                    edit_session.last_write_outcome,
                )
                # The trace distinguishes a USER decision from technical
                # failures — the note must not conflate them (a blanket
                # "failed validation, was declined, or timed out" made
                # models report a plain decline as "the system declined
                # it").
                if edit_session.last_write_outcome == "user_gated":
                    note = (
                        "\n\n---\n*Note: the user chose not to apply the "
                        "proposed change(s); nothing is staged for "
                        "saving.*"
                    )
                else:
                    note = (
                        "\n\n---\n*Note: no changes from this reply are"
                        " staged for saving — every edit attempt failed"
                        " validation, was declined, or timed out.*"
                    )
                final_content = final_content.rstrip() + note

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
                "toolCalls": executed_tool_calls,
                "repromptCount": empty_reprompts,
                # Tool-mediated editing (Phase 1): staged changes from
                # config_edit/config_write calls (file/op/summary/newText/
                # advisories), null when the feature is off or nothing was
                # staged. The frontend feeds these to the current draft
                # flow (approval cards arrive in Phase 2).
                "pendingEdits": (
                    edit_session.pending_edits_payload()
                    if edit_session is not None and edit_session.pending_edits
                    else None
                ),
                # Per-call write-attempt accounting (Gate 1 oscillation
                # analysis); null when the session never ran.
                "editAttempts": (
                    edit_session.edit_attempts if edit_session is not None else None
                ),
                "usage": {
                    "completionTokens": sum(
                        (e.get("completionTokens") or 0) for e in usage_events
                    ),
                    "reasoningTokens": sum(
                        (e.get("reasoningTokens") or 0) for e in usage_events
                    ),
                    "events": usage_events,
                    "truncated": any(
                        (e.get("finishReason") or "") == "length" for e in usage_events
                    ),
                },
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


# ── AI state + chat history file storage ─────────────────────────────
# Chat settings, the current in-progress conversation, and saved chat
# history live in gitignored JSON files under backend/data/ai/ so they
# survive browser cache clears and are not pushed to GitHub.

AI_DATA_DIR = BACKEND_DIR / "data" / "ai"
AI_STATE_FILE = AI_DATA_DIR / "state.json"
AI_HISTORY_FILE = AI_DATA_DIR / "history.json"


def _load_ai_json(file_path: Path) -> dict:
    try:
        payload = json.loads(file_path.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else {}
    except (OSError, ValueError):
        return {}


def _save_ai_json(file_path: Path, payload: dict) -> None:
    AI_DATA_DIR.mkdir(parents=True, exist_ok=True)
    file_path.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )


@router.get("/ai/state")
async def get_ai_state() -> dict:
    """Load the saved AI settings and in-progress conversation."""
    return _load_ai_json(AI_STATE_FILE)


@router.post("/ai/state")
async def save_ai_state(payload: dict) -> dict:
    """Persist AI settings and the in-progress conversation to disk."""
    _save_ai_json(AI_STATE_FILE, payload)
    return {"status": "saved"}


@router.get("/ai/history")
async def get_ai_history() -> dict:
    """Load the saved chat history (list of conversations)."""
    return _load_ai_json(AI_HISTORY_FILE)


@router.post("/ai/history")
async def save_ai_history(payload: dict) -> dict:
    """Persist the saved chat history to disk."""
    _save_ai_json(AI_HISTORY_FILE, payload)
    return {"status": "saved"}
