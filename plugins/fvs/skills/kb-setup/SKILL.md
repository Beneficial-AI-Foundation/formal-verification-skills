---
name: kb-setup
description: Set up NotebookLM knowledge base integration (venv, auth, config)
argument-hint: "[--add] (add another KB to existing config)"
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
  - Write
---

<plugin_runtime>
- FVS is installed at `${CLAUDE_PLUGIN_ROOT}`; hosts expand this placeholder in plugin skill content.
- Resolve every bundled workflow, reference, template, script, and agent beneath that root.
- When executing a shell snippet, quote the resolved plugin-root path even if an inherited example omits quotes.
- Never write state into the plugin cache. Project state belongs under the user's current project (normally `.formalising/`).
</plugin_runtime>

<codex_skill_adapter>
This block applies only when this shared skill runs in Codex. Claude Code must ignore it and use the
shared workflow body with its native slash-command, question, and subagent semantics.

## A. Skill Invocation
- This skill is invoked by mentioning `$fvs:kb-setup`.
- Treat all user text after `$fvs:kb-setup` as `{{FVS_ARGS}}`.
- If no arguments are present, treat `{{FVS_ARGS}}` as empty.

## B. AskUserQuestion -> request_user_input Mapping
FVS workflows use `AskUserQuestion` (Claude Code syntax). Translate to Codex `request_user_input`:

Parameter mapping:
- `header` -> `header`
- `question` -> `question`
- Options formatted as `"Label" -- description` -> `{label: "Label", description: "description"}`
- Generate `id` from header: lowercase, replace spaces with underscores

Batched calls:
- `AskUserQuestion([q1, q2])` -> single `request_user_input` with multiple entries in `questions[]`

Multi-select workaround:
- Codex has no `multiSelect`. When a question allows multiple selections, do NOT collapse it to a single choice. Use sequential single-selects, or present a numbered freeform list asking the user to enter comma-separated numbers, then collect every selection before proceeding.

Execute mode fallback:
- When `request_user_input` is rejected or unavailable (Execute mode), present every `AskUserQuestion` call as a plain-text numbered list, then stop and wait for the user's reply. Do NOT pick a default and continue.
- You may proceed without a user answer only when one of these is true:
  (a) the invocation included an explicit non-interactive flag (`--auto` or `--all`),
  (b) the user has explicitly approved a specific default for this question, or
  (c) the workflow's documented contract says defaults are safe (e.g. autonomous lifecycle paths).
- Do NOT write workflow artifacts (handoff files, spec files, plan files, checkpoint files) until the user has answered the plain-text questions or one of (a)-(c) above applies. Surfacing the questions and waiting is the correct response — silently defaulting and writing artifacts is the failure mode this header exists to prevent.

## C. Task() -> spawn_agent Mapping
FVS workflows use `Task(...)` (Claude Code syntax). Translate to Codex collaboration tools:

**Schema detection (required first step):** Codex exposes two `spawn_agent` schemas:
- **agent_type-capable schema:** `spawn_agent` accepts `agent_type`, `message`, `reasoning_effort`, `fork_context`, etc. — typed FVS agent dispatch is available.
- **Generic schema:** `spawn_agent` accepts only `message`, `items`, `fork_context` — there is **no `agent_type` field**. Typed FVS agent dispatch is unavailable in this session.

Before spawning, inspect the `spawn_agent` tool's visible parameter schema to determine which form is active.
Even when `agent_type` is present, typed dispatch is available only if the exact requested FVS type is advertised by the tool schema or a confirmed runtime registry. Codex marketplace plugins do not register the bundled Claude agent Markdown as typed Codex agents, so otherwise use the bundled-agent workaround below.


Typed mapping (agent_type-capable schema only):
- `Task(subagent_type="X", prompt="Y")` -> `spawn_agent(agent_type="X", message="Y")`
- `Task(model="...")` -> omit. `spawn_agent` has no inline `model` parameter. The marketplace plugin does not install Codex agent TOML. Use this mapping only when the exact FVS agent type is registered independently; otherwise use the bundled-agent workaround.
- `fork_context: false` by default -- FVS agents load their own context via `<files_to_read>` blocks.

Generic-agent workaround (schema with NO agent_type field):
When only the generic schema is available, typed FVS agent dispatch (`fvs-researcher`, `fvs-executor`, etc.) is NOT possible. This workaround is NOT equivalent to typed execution — FVS agents carry verification-aware prompts and sandbox settings a generic subagent lacks. Fallback:
1. Read `${CLAUDE_PLUGIN_ROOT}/agents/<agent-name>.md` and extract its instructions. If the token is still literal, resolve the path from this SKILL.md as described above.
2. Spawn a generic/default agent and inject those instructions as a role preamble before the task prompt.
3. Label results clearly as "generic-agent workaround" so the user knows typed guarantees are not in effect.
4. Where typed dispatch is mandatory for correctness, fail closed and report the schema limitation rather than silently degrading.

