---
name: map-code
description: Build function dependency graph from extracted Lean code and Rust source
argument-hint: "[optional: path to project root]"
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
  - Write
  - Task
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
- This skill is invoked by mentioning `$fvs:map-code`.
- Treat all user text after `$fvs:map-code` as `{{FVS_ARGS}}`.
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
Analyze an Aeneas-generated Lean project to produce .formalising/CODEMAP.md.

Dispatches a two-phase subagent pipeline: fvs-researcher gathers context (read-only),
then fvs-executor writes the structured CODEMAP.md file.

Output: .formalising/CODEMAP.md with function inventory, dependency graph, and
recommended verification entry points.
</objective>

<execution_context>
@${CLAUDE_PLUGIN_ROOT}/fv-skills/workflows/map-code.md
@${CLAUDE_PLUGIN_ROOT}/fv-skills/references/ui-brand.md
</execution_context>

<context>
Project path: $ARGUMENTS (optional -- defaults to current working directory)

Check for existing .formalising/ directory:
- If found, ask user: "Existing .formalising/ found. Refresh CODEMAP.md? (y/n)"
- If not found, will be created in step 2

This command can run anytime to refresh the codebase map.
</context>

<process>

## Step 1: Detect project

Check for an Aeneas project. Look for config first, then auto-detect:

```bash
# Check for FVS config override
cat .formalising/fvs-config.json 2>/dev/null

# Auto-detect via marker files
[ -f lakefile.toml ] && [ -f lean-toolchain ] && echo "Lean project detected"
```

If neither fvs-config.json nor marker files found:
```
No fvs-config.json or lakefile.toml found.

Is this an Aeneas-generated Lean project?
- Point me to the project root, or
- Create fvs-config.json manually
```
Wait for user response.

Extract key paths (from config or by searching):

```bash
# Find Funs.lean (exclude .lake build cache)
FUNS_LEAN=$(find . -name "Funs.lean" -not -path "*/.lake/*" 2>/dev/null | head -1)
TYPES_LEAN=$(find . -name "Types.lean" -not -path "*/.lake/*" 2>/dev/null | head -1)
SPECS_DIR=$(find . -type d -name "Specs" -not -path "*/.lake/*" 2>/dev/null | head -1)
LEAN_TOOLCHAIN=$(cat lean-toolchain 2>/dev/null)
RUST_SRC=$(find . -name "Cargo.toml" -not -path "*/.lake/*" 2>/dev/null | head -1 | xargs dirname 2>/dev/null)
```

If fvs-config.json exists, use its paths as overrides.

Confirm all paths with user before proceeding:
```
Detected project paths:
  Funs.lean:  {FUNS_LEAN}
  Types.lean: {TYPES_LEAN}
  Specs/:     {SPECS_DIR}
  Toolchain:  {LEAN_TOOLCHAIN}
  Rust source: {RUST_SRC or "not found"}

Correct? (y/n)
```

## Step 2: Create .formalising/ directory

```bash
mkdir -p .formalising/fv-plans
```

If .formalising/ already exists, ask user whether to refresh CODEMAP.md or abort.

## Step 3: Read config and resolve models

Read the project config to determine which models to use for subagent dispatch:

```bash
CONFIG=$(cat .formalising/fvs-config.json 2>/dev/null)
```

If config exists, extract `model_profile` and `model_overrides`.
If config is missing, use defaults: `model_profile = "quality"`, no overrides.

**Resolve models from profile table** (see fv-skills/references/model-profiles.md):

For `fvs-researcher`:
- Check `model_overrides["fvs-researcher"]` first
- Otherwise use profile table: quality=inherit, balanced=sonnet, budget=haiku

For `fvs-executor`:
- Check `model_overrides["fvs-executor"]` first
- Otherwise use profile table: quality=inherit, balanced=sonnet, budget=sonnet

Store resolved models as `$RESEARCH_MODEL` and `$EXECUTOR_MODEL`.

## Step 4: Read reference files for inlining

Read ALL reference files that the subagents need. These MUST be inlined into Task()
prompts because @-references do NOT cross Task() boundaries.

