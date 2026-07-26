---
name: fvs:crypto-execute
description: Run the current iteration's bounded executor plan under a green-build guard and a bounded loop
argument-hint: "<topic> nN [--model <value>] [--effort <value>]"
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
  - Task
  - AskUserQuestion
---

<objective>
Run the current iteration's bounded executor plan (`EXEC_PLAN_nN.md` or `FOLLOWUP_PLAN_nN.md`). The
dedicated `fvs-crypto-executor` implements the fully-specified plan under the green-build guard; this
command body owns dispatch and the build status check, and routes the executor's ESCALATE/BLOCKED
return to the user.

This command is the EXECUTE stage of the single-runtime loop (plan -> execute -> eval -> followup).
The plan it runs is RUNTIME-NEUTRAL: the loop runs as a `(R1; R1)` same-runtime pair by default, with
an optional secondary runtime available for the planning/eval stages in a later wave. When the
executor hits a public-statement change or cannot proceed, it hands back ESCALATE/BLOCKED and the
command routes that to the user -- never a long unattended grind.

Output: the executed proof changes on the working branch, with `build.log` captured for the eval.
</objective>

<execution_context>
@~/.claude/fv-skills/workflows/crypto-execute.md
@~/.claude/fv-skills/references/model-profiles.md
@~/.claude/fv-skills/references/ui-brand.md
</execution_context>

<context>
Topic + iteration: $ARGUMENTS (required -- `<topic> nN`). The loop reads the bounded plan for that
iteration from `plans/` and runs it. The loop is restartable from its on-disk records.
</context>

<process>

## Step 1: Resolve the topic slug + paths (path safety)

Resolve the topic into a slug (whitespace -> `-`, capitalization preserved, e.g.
`CKA from KEM` -> `CKA-from-KEM`). Treat the topic + iteration arg AND the new `--model` / `--effort`
flag values as UNTRUSTED: REJECT a slug with shell metacharacters, QUOTE every path expansion, NEVER
`eval` a path. The `--model` / `--effort` values are opaque, runtime-valid strings -- do NOT validate
them against any model taxonomy; reject only shell metacharacters (the same path-safety check).

```bash
TOPIC_RAW=""; ITER=""; EXEC_MODEL=""; EXEC_EFFORT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --model )  EXEC_MODEL="$2";  shift 2 ;;
    --effort ) EXEC_EFFORT="$2"; shift 2 ;;
    * ) if [ -z "$TOPIC_RAW" ]; then TOPIC_RAW="$1"; elif [ -z "$ITER" ]; then ITER="$1"; fi; shift ;;
  esac
done
case "$TOPIC_RAW" in
  *..*|*/* ) echo "FVS >> ERROR: topic contains '..' or '/' (path traversal); refusing" >&2; exit 1 ;;
  *[![:alnum:]_[:space:]-]* ) echo "FVS >> ERROR: topic contains unsupported characters" >&2; exit 1 ;;
esac
case "$ITER" in
  n[0-9]* ) : ;;
  * ) echo "FVS >> ERROR: iteration must be of the form nN" >&2; exit 1 ;;
esac
for FLAGVAL in "$EXEC_MODEL" "$EXEC_EFFORT"; do
  case "$FLAGVAL" in
    *[![:alnum:]_.:/+-]* ) echo "FVS >> ERROR: --model/--effort contains unsupported characters" >&2; exit 1 ;;
  esac
done
SLUG=$(printf '%s' "$TOPIC_RAW" | tr -s '[:space:]' '-')
ROOT=".formalising/fv-plans/$SLUG"
```

Confine ALL writes per the plan; never write a generated Lean file (`Types.lean` / `Funs.lean`).

## Step 2: Read the bounded plan

Read the bounded executor plan for this iteration -- `plans/EXEC_PLAN_nN.md`, or
`plans/FOLLOWUP_PLAN_nN.md` if a follow-up plan exists for the iteration. This plan is the only input
the executor needs (it is runtime-neutral and bounded -- branch/state, exact targets, immutable public
statements, allowed-`sorry` policy, stop conditions, verification command).

## Step 3: Resolve the executor model + effort + dispatch

Resolve `$EXECUTOR_MODEL` and `$EXECUTOR_EFFORT` for `fvs-crypto-executor` AT DISPATCH TIME -- never
pinned in the agent frontmatter. The resolved values are opaque, runtime-valid strings passed
STRAIGHT THROUGH to `Task(model=...)`; FVS keeps NO cross-provider model/effort taxonomy (an invalid
value is rejected by the runtime itself). Resolve with this ladder:

1. The per-run `--model` / `--effort` flags from Step 1, if present.
2. Else a top-level override in `.formalising/fvs-config.json`:
   `model_overrides["fvs-crypto-executor"]`. Read it at the TOP-LEVEL `model_overrides` key the
   model-profiles resolver actually consults -- NOT the template's nested `model.model_profile` (a
   pre-existing shape mismatch, out of scope here; do not depend on the nested key).
