---
name: fvs:crypto-followup
description: Convert the latest adversarial eval findings into the next bounded follow-up plan, HALTing on HUMAN_RULING
argument-hint: "<topic> [nN] [--codex]"
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
  - Write
  - Task
  - AskUserQuestion
---

<objective>
Convert the latest adversarial eval's findings into the next bounded follow-up plan. The
high-effort `fvs-crypto-thinker` (followup mode) re-derives the follow-up from the eval; this
command body persists the returned plan under `plans/`.

This command is the FOLLOWUP stage of the single-runtime loop (plan -> execute -> eval -> followup).
When the prior eval decided `HUMAN_RULING`, this command MUST HALT and ask the user for the modeling
decision -- it NEVER fabricates a follow-up that silently picks one side of a modeling ruling.

Output: `FOLLOWUP_PLAN_nN.md` under `plans/` (on `FOLLOWUP`), or a HALT-and-ask (on
`HUMAN_RULING`).
</objective>

<execution_context>
@~/.claude/fv-skills/workflows/crypto-followup.md
@~/.claude/fv-skills/references/model-profiles.md
@~/.claude/fv-skills/references/ui-brand.md
</execution_context>

<context>
Topic: $ARGUMENTS (required). The optional `nN` selects the eval iteration to follow up on; the
optional `--codex` flag swaps the thinker for a Codex thinker at this followup stage (a swappable
thinker, not a second loop).

The loop is restartable from its own on-disk records: re-running reads the latest `EVAL_nN.md`
from `reviews/` and authors the matching follow-up.
</context>

<process>

## Step 1: Resolve the topic slug and paths (path safety)

Resolve the topic into a slug (whitespace -> `-`, capitalization preserved, e.g.
`CKA from KEM` -> `CKA-from-KEM`). Treat the topic + iteration arg as UNTRUSTED: REJECT a slug with
shell metacharacters, QUOTE every path expansion, NEVER `eval` a path.

```bash
TOPIC_RAW="$1"
case "$TOPIC_RAW" in
  *[';|&$`()<>'*]* ) echo "FVS >> ERROR: topic contains shell metacharacters" >&2; exit 1 ;;
esac
SLUG=$(printf '%s' "$TOPIC_RAW" | tr -s '[:space:]' '-')
ROOT=".formalising/fv-plans/$SLUG"
```

Confine ALL writes to `.formalising/fv-plans/<topic>/{plans,reviews,sources,merge}`. Never write a
generated Lean file.

## Step 2: Read the latest eval + its decision

Read the latest `EVAL_nN.md` from `reviews/` and extract its decision verb (exactly one of
`ACCEPT | FOLLOWUP | HUMAN_RULING | BLOCKED`):

```bash
EVAL=$(ls "$ROOT"/reviews/EVAL_n*.md 2>/dev/null | sort -V | tail -1)
DECISION=$(grep -Eo '\b(ACCEPT|FOLLOWUP|HUMAN_RULING|BLOCKED)\b' "$EVAL" | tail -1)
```

Route by decision:
- `ACCEPT` -- nothing to follow up; the loop is at its end. Report and stop.
- `BLOCKED` -- the work cannot proceed; suggest `/fvs:pause-work fv-plans/<topic>` and stop.
- `FOLLOWUP` -- proceed to Step 4 (author the bounded follow-up plan).
- `HUMAN_RULING` -- HALT (Step 3); NEVER fabricate a follow-up plan.

## Step 3: HUMAN_RULING -- HALT for the modeling decision

When the eval decided `HUMAN_RULING`, a modeling decision is required that the loop must NOT make
itself. HALT and ask the user, presenting the exact choice at stake, the options, and what each
implies for the formalisation. Use `AskUserQuestion`; on Codex, degrade to a plain-text question and
WAIT (fail-closed -- never auto-pick a default).

```
FVS >> HUMAN_RULING -- a modeling decision is required.

The adversarial eval cannot proceed without a human ruling on:
  {the exact modeling choice at stake, from EVAL_nN.md}

Options:
  (a) {option a} -> implies {...}
  (b) {option b} -> implies {...}

