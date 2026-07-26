---
name: fvs:crypto-plan
description: Author the next bounded, runtime-neutral plan for a topic-based crypto formalisation iteration
argument-hint: "<topic> [nN] [--codex]"
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
  - Write
  - Task
---

<objective>
Start (or continue) a topic-based crypto formalisation iteration by authoring the next bounded
executor plan. The high-effort `fvs-crypto-thinker` re-derives the plan from the branch state and
the paper-grounded KB sources; this command body persists the returned plan under
`.formalising/fv-plans/<topic>/{plans,reviews,sources,merge}`.

This command is the PLAN stage of the loop
(plan -> independent review -> execute -> eval -> followup -> independent review).
The plan it produces is RUNTIME-NEUTRAL: it must be executable by any runtime's executor with no
thinker in the loop. The loop is restartable from its own on-disk records.

Output: `PLAN_nN.md` (the high-level plan) + `EXEC_PLAN_nN.md` (the bounded executor plan) under
`plans/`, with the KB answers cached under `sources/`.
</objective>

<execution_context>
@~/.claude/fv-skills/workflows/crypto-plan.md
@~/.claude/fv-skills/references/model-profiles.md
@~/.claude/fv-skills/references/ui-brand.md
</execution_context>

<context>
Topic: $ARGUMENTS (required -- a free-form topic, e.g. "CKA from KEM"). The optional `nN` iteration
arg selects an explicit iteration; the optional `--codex` flag swaps the thinker for a Codex thinker
at this stage (see the `<codex_skill_adapter>` block) -- a swappable thinker, not a second loop.

The loop is restartable from its own on-disk records. Re-running on the same topic reads the latest
`nN` under `.formalising/fv-plans/<topic>/plans/` and authors the next iteration, mirroring the
restart-from-records discipline of `/fvs:aeneas-extract`.
</context>

<process>

## Step 1: Resolve the topic slug and the artifact tree (path safety)

Resolve the topic into a slug: collapse runs of whitespace to a single `-`, and PRESERVE
meaningful capitalization (so `CKA from KEM` -> `CKA-from-KEM`). Treat the topic and the iteration
arg as UNTRUSTED input: REJECT a slug containing shell metacharacters (`; | & $ \` ( ) < > newline`
and friends), QUOTE every path expansion, and NEVER `eval` a path.

```bash
TOPIC_RAW="$1"
# reject shell metacharacters before the slug ever touches a path
case "$TOPIC_RAW" in
  *..*|*/* ) echo "FVS >> ERROR: topic contains '..' or '/' (path traversal); refusing" >&2; exit 1 ;;
  *[![:alnum:]_[:space:]-]* ) echo "FVS >> ERROR: topic contains unsupported characters" >&2; exit 1 ;;
esac
SLUG=$(printf '%s' "$TOPIC_RAW" | tr -s '[:space:]' '-')
ROOT=".formalising/fv-plans/$SLUG"
mkdir -p "$ROOT/plans" "$ROOT/reviews" "$ROOT/sources" "$ROOT/merge"
```

The four subfolders split the loop's records by role (artifact contract):
- `plans/` -- `PLAN_nN.md` (high-level) + `EXEC_PLAN_nN.md` (bounded executor plan) + `FOLLOWUP_PLAN_nN.md`.
- `reviews/` -- pre-execution `PLAN_REVIEW_nN.md` / `FOLLOWUP_REVIEW_nN.md`, plus
  post-execution `EVAL_nN.md` (decides ACCEPT / FOLLOWUP / HUMAN_RULING / BLOCKED).
- `sources/` -- paper excerpts, theorem maps, advantage/probability normalization choices, and CACHED KB answers.
- `merge/` -- branch integration state: the conflict files, the conflict themes, and the next safe action when an accepted iteration lands back on the project branch.

Confine ALL writes to `.formalising/fv-plans/<topic>/{plans,reviews,sources,merge}`. Never write a
generated Lean file (`Types.lean` / `Funs.lean`).

## Step 2: Restart from records -- resolve the iteration

Read the latest iteration from `plans/`:

```bash
LATEST=$(ls "$ROOT"/plans/PLAN_n*.md 2>/dev/null | sed -E 's/.*PLAN_n([0-9]+)\.md/\1/' | sort -n | tail -1)
NEXT=$(( ${LATEST:-0} + 1 ))   # if an explicit nN arg was given, honor it instead
```