Parallel fan-out:
- Spawn multiple agents -> collect agent IDs -> call `wait_agent(timeout_ms=...)` (or the runtime's visible wait equivalent) until each completes

Result parsing:
- Look for structured markers in agent output: `CHECKPOINT`, `PLAN COMPLETE`, `SUMMARY`, etc.
- If the runtime exposes an agent cleanup or close tool, use it after collecting each result

## D. Shared Plugin Syntax
- This file is shared with Claude Code. On Codex, interpret `/fvs:<name>` references as `$fvs:<name>`.
- Treat `$ARGUMENTS` in the shared body as `{{FVS_ARGS}}`.
- `${CLAUDE_PLUGIN_ROOT}` is the installed plugin root. If a host leaves that token unexpanded, resolve the plugin root as two directories above this SKILL.md.

</codex_skill_adapter>

<objective>
Walk the user through setting up NotebookLM knowledge base integration for FVS. Creates a Python venv with notebooklm-py, authenticates via browser login, and registers a knowledge base in fvs-config.json.

With `--add` flag, skips venv creation and goes straight to KB registration (for adding additional KBs to an existing setup).

Output: Working KB query tool at `.formalising/.kb-venv/` and a registered knowledge base entry in `.formalising/fvs-config.json`.
</objective>

<execution_context>
@${CLAUDE_PLUGIN_ROOT}/fv-skills/references/ui-brand.md
</execution_context>

<context>
Arguments: $ARGUMENTS (optional --add flag).

- The KB query tool lives at ${CLAUDE_PLUGIN_ROOT}/scripts/fvs-kb-query.py (installed by FVS installer)
- The venv is per-project at .formalising/.kb-venv/ (not global)
- notebooklm-py requires Python >= 3.10; uv can install Python 3.12 automatically
- Authentication uses browser-based login via playwright/chromium
- Knowledge bases are stored in fvs-config.json knowledge_bases array
</context>

<process>

## Step 1: Parse Arguments and Check Prerequisites

Parse $ARGUMENTS for the --add flag:

```bash
ADD_MODE=false
if echo "$ARGUMENTS" | grep -q "\-\-add"; then
  ADD_MODE=true
fi
```

Check prerequisites:

```bash
# Check uv is installed
command -v uv && echo "UV_OK" || echo "UV_MISSING"

# Check .formalising/ directory exists
[ -d ".formalising" ] && echo "FORMALISING_OK" || echo "FORMALISING_MISSING"
```

If `.formalising/` does not exist, create it:

```bash
mkdir -p .formalising
```

If `uv` is not found, display:

```
FVS >> KB SETUP

[!!] uv is required but not installed.

Install uv:
  curl -LsSf https://astral.sh/uv/install.sh | sh

Then re-run /fvs:kb-setup
```

Stop execution if uv is missing.

Check if the fvs-kb-query.py script is available:

```bash
[ -f "${CLAUDE_PLUGIN_ROOT}/scripts/fvs-kb-query.py" ] && echo "SCRIPT_OK" || echo "SCRIPT_MISSING"
```

If script is missing, warn but continue (it may be at a different install location).

If ADD_MODE is true and venv exists, skip to Step 4.
If ADD_MODE is true and venv does NOT exist, warn and proceed from Step 2.

## Step 2: Create Python Venv

```
FVS >> KB SETUP

Creating Python 3.12 virtual environment...
```

```bash
uv venv .formalising/.kb-venv --python 3.12
```

Verify venv was created:

```bash
[ -d ".formalising/.kb-venv" ] && echo "VENV_OK" || echo "VENV_FAILED"
```

If venv creation fails (e.g., Python 3.12 not available):

```
[!!] Failed to create venv with Python 3.12.
     uv will attempt to download Python 3.12 automatically.
     If this fails, install Python 3.12 manually and re-run /fvs:kb-setup.
```

## Step 3: Install Dependencies and Authenticate

Install notebooklm-py with browser extra:

```bash
uv pip install "notebooklm-py[browser]" --python .formalising/.kb-venv/bin/python
```

Install playwright chromium (required for browser-based auth):

```bash
.formalising/.kb-venv/bin/playwright install chromium
```

Prompt the user before initiating login:

```
FVS >> KB SETUP

Dependencies installed. Next: browser authentication.

A browser window will open for Google login.
Sign in to your Google account that has NotebookLM access.
```

Use AskUserQuestion: "Ready to open browser for NotebookLM login? (yes/no)"

If yes, run the interactive login:

```bash
.formalising/.kb-venv/bin/notebooklm login
```

This step is interactive -- the user authenticates in the browser window. Wait for the command to complete.

Verify authentication succeeded with a health check:

```bash
.formalising/.kb-venv/bin/python ${CLAUDE_PLUGIN_ROOT}/scripts/fvs-kb-query.py health
```

Parse the JSON output. If `status` is `"ok"`: continue. If `status` is `"error"`:

```
[!!] Authentication check failed: {message}
     Try running login again: .formalising/.kb-venv/bin/notebooklm login
```

Use AskUserQuestion: "Retry login? (yes/no)"

If yes, re-run the login command. If no, stop and report partial setup.

## Step 4: Register Knowledge Base

```
FVS >> KB SETUP -- Register Knowledge Base
```

Use AskUserQuestion to collect KB details interactively:

**Prompt 1: Notebook ID**

```
Enter notebook ID or NotebookLM URL:
(e.g., e6eb8caf-a845-4ec7-bf1c-d254e9625ad8
 or https://notebooklm.google.com/notebook/e6eb8caf-a845-4ec7-bf1c-d254e9625ad8)
```

If user provides a URL, extract the notebook ID from it:

```bash
# Extract UUID from URL if provided
echo "$USER_INPUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
```

Store as NOTEBOOK_ID. If extraction fails:

```
[!!] Could not parse notebook ID from input.
     Expected a UUID like: e6eb8caf-a845-4ec7-bf1c-d254e9625ad8
```

Ask again.

**Prompt 2: Name**

```
Name for this knowledge base?
(e.g., "Signal Protocol Papers", "Curve25519 References")
```

Store as KB_NAME.

**Prompt 3: Domain Tag**

```
Domain tag?
(e.g., "cryptographic-protocols", "elliptic-curves", "formal-methods")
```

Store as KB_DOMAIN.

**Prompt 4: Description**

```
What does this KB contain?
(e.g., "Papers on CKA, SPQR, double ratchet, and Signal X3DH")
```

Store as KB_DESCRIPTION.

**Prompt 5: Use When**

```
When should agents use this KB?
(e.g., "Formalising Signal protocol components or key agreement constructions")
```

Store as KB_USE_WHEN.

## Step 5: Update fvs-config.json

Read existing config or create from template:

```bash
cat .formalising/fvs-config.json 2>/dev/null || echo "MISSING"
```

If config is missing, copy from template:

```bash
cp ${CLAUDE_PLUGIN_ROOT}/fv-skills/templates/config.json .formalising/fvs-config.json
```

Read the current config, add the new KB entry to the `knowledge_bases` array:

```json
{
  "id": "<NOTEBOOK_ID>",
  "name": "<KB_NAME>",
  "domain": "<KB_DOMAIN>",
  "description": "<KB_DESCRIPTION>",
  "use_when": "<KB_USE_WHEN>"
}
```

Write the updated config using the Write tool. Preserve all existing keys (project, model, behavior) and any existing knowledge_bases entries.

If the `knowledge_bases` key does not exist in the config, add it as a new top-level array.

## Step 6: Verify Setup

Run the health check:

```bash
.formalising/.kb-venv/bin/python ${CLAUDE_PLUGIN_ROOT}/scripts/fvs-kb-query.py health
```

Run a test query to confirm the notebook is accessible:

```bash
.formalising/.kb-venv/bin/python ${CLAUDE_PLUGIN_ROOT}/scripts/fvs-kb-query.py ask "test" --notebook "$NOTEBOOK_ID" --text
```

If test query succeeds, display the success summary:

```
FVS >> KB SETUP COMPLETE

Venv:     .formalising/.kb-venv/
Library:  notebooklm-py
Auth:     [OK] Authenticated
KB:       {KB_NAME} ({KB_DOMAIN})

Ready to use with /fvs:lean-formalise or any agent.
```

If test query fails with an error, display the error but still report setup as partially complete:

```
FVS >> KB SETUP PARTIAL

Venv:     [OK] .formalising/.kb-venv/
Library:  [OK] notebooklm-py installed
Auth:     [OK] Authenticated
KB:       [!!] Test query failed: {error}

The notebook ID may be incorrect. Check the ID and try:
  /fvs:kb-setup --add
```

</process>

<success_criteria>
- [ ] uv availability checked; clear install instructions if missing
- [ ] Python 3.12 venv created at .formalising/.kb-venv/
- [ ] notebooklm-py[browser] installed in venv
- [ ] Playwright chromium installed for auth
- [ ] Browser-based notebooklm login completed
- [ ] Health check passed (authenticated and connected)
- [ ] KB details collected interactively (id, name, domain, description, use_when)
- [ ] fvs-config.json updated with new knowledge_bases entry
- [ ] Test query against registered notebook succeeded
- [ ] --add flag skips venv creation, goes straight to KB registration
- [ ] Graceful error handling for missing uv, failed login, invalid notebook ID
</success_criteria>
