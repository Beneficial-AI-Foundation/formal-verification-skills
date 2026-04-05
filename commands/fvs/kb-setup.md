---
name: fvs:kb-setup
description: Set up NotebookLM knowledge base integration (venv, auth, config)
argument-hint: "[--add] (add another KB to existing config)"
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
  - Write
---

<objective>
Walk the user through setting up NotebookLM knowledge base integration for FVS. Creates a Python venv with notebooklm-py, authenticates via browser login, and registers a knowledge base in fvs-config.json.

With `--add` flag, skips venv creation and goes straight to KB registration (for adding additional KBs to an existing setup).

Output: Working KB query tool at `.formalising/.kb-venv/` and a registered knowledge base entry in `.formalising/fvs-config.json`.
</objective>

<execution_context>
@~/.claude/fv-skills/references/ui-brand.md
</execution_context>

<context>
Arguments: $ARGUMENTS (optional --add flag).

- The KB query tool lives at ~/.claude/scripts/fvs-kb-query.py (installed by FVS installer)
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
[ -f "$HOME/.claude/scripts/fvs-kb-query.py" ] && echo "SCRIPT_OK" || echo "SCRIPT_MISSING"
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
.formalising/.kb-venv/bin/python ~/.claude/scripts/fvs-kb-query.py health
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
cp ~/.claude/fv-skills/templates/config.json .formalising/fvs-config.json
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
.formalising/.kb-venv/bin/python ~/.claude/scripts/fvs-kb-query.py health
```

Run a test query to confirm the notebook is accessible:

```bash
.formalising/.kb-venv/bin/python ~/.claude/scripts/fvs-kb-query.py ask "test" --notebook "$NOTEBOOK_ID" --text
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