The iteration naming is `PLAN_nN.md`, `EXEC_PLAN_nN.md`, `EVAL_nN.md`,
`FOLLOWUP_PLAN_nN.md`. A new topic begins at `n1`; a re-run resumes at `latest + 1`.

## Step 3: Resolve the thinker model

Resolve `$THINKER_MODEL` for `fvs-crypto-thinker` via the model-profiles dispatch sequence
(config `model_overrides` first, then the profile table, then `inherit` for unknown agents). On
Codex the `model=` parameter is silently ignored; the dispatch is unchanged.

## Step 4: KB grounding -- intensive when configured, cache-before-requery

Ground the plan in the paper via the NotebookLM KB. For EACH planning question, compute a stable
cache key and reuse the cached answer under `sources/` before ever re-querying:

```bash
QHASH=$(printf '%s' "$QUESTION" | shasum -a 256 | cut -c1-16)
if [ -f "$ROOT/sources/$QHASH.json" ]; then
  cat "$ROOT/sources/$QHASH.json"            # cache hit -- re-read, do NOT re-query
else
  .formalising/.kb-venv/bin/python ~/.claude/scripts/fvs-kb-query.py ask "$QUESTION" --notebook "$NOTEBOOK_ID" --json \
    | tee "$ROOT/sources/$QHASH.json"        # cache the answer for the next iteration
fi
```

If no KB is configured (the health check or `ask` returns `NOT_INSTALLED` / `AUTH_EXPIRED`, or no
notebook is set), LOUD-FAIL EXACTLY ONCE with the setup instructions:

```
FVS >> KB NOT CONFIGURED -- planning will be ungrounded.
Run /fvs:kb-setup to configure NotebookLM, then re-run /fvs:crypto-plan <topic>.
```

Then PROCEED only at the user's explicit choice in a LABELED DEGRADED mode -- record the line
`KB: degraded -- not configured` in the plan artifact so every downstream reader sees the
formalisation was not paper-grounded. Do NOT silently continue; do NOT repeat the loud-fail on
every question (loud-fail ONCE, then degrade or stop on the user's choice).

## Step 5: Dispatch the thinker (author the bounded plan)

Default (no `--codex`) -- dispatch the in-runtime thinker. `cat` the topic artifacts and the cached
KB sources and INLINE them into the prompt -- references do NOT cross the Task boundary:

```
Task(
  subagent_type="fvs-crypto-thinker",
  model="$THINKER_MODEL",
  description="Author bounded plan",
  prompt="Mode: plan

<topic>{TOPIC_RAW} (iteration n{NEXT})</topic>
<branch_state>...the current branch + working-tree state...</branch_state>
<kb_sources>...the inlined sources/*.json answers...</kb_sources>
<prior>...the latest PLAN_n / EVAL_n if any...</prior>

Author ONE bounded, runtime-neutral executor plan. Return with ## PLAN COMPLETE"
)
```

When `--codex` is passed -- SWAP this `Task(subagent_type="fvs-crypto-thinker", …)` dispatch for the
FVS-owned Codex thinker helper. The Codex thinker takes ONLY this thinker stage; everything downstream
is UNCHANGED (the executor stays `fvs-executor`, the artifacts stay under `fv-plans/<topic>/`, the
bounded-plan contract and runtime-neutral naming are identical). Coordination is ARTIFACT-MEDIATED:
the Codex thinker reads the topic folder, writes `PLAN_nN.md` / `EXEC_PLAN_nN.md` under `plans/`, and
EXITS -- there is NO live cross-process bridge and no kept-alive process across stages. The helper is
EFFORT-ONLY: it passes `--effort xhigh` (>= xhigh enforced) and NO `--model`.

```bash
# --codex mode: swap the in-runtime thinker for the FVS-owned Codex thinker (plan stage).
node ~/.claude/scripts/fvs-codex-think.mjs plan --topic "$ROOT" --effort xhigh
```

If `--codex` is passed but the `codex` CLI is unavailable, the helper surfaces its graceful
install-instruction message and exits non-zero; offer to fall back to single-runtime mode (re-run
without `--codex`, which dispatches `fvs-crypto-thinker` unchanged). Never silently fall back -- the
user always knows which runtime authored the plan.

The thinker (in-runtime or Codex) authors the plan; THIS command body writes:
- `plans/PLAN_nN.md` -- the high-level plan.
- `plans/EXEC_PLAN_nN.md` -- the bounded executor plan.

Both artifacts MUST record a top-level metadata line:

```
Authoring runtime: {Claude Code | OpenCode | Gemini | Codex | Codex CLI}
```

Use `Codex CLI` when `--codex` authored the plan; otherwise name the actual host runtime. Never
write a generic or guessed marker. `/fvs:crypto-review` uses it to prevent Codex self-review and
fails closed when provenance is missing.

Carry the BOUNDED-PLAN CONTRACT verbatim into `EXEC_PLAN_nN.md`:
1. **Branch and current state** -- the branch name and what already compiles / is proven.
2. **Exact target files and theorems** -- precise files + named theorems/defs; no "etc.".
3. **Public statements that must NOT change** -- the immutable signatures preserved verbatim.
4. **Old -> new API map** (if a port) -- a literal mapping table.
5. **Allowed-`sorry` policy** -- which `sorry`s are permitted as NAMED obligations with the exact
   statement each must carry (never judged by count).
6. **Stop conditions** -- the explicit conditions under which the executor HALTS.
7. **Verification commands** -- ALWAYS `nice -n 19 lake build` (never a bare `lake build`), under
   the `set -o pipefail` / `${PIPESTATUS` guard so a piped build failure is never masked.
8. **Expected artifact updates** -- which `fv-plans/<topic>/{plans,reviews,sources,merge}` files the
   run is expected to produce or update.

## Step 6: Run-end banner + next command

```
FVS >> CRYPTO PLAN COMPLETE

Topic:     {TOPIC_RAW}
Iteration: n{NEXT}
KB:        {grounded | degraded -- not configured}
Plans:     plans/PLAN_n{NEXT}.md, plans/EXEC_PLAN_n{NEXT}.md
Sources:   {K} cached under sources/

>> Next Up
/fvs:crypto-review <topic> n{NEXT} --target plan
```

</process>

<codex_skill_adapter>
The `--codex` flag swaps the thinker for a Codex thinker at THIS stage via the FVS-owned helper
`~/.claude/scripts/fvs-codex-think.mjs`
(`node ~/.claude/scripts/fvs-codex-think.mjs plan --topic "$ROOT" --effort xhigh`).
The helper is FVS-owned and self-contained: it does NOT import or depend on the openai-codex plugin;
it spawns `codex` via an argv array (never a shell string), is EFFORT-ONLY (passes `--effort xhigh`,
NO `--model`), and points Codex at the topic folder as its working root. Coordination is
ARTIFACT-MEDIATED: the Codex thinker writes its plan artifact under `plans/` and exits -- there is NO
live cross-process bridge. If `codex` is absent, the helper fails gracefully with install guidance and
this command offers to fall back to single-runtime (re-run without `--codex`). Without `--codex`, the
`fvs-crypto-thinker` dispatch runs unchanged; on Codex any interactive prompt (the KB loud-fail-once
degrade choice) degrades to a plain-text question and WAITS for the user (fail-closed -- never
auto-picks a default, never writes an upstream artifact).
</codex_skill_adapter>

<success_criteria>
- [ ] Topic resolved into a slug (whitespace -> `-`, capitalization preserved); shell metacharacters rejected; every path quoted; no `eval`.
- [ ] Artifact tree `fv-plans/<topic>/{plans,reviews,sources,merge}` resolved/created; restart-from-records reads the latest `nN`.
- [ ] `$THINKER_MODEL` resolved via the model-profiles sequence; the thinker dispatched (`subagent_type="fvs-crypto-thinker"`) with inlined context.
- [ ] KB grounded intensively when configured; cached under `sources/` and re-read before re-querying; loud-fail-once + labeled-degrade + `/fvs:kb-setup` when unconfigured.
- [ ] The bounded-plan contract (stop conditions, verification commands `nice -n 19 lake build`, immutable public statements, allowed-`sorry`) is written into `EXEC_PLAN_nN.md`.
- [ ] Both plan artifacts record truthful `Authoring runtime:` provenance; the next action is
      independent `/fvs:crypto-review`, not direct execution.
- [ ] No bare `lake build`, no `gh` open/create, no generated-Lean write.
</success_criteria>
