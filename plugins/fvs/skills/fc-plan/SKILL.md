---
name: fc-plan
description: Pick next verification targets via dependency graph analysis
argument-hint: "[optional: function name to plan for specifically]"
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
- This skill is invoked by mentioning `$fvs:fc-plan`.
- Treat all user text after `$fvs:fc-plan` as `{{FVS_ARGS}}`.
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
Analyze the dependency graph from CODEMAP.md to determine optimal bottom-up
verification order. Dispatches a two-phase subagent pipeline: fvs-researcher
gathers verification state and analyzes targets (read-only), then fvs-executor
writes the prioritized PLAN.md file.

Output: .formalising/PLAN.md with prioritized verification targets, and
user-selected target ready for /fvs:lean-specify.
</objective>

<execution_context>
@${CLAUDE_PLUGIN_ROOT}/fv-skills/workflows/fc-plan.md
@${CLAUDE_PLUGIN_ROOT}/fv-skills/references/ui-brand.md
</execution_context>

<context>
Target function: $ARGUMENTS (optional -- if provided, plan for that specific function instead of full ranking)

Check for .formalising/CODEMAP.md:
- If missing, suggest /fvs:map-code first
- If found, parse function inventory and dependency graph

Check for existing .formalising/fv-plans/ docs from prior sessions.
</context>

<process>

## Step 1: Check prerequisites

```bash
[ -f .formalising/CODEMAP.md ] && echo "CODEMAP found" || echo "CODEMAP missing"
```

If missing:
```
CODEMAP.md not found. Run /fvs:map-code first to analyze the project.

Alternatively, specify a function directly:
  /fvs:lean-specify function_name
```
Warn but allow user to proceed manually if they choose.

If found: read and parse the function inventory and dependency graph sections.

If $ARGUMENTS is provided (specific function name): check whether that function
exists in CODEMAP.md. If not found, warn: "Function {name} not found in CODEMAP.
Available functions: ..." and let user correct.

## Step 2: Read config and resolve models

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

## Step 3: Read reference files for inlining

Read ALL reference files that the subagents need. These MUST be inlined into Task()
prompts because @-references do NOT cross Task() boundaries.

```bash
AENEAS_PATTERNS=$(cat ${CLAUDE_PLUGIN_ROOT}/fv-skills/references/aeneas-patterns.md)
SPEC_CONVENTIONS=$(cat ${CLAUDE_PLUGIN_ROOT}/fv-skills/references/lean-spec-conventions.md)
PROOF_STRATEGIES=$(cat ${CLAUDE_PLUGIN_ROOT}/fv-skills/references/proof-strategies.md)
```

Also read the CODEMAP.md content for inlining:
```bash
CODEMAP_CONTENT=$(cat .formalising/CODEMAP.md)
```

And scan for existing spec files:
```bash
EXISTING_SPECS=$(find Specs/ -name "*.lean" 2>/dev/null | sort)
```

## Step 4: Dispatch fvs-researcher (read-only analysis)

Display dispatch indicator:
```
>> Dispatching fvs-researcher (plan)...
```

Spawn the research subagent to analyze verification state and identify targets:

```
Task(
  subagent_type="fvs-researcher",
  model="$RESEARCH_MODEL",
  description="Research verification targets",
  prompt="Research mode: plan

<codemap>
$CODEMAP_CONTENT
</codemap>

<existing_specs>
$EXISTING_SPECS
</existing_specs>

<aeneas_patterns>
$AENEAS_PATTERNS
</aeneas_patterns>

<spec_conventions>
$SPEC_CONVENTIONS
</spec_conventions>

<proof_strategies>
$PROOF_STRATEGIES
</proof_strategies>

Tasks:
1. Read CODEMAP.md dependency graph
2. Identify unverified functions (no spec file yet, or spec with sorry)
3. For each candidate, read Rust source to assess complexity and pre/post conditions
4. Analyze dependency order (bottom-up: verify leaves first)
5. Check for existing stubs in .formalising/stubs/ (functions with stubs are easier to specify)
6. Evaluate top candidates for complexity (1-5), leverage (1-5), risk (1-5)

Return with ## RESEARCH COMPLETE"
)
```

Wait for agent to return. Parse the result:
- If `## RESEARCH COMPLETE`: extract findings for executor
- If `## ERROR`: display error, offer user to retry or abort

Display:
```
[OK] fvs-researcher complete: {N} ready, {M} blocked
```

If $ARGUMENTS was provided (specific function): check whether the target is in
the "ready now" set. If blocked, show which dependencies need verification first.

## Step 5: Dispatch fvs-executor (write PLAN.md)

Display dispatch indicator:
```
>> Dispatching fvs-executor (plan)...
```

Spawn the executor subagent with research findings:

```
Task(
  subagent_type="fvs-executor",
  model="$EXECUTOR_MODEL",
  description="Write verification plan",
  prompt="Execute mode: plan

<research_findings>
$RESEARCH_SUBAGENT_OUTPUT
</research_findings>

Write .formalising/PLAN.md with:
- Verification progress summary (verified / in-progress / unspecified counts)
- Prioritized verification target list (bottom-up by dependency depth)
- For each target: function name, complexity assessment, pre/post conditions, estimated difficulty
- Recommended verification order
- Functions with existing stubs marked as ready for /fvs:lean-specify
- Blocked functions with their dependency blockers listed

Use the Write tool (VS Code diff). User will approve the diff.
Return with ## EXECUTION COMPLETE"
)
```

Wait for executor to return. Parse the result:
- If `## EXECUTION COMPLETE`: confirm PLAN.md written
- If `## ERROR`: display error, offer user to retry or abort

Display:
```
[OK] fvs-executor complete: PLAN.md written
```

## Step 6: Present prioritized plan to user

Display the ranked results with the FVS >> banner:

```
FVS >> PLAN COMPLETE

Status: [V] [OK] / [P] [??] / [U] [--] of [T] total

Ready to verify (dependencies satisfied):

  #  Function                  Complexity  Leverage  Risk
  1. scalar_mul_inner          Low         High      Low
  2. point_validate            Low         Medium    Low
  3. field_add                 Low         Low       Low
  4. batch_normalize           Medium      High      Medium
  ...

Blocked (need dependency specs first):
  [!!] multi_scalar_mul (needs: scalar_mul_inner, point_add)
  [!!] verify_signature (needs: hash_to_curve, scalar_mul)

Written: .formalising/PLAN.md

---

Select a target number, or type a function name directly.
```

Wait for user selection.

If $ARGUMENTS was provided and the function is ready: skip interactive selection,
display the evaluation directly and confirm with user.

## Step 7: Write planning doc for selected target (optional)

After user selects a target, offer to write a planning document:

```
Write planning doc to .formalising/fv-plans/{function_name}.md? (y/n)
```

If yes, assemble a planning doc with:
- Function name, Lean qualified name, Rust source path
- Dependencies and their verification status
- Recommended approach (from researcher evaluation)
- Complexity/leverage/risk assessment
- Known precondition/postcondition candidates (if available from evaluation)

Write via VS Code diff (Write tool).

## Step 8: Suggest next command

```
Target selected: {function_name}

>> Next Up

/fvs:lean-specify {function_name}
```

</process>

<success_criteria>
- [ ] CODEMAP.md loaded and parsed (or user warned if missing)
- [ ] Model profile resolved from .formalising/fvs-config.json (or quality default)
- [ ] fvs-researcher dispatched with inlined references, returns verification analysis
- [ ] fvs-executor dispatched with research findings, writes .formalising/PLAN.md
- [ ] Prioritized list presented with selection interface
- [ ] User selects target, next command suggested
</success_criteria>