This command will NOT author a follow-up that silently picks a side.
```

Only AFTER the user supplies the ruling does the command author a follow-up plan that encodes the
ruling (returning to Step 4). Never invent a follow-up on `HUMAN_RULING` without the human's ruling.

## Step 4: Resolve the thinker + dispatch (followup mode)

Default (no `--codex`) -- dispatch the in-runtime thinker. Resolve `$THINKER_MODEL` for
`fvs-crypto-thinker` via the model-profiles dispatch sequence. `cat` the eval findings (and the
user's ruling, if any) and INLINE them into the prompt:

```
Task(
  subagent_type="fvs-crypto-thinker",
  model="$THINKER_MODEL",
  description="Author follow-up plan",
  prompt="Mode: followup

<eval_findings>...the inlined EVAL_nN.md...</eval_findings>
<human_ruling>...the user's ruling, if the prior decision was HUMAN_RULING...</human_ruling>
<run_context>...branch state + the plan it was run against...</run_context>

Author the next bounded follow-up plan (full bounded-plan contract). Return with ## PLAN COMPLETE"
)
```

When `--codex` is passed -- SWAP this `Task(subagent_type="fvs-crypto-thinker", …)` dispatch for the
FVS-owned Codex thinker helper. The Codex thinker takes ONLY this followup stage; everything
downstream is UNCHANGED (the executor stays `fvs-executor`, the artifacts stay under
`fv-plans/<topic>/`, the bounded-plan contract is identical). The `HUMAN_RULING` HALT in Step 3 still
runs IN THIS COMMAND BEFORE any Codex dispatch -- the helper is only reached on a `FOLLOWUP` decision
after any ruling is in hand, so a Codex thinker never silently picks a side of a modeling ruling.
Coordination is ARTIFACT-MEDIATED: the Codex thinker reads the topic folder, writes
`FOLLOWUP_PLAN_nN.md` under `plans/`, and EXITS -- there is NO live cross-process bridge. The helper is
EFFORT-ONLY: it passes `--effort xhigh` (>= xhigh enforced) and NO `--model`.

```bash
# --codex mode: swap the in-runtime thinker for the FVS-owned Codex thinker (followup stage).
node scripts/fvs-codex-think.mjs followup --topic "$ROOT" --effort xhigh
```

If `--codex` is passed but `codex` is unavailable, the helper surfaces its graceful install message
and exits non-zero; offer to fall back to single-runtime (re-run without `--codex`). Never silently
fall back -- the user always knows which runtime authored the follow-up.

The thinker (in-runtime or Codex) authors the follow-up plan; THIS command body writes
`plans/FOLLOWUP_PLAN_nN.md` carrying
the full bounded-plan contract (branch/state, exact target files + theorems, immutable public
statements that must not change, allowed-`sorry` policy, stop conditions, the verification command
`nice -n 19 lake build` under the `set -o pipefail` / `${PIPESTATUS` guard, expected artifact
updates).

## Step 5: Run-end banner + next command

```
FVS >> CRYPTO FOLLOWUP COMPLETE

Topic:     {TOPIC_RAW}
Decision:  {FOLLOWUP | HUMAN_RULING -> ruled}
Plan:      plans/FOLLOWUP_PLAN_n{N}.md

>> Next Up
/fvs:crypto-execute <topic> n{N}
```

</process>

<codex_skill_adapter>
The `--codex` flag swaps the thinker for a Codex thinker at THIS followup stage via the FVS-owned
helper `scripts/fvs-codex-think.mjs`
(`node scripts/fvs-codex-think.mjs followup --topic "$ROOT" --effort xhigh`). The helper is FVS-owned
and self-contained: it does NOT import or depend on the openai-codex plugin; it spawns `codex` via an
argv array (never a shell string), is EFFORT-ONLY (passes `--effort xhigh`, NO `--model`), and points
Codex at the topic folder as its working root. Coordination is ARTIFACT-MEDIATED: the Codex thinker
writes `FOLLOWUP_PLAN_nN.md` under `plans/` and exits -- there is NO live cross-process bridge. The
`HUMAN_RULING` HALT (Step 3) runs IN THIS COMMAND BEFORE any Codex dispatch, so a Codex thinker never
self-rules on a modeling decision; on Codex the HALT degrades to a plain-text question and WAITS for
the user (fail-closed -- never auto-picks a default, never writes an upstream artifact). If `codex` is
absent, the helper fails gracefully with install guidance and this command offers to fall back to
single-runtime (re-run without `--codex`). Without `--codex`, the `fvs-crypto-thinker` dispatch runs
unchanged.
</codex_skill_adapter>

<success_criteria>
- [ ] Topic resolved into a slug; shell metacharacters rejected; every path quoted; no `eval`.
- [ ] Latest `EVAL_nN.md` read; decision routed (`ACCEPT` stop / `BLOCKED` pause / `FOLLOWUP` author / `HUMAN_RULING` HALT).
- [ ] On `HUMAN_RULING` the command HALTs and asks the user -- it NEVER fabricates a follow-up plan.
- [ ] On `FOLLOWUP` the thinker is dispatched (`subagent_type="fvs-crypto-thinker"`) and the bounded follow-up plan written to `plans/`.
- [ ] No bare `lake build`, no `gh` open/create, no generated-Lean write.
</success_criteria>