```bash
AENEAS_PATTERNS=$(cat ${CLAUDE_PLUGIN_ROOT}/fv-skills/references/aeneas-patterns.md)
SPEC_CONVENTIONS=$(cat ${CLAUDE_PLUGIN_ROOT}/fv-skills/references/lean-spec-conventions.md)
```

## Step 5: Dispatch fvs-researcher (read-only scan)

Display dispatch indicator:
```
>> Dispatching fvs-researcher (map-code)...
```

Spawn the research subagent to scan the project and gather context:

```
Task(
  subagent_type="fvs-researcher",
  model="$RESEARCH_MODEL",
  description="Map codebase dependencies",
  prompt="Research mode: map-code

<project_root>$PROJECT_ROOT</project_root>
<funs_lean_path>$FUNS_LEAN</funs_lean_path>
<types_lean_path>$TYPES_LEAN</types_lean_path>
<rust_source_root>$RUST_SRC</rust_source_root>

<aeneas_patterns>
$AENEAS_PATTERNS
</aeneas_patterns>

<spec_conventions>
$SPEC_CONVENTIONS
</spec_conventions>

Tasks:
1. Read Funs.lean -- extract ALL function definitions (name, signature, body)
2. Build dependency graph (which functions call which)
3. Map Lean names back to Rust source files + line numbers
4. Identify leaf functions (no outgoing calls = verification entry points)
5. Read Types.lean for type inventory
6. Scan existing Specs/ for sorry status

Return with ## RESEARCH COMPLETE"
)
```

For large projects, the research subagent may fan out parallel sub-tasks using
`run_in_background=true` for scanning multiple source directories simultaneously.

Wait for agent to return. Parse the result:
- If `## RESEARCH COMPLETE`: extract findings for executor
- If `## ERROR`: display error, offer user to retry or abort

Display:
```
[OK] fvs-researcher complete: {N} functions found, {M} types catalogued
```

## Step 6: Dispatch fvs-executor (write CODEMAP.md)

Display dispatch indicator:
```
>> Dispatching fvs-executor (map-code)...
```

Spawn the executor subagent with research findings:

```
Task(
  subagent_type="fvs-executor",
  model="$EXECUTOR_MODEL",
  description="Write CODEMAP.md",
  prompt="Execute mode: map-code

<research_findings>
$RESEARCH_SUBAGENT_OUTPUT
</research_findings>

Write .formalising/CODEMAP.md with:
- Project info (toolchain, function count, leaf count)
- Function inventory table (Lean name, Rust name, source file, line, deps, leaf, status)
- Dependency graph (caller -> callee adjacency list)
- Verification entry points (leaf functions sorted by estimated complexity)
- Type inventory
- Existing specs with sorry counts

Status symbols:
- [OK] verified (spec exists, zero sorry)
- [??] in progress (spec exists, has sorry)
- [--] no spec exists

Use the Write tool (VS Code diff). User will approve the diff.
Return with ## EXECUTION COMPLETE"
)
```

Wait for executor to return. Parse the result:
- If `## EXECUTION COMPLETE`: confirm CODEMAP.md written
- If `## ERROR`: display error, offer user to retry or abort

Display:
```
[OK] fvs-executor complete: CODEMAP.md written
```

## Step 7: Display summary with FVS >> banner

```
FVS >> MAP COMPLETE

Project: [name from directory or config]
Functions: [N] total, [M] leaf functions
Existing specs: [K] files ([J] with sorry remaining)
Recommended starting points: [top 5 leaf functions]

Written: .formalising/CODEMAP.md
```

## Step 8: Suggest next command

```
>> Next Up

/fvs:fc-plan to select verification targets
```

</process>

<success_criteria>
- [ ] Project detected via lakefile.toml + lean-toolchain (or fvs-config.json)
- [ ] .formalising/ directory created
- [ ] Model profile resolved from .formalising/fvs-config.json (or quality default)
- [ ] fvs-researcher dispatched with inlined references, returns function inventory
- [ ] fvs-executor dispatched with research findings, writes CODEMAP.md
- [ ] CODEMAP.md written to .formalising/ via VS Code diff
- [ ] Summary displayed with recommended next steps
</success_criteria>
