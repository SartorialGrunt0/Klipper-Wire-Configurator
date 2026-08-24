# AI Chat

The **AI Chat** feature provides context-aware assistance powered by large language models. It understands your configuration, accesses Klipper documentation, and can propose edits.

---

## Setting Up AI Chat

### First-Time Configuration

![Figure 1: AI Chat settings](./figures/fig-1-settings.svg)

**Click "AI Chat"** in the toolbar, then click **Settings** (gear icon).

**Choose your provider** from the dropdown menu:

- **ChatGPT (OpenAI)** — cloud, requires an API key
- **Anthropic** — cloud, requires an API key
- **GitHub** — cloud (Copilot), requires an API key
- **Google** — cloud, requires an API key
- **OpenAI-compatible** — any OpenAI-compatible server (local or hosted); host/port required

### Provider Configuration

**For cloud providers:**
1. **Select a provider** from the dropdown menu.
2. **Enter your API key** (stored locally in the app's settings; never sent to KWC servers).
3. **Select a model** — type a model name or pick one offered by the provider.
4. **Click "Save"**.

**For the OpenAI-compatible provider:**
1. **Select "OpenAI-compatible"**
2. **Enter host/port** (e.g., `192.168.1.135:8080`)
3. **Enter API key** if required (many local servers do not need one)
4. **Click "Save"**

**Model selection:**
- Local/compatible servers expose their models via the `/v1/models` endpoint, which the settings panel can list

**Additional settings:**
- **Max tokens** — Maximum response length (default: 4096)
- **Temperature** — Creativity parameter, 0–2 (default: 0.7)
- **Tool protocol** — How the model uses tools (auto, native, or text)

---

## Using the Chat

### Basic Questions

**Ask about Klipper concepts:**
```
How do I set up a probe?
What is the difference between BED_MESH_CALIBRATE and QUAD_GANTRY_LEVEL?
How do I tune my PID?
```

**The AI will:**
- Search Klipper documentation via MCP tools
- Provide context from your config if attached
- Cite sources (e.g., "From Config_Reference.md:")

### Attaching Configuration Context

![Figure 2: Attaching config files](./figures/fig-2-attach-config.svg)

**To provide config context:**

1. **Click the Attach (paperclip) icon** in the input bar
2. **Select loaded files** (from your current project) to include
3. **Or attach local files** from your computer (`.cfg` / plain text)

**What gets sent:**
- Only **checked** files are included as context
- **Targeted sections** (if you mention them)
- **Section index** (if no specific section is named)

**Example:**
```
Can you help me tune my probe?
[Attached: printer.cfg, probe.cfg]
```

The AI reads your probe configuration and provides specific advice.

### Asking for Edits

**The AI can propose changes to your config:**

```
Add a G28 before my print_start macro
Increase my bed mesh points to 5x5
Create a new macro for homing all axes
```

**How it works:**
1. **AI analyzes** your current config
2. **Proposes edits** using mini-diff format
3. **You review** in the Draft Preview dialog
4. **Accept or reject** each change

**Mini-diff format:**
```
[stepper_x]
-rotation_distance: 39.5
+rotation_distance: 40
```

The header (without `#` prefix) identifies the section. Lines prefixed with `-` are removed, lines prefixed with `+` are added. This is standard unified diff format.

---

## The Draft Preview Workflow

![Figure 3: Draft preview dialog](./figures/fig-3-draft-preview.svg)

After the AI proposes changes:

### Step 1: Review Changes

**The preview shows the proposed diff:**
- **Green lines** — What will be added
- **Red lines** — What will be removed
- **Gray lines** — Context (unchanged)
- **Blue lines** — Hunk headers (`@@`)

**Per-section selection:**
- Each section of the proposal is an individual row with a checkbox
- **New files** are shown as section rows with a "New file" badge
- Use **Select all / Deselect all** to toggle the whole proposal

### Step 2: Accept or Reject

**Options:**
- **Accept Selected Sections** — Apply the checked sections (the button is disabled when nothing is selected)
- **Close** — Discard the proposal

**After accepting:**
- Accepted sections are applied to the editor immediately and staged for save
- Use **Diff** to review before saving
- Use **Save/Export** to persist
- If the AI's proposal needs work, reply in chat to ask for a revision — it can propose a new draft

---

## Persistent Context (Printer Memory)

### What is Printer Memory?

Printer Memory is a structured object that the AI can update to remember your printer's configuration:

```json
{
  "bed_mesh_profile": "default",
  "pid_bed_temp": 60,
  "pid_hotend_temp": 200,
  "homing_origin": "bed_mesh"
}
```

### How It Works

1. **Current memory** is sent as context
2. **AI can propose updates** in a `printer-memory` block
3. **You review** in the Printer Memory dialog
4. **On acceptance** — Memory is updated and persisted

**Example:**
```
User: What bed mesh profile am I using?
AI: Your current profile is "default" at 22°C.
    Should I create a new profile for higher temps?

[Printer Memory proposal appears]
```

### Managing Memory

**Open Memory Dialog:**
- Click the **memory icon** in the chat
- Or ask: "Show me my printer memory"

**Actions:**
- **View** current values
- **Edit** manually
- **Reset** to defaults
- **Clear** all memory

---

## How the AI Finds Information (MCP Tools)

The AI uses **MCP (Model Context Protocol)** — a standard for connecting AI to external data — to perform actions automatically when needed:

### Available Tools

| Tool | Purpose |
|------|---------|
| `search_klipper_docs` | Search the bundled Klipper documentation |
| `read_klipper_doc` | Read a specific Klipper doc |
| `list_klipper_docs` | List available Klipper docs |
| `list_config_reference_sections` | List sections in the config reference |
| `get_config_reference_section` | Read one config-reference section |
| `validate_klipper_config` | Validate a config (or section) |
| `search_example_configs` | Find bundled example configs |
| `read_example_config` | Read an example config file |
| `search_user_configs` | Search the files in the current project |
| `list_user_configs` | List the files in the current project |
| `list_user_config_sections` | List sections in a project file |
| `read_user_config` | Read sections from your config |
| `calculate_rotation_distance` | Compute stepper rotation distance |
| `generate_macro_template` | Generate a G-code macro template |
| `validate_macro` | Check G-code macro syntax and bounds |

### Tool Use in Chat

When the AI needs information, it uses tools silently:

```
User: How do I set up my Eddy probe?
AI: [Uses search_klipper_docs → searches for "Eddy"]
    Based on the documentation...
```

**You can see tool usage** in the chat footer:
- ✅ `search_klipper_docs` — Tool executed successfully
- ❌ `validate_macro` — Tool returned an error

---

## Conversation History

### Saving Conversations

Conversations are **saved automatically** — when you start a **New Chat** (or close the app), the current conversation is saved to history. You don't need to save manually.

### Loading Conversations

**Open History** (clock icon) in the AI Chat toolbar:
1. **Browse saved conversations** — each entry shows the title and a message summary
2. **Click a conversation** — loads it and resumes the chat with full context

### Deleting Conversations

**In the History dialog:**
- **Delete** — click the trash icon on a conversation; click again to confirm
- **Delete all** — the "Delete all saved conversations" button clears the entire history

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Enter` | Send message |
| `Shift+Enter` | New line in the composer |

These are the only keyboard shortcuts in AI Chat.

---

## Troubleshooting

### AI Does Not Respond

**Possible causes:**
- **Network issue** — Check your connection
- **API key invalid** — Re-enter in settings
- **Rate limit exceeded** — Wait and retry
- **Model unavailable** — Switch to a different model

**Solution:**
1. **Check the error banner** — connection and provider errors are shown in the chat
2. **Verify the API key / host** — AI Chat → Settings
3. **Try a different model** — Some models have higher latency

### AI Suggests Invalid Changes

**Problem:** The AI proposes edits that fail validation.

**Solution:**
1. **Review the draft** — See what was proposed
2. **Click "Validate"** — Identify specific errors
3. **Ask AI to revise** — "Fix the validation errors in your proposal"
4. **Provide more context** — Attach relevant files

**Common errors:**
- Missing required parameters
- Duplicate section names
- Invalid pin assignments

### Tool Calls Fail

**Problem:** The AI tries to use a tool but it fails.

**Possible causes:**
- Tool arguments are invalid
- Your config is incomplete
- The documentation file is missing

**Solution:**
1. **Check the error message** — Shown in chat footer
2. **Provide more context** — Attach the relevant file
3. **Ask AI to try a different approach** — "Can you answer without using tools?"

### Slow Responses

**Causes:**
- Cloud API latency
- Local model is small/slow
- Complex query requiring multiple tool calls

**Mitigation:**
- Simplify your query (ask smaller questions)
- For local models, try a larger model if resources allow

---

## Best Practices

### Effective Prompts

**Good prompts:**
- "Add a BED_MESH_CALIBRATE to my print_start macro"
- "Explain why my probe offset is wrong"
- "Create a macro that homes X and Y, then probes at 5 points"

**Bad prompts:**
- "Fix everything" (too vague)
- "Make my printer work" (not actionable)
- "Change the config" (no specifics)

### Context Management

**Attach only what you need:**
- ✅ "Here is my probe.cfg, how do I adjust the offset?"
- ❌ Attach whole project for a single-section question

**Pro Tip:** If the AI is hallucinating configuration values, try unchecking other files in "Include Files" to force it to focus only on the specific file you are editing.

**Reference specific files:**
- "In `printer.cfg`, what is wrong with my stepper_x?"
- "Look at `macros.cfg` and explain the PAUSE macro"

### Iterative Refinement

**When the AI gets it wrong:**
1. **Do not accept** the draft
2. **Point out the issue** — "You added G28 but I asked for G90"
3. **Provide a corrected example** — "Like this: [paste correct code]"
4. **Ask for revision** — "Please fix this"

---