3. Else, in an interactive run, ASK via `AskUserQuestion` which model + effort to use for the
   execution subagent, offering "inherit / default" as a choice.
4. Else default `inherit` (works zero-config on every runtime).

```bash
CONFIG=$(cat .formalising/fvs-config.json 2>/dev/null || echo '{}')
# 1. flag  ->  2. top-level model_overrides["fvs-crypto-executor"]  ->  4. inherit
#    (3. AskUserQuestion runs between 2 and 4 in an interactive run)
EXECUTOR_MODEL="${EXEC_MODEL:-$(printf '%s' "$CONFIG" | OVERRIDE_KEY='model_overrides["fvs-crypto-executor"]' read_top_level_override)}"
EXECUTOR_MODEL="${EXECUTOR_MODEL:-inherit}"
EXECUTOR_EFFORT="${EXEC_EFFORT:-inherit}"
```

On Codex the `model=` parameter is silently ignored and per-agent effort is FIXED at install time
(from `FVS_CODEX_AGENT_EFFORT`), so the per-run `--effort` flag is a Claude / OpenCode / Gemini
nicety; Codex users tune the crypto executor's effort via the agent `.toml` / reinstall.

`cat` the bounded plan and INLINE it into the prompt (references do not cross the Task boundary):

```
Task(
  subagent_type="fvs-crypto-executor",
  model="$EXECUTOR_MODEL",
  description="Run bounded plan",
  prompt="Execute the bounded crypto plan.

<bounded_plan>...the inlined EXEC_PLAN_nN.md / FOLLOWUP_PLAN_nN.md...</bounded_plan>

Implement the fully-specified plan; self-fix at the green build; ESCALATE for any public-statement
change and hand back BLOCKED if you cannot proceed. Return with ## IMPLEMENTATION COMPLETE"
)
```

## Step 4: Verify under the green-build guard

Run the verification build and read the TOOL's real exit status -- never the tail of a pipe (a pipe
reports the filter's status `0`, masking a real failure). Always build under `nice -n 19 lake build`:

```bash
set -o pipefail
nice -n 19 lake build 2>&1 | tee "$ROOT/build.log"
test ${PIPESTATUS[0]} -eq 0 || echo "FVS >> build red -- a proof did not close"
```

`lake build` is the STYLE authority: `lake env lean` / `--stdin` isolation does NOT run the package
style linters (`linter.style.show`, `linter.style.longLine` from `weak.linter.mathlibStandardSet`),
so a style warning surfaces only here. Reproduce it cheaply and early with `lake env lean
-Dlinter.style.show=true -Dlinter.style.longLine=true <file>`. House style uses `change` (not a
goal-altering `show`) and wraps lines to <=100 columns.

## Step 5: Route the executor's ESCALATE/BLOCKED return

The `fvs-crypto-executor` owns its own implement -> check -> complete -> escalate -> BLOCKED
discipline; this command does not re-drive a per-goal grind. When the executor returns ESCALATE (a
public-statement change is needed) or BLOCKED (it cannot proceed), HALT and redirect to the user via
`AskUserQuestion` (degrade to plain-text + WAIT on a secondary runtime that lacks it) -- a short
interactive redirect beats a long unattended grind.

## Step 6: Run-end banner + next command

```
FVS >> CRYPTO EXECUTE COMPLETE

Topic:     {TOPIC_RAW}
Iteration: {ITER}
Build:     {green | red -- redirected}
Plan:      plans/{EXEC_PLAN | FOLLOWUP_PLAN}_{ITER}.md

>> Next Up
/fvs:crypto-eval <topic> {ITER}
```

</process>

<codex_skill_adapter>
On a secondary runtime, both the Step 3 model/effort ask and the Step 5 ESCALATE/BLOCKED redirect
degrade to a plain-text question and WAIT for the user; each is fail-closed (never auto-picks a
default beyond the ladder's `inherit`, never writes an upstream artifact). The `Task(...)` dispatch
survives intact (the `model=` parameter is silently ignored on Codex, where per-agent effort is fixed
at install time, so the per-run `--effort` flag is a no-op there).
</codex_skill_adapter>

<success_criteria>
- [ ] Topic + iteration resolved; shell metacharacters rejected; every path quoted; no `eval`.
- [ ] The bounded plan (`EXEC_PLAN_nN.md` / `FOLLOWUP_PLAN_nN.md`) read and inlined; `fvs-crypto-executor` dispatched (`subagent_type="fvs-crypto-executor"`).
- [ ] The build runs under `set -o pipefail` + `${PIPESTATUS` reading the tool's real status; always `nice -n 19 lake build` (never a bare `lake build`).
- [ ] The executor's ESCALATE/BLOCKED return is routed to the user (short interactive redirect early, never a long unattended grind).
- [ ] No `gh` open/create; no generated-Lean write.
</success_criteria>
