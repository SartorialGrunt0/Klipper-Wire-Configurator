import sys

import httpx


sys.path.insert(0, 'backend')

from api.ai_routes import (  # noqa: E402
    LM_STUDIO_KLIPPER_DOCS_PLUGIN_ID,
    _build_lm_studio_mcp_metadata,
    _build_lm_studio_chat_payload,
    _build_lm_studio_chat_url,
    _extract_lm_studio_message_content,
    _extract_lm_studio_tool_names,
    _normalize_lm_studio_mcp_plugin_id,
    _should_fallback_lm_studio_request,
)


messages = [
    {"role": "system", "content": "System instructions."},
    {"role": "user", "content": "My printer is a Voron 2.4."},
    {"role": "assistant", "content": "Understood."},
    {"role": "user", "content": "What does [bed_mesh] horizontal_move_z do?"},
]

payload = _build_lm_studio_chat_payload(messages, 'unsloth/qwen3.5-9b')
assert payload['model'] == 'unsloth/qwen3.5-9b'
assert payload['store'] is False
assert payload['system_prompt'] == 'System instructions.'
assert payload['integrations'] == [LM_STUDIO_KLIPPER_DOCS_PLUGIN_ID]
assert 'Conversation so far:' in payload['input']
assert 'Current user request:' in payload['input']
assert 'horizontal_move_z' in payload['input']

lm_studio_url = _build_lm_studio_chat_url('http://localhost:1234/v1/chat/completions')
assert lm_studio_url == 'http://localhost:1234/api/v1/chat'
assert _normalize_lm_studio_mcp_plugin_id(None) == LM_STUDIO_KLIPPER_DOCS_PLUGIN_ID
assert _normalize_lm_studio_mcp_plugin_id('  mcp/custom-klipper-docs  ') == 'mcp/custom-klipper-docs'
assert _normalize_lm_studio_mcp_plugin_id('   ') is None

custom_payload = _build_lm_studio_chat_payload(messages, 'unsloth/qwen3.5-9b', 'mcp/custom-klipper-docs')
assert custom_payload['integrations'] == ['mcp/custom-klipper-docs']

disabled_payload = _build_lm_studio_chat_payload(messages, 'unsloth/qwen3.5-9b', None)
assert 'integrations' not in disabled_payload

response_payload = {
    'output': [
        {'type': 'reasoning', 'content': 'Looking up docs...'},
        {
            'type': 'tool_call',
            'tool': 'lookup',
            'arguments': {'query': 'bed_mesh'},
            'output': '...',
            'provider_info': {'type': 'plugin', 'plugin_id': LM_STUDIO_KLIPPER_DOCS_PLUGIN_ID},
        },
        {'type': 'message', 'content': 'horizontal_move_z sets the Z hop before XY travel.'},
        {'type': 'message', 'content': 'Increase it only enough to clear clips or parts.'},
    ]
}
assert _extract_lm_studio_message_content(response_payload) == (
    'horizontal_move_z sets the Z hop before XY travel.\n\n'
    'Increase it only enough to clear clips or parts.'
)
assert _extract_lm_studio_tool_names(response_payload, LM_STUDIO_KLIPPER_DOCS_PLUGIN_ID) == ['lookup']

used_metadata = _build_lm_studio_mcp_metadata(
    LM_STUDIO_KLIPPER_DOCS_PLUGIN_ID,
    'api-v1-chat',
    tool_names=['lookup'],
)
assert used_metadata == {
    'requested': True,
    'pluginId': LM_STUDIO_KLIPPER_DOCS_PLUGIN_ID,
    'route': 'api-v1-chat',
    'toolUsed': True,
    'toolNames': ['lookup'],
    'fallbackUsed': False,
    'fallbackReason': None,
}

disabled_metadata = _build_lm_studio_mcp_metadata(None, 'openai-compatible')
assert disabled_metadata == {
    'requested': False,
    'pluginId': None,
    'route': 'openai-compatible',
    'toolUsed': False,
    'toolNames': [],
    'fallbackUsed': False,
    'fallbackReason': None,
}

assert _should_fallback_lm_studio_request(404, 'Not Found') is True
assert _should_fallback_lm_studio_request(401, 'Authorization required for mcp.json plugin access') is True
assert _should_fallback_lm_studio_request(400, 'Model not found') is False

request = httpx.Request('POST', 'http://localhost:1234/api/v1/chat')
response = httpx.Response(403, request=request, text='Allow calling servers from mcp.json must be enabled')
error = httpx.HTTPStatusError('forbidden', request=request, response=response)
assert _should_fallback_lm_studio_request(error.response.status_code, error.response.text) is True

print('LM Studio MCP support helpers verified')