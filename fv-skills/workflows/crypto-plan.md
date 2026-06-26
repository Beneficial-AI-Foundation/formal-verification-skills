<objective>
The PLAN stage of the crypto formalisation loop: author the next bounded, runtime-neutral executor
plan for a topic, grounded in the paper via the NotebookLM KB, and persist it under
`fv-plans/<topic>/{plans,reviews,sources,merge}`.

This workflow is the state machine for `/fvs:crypto-plan`. The command body is the orchestrator: it
resolves the topic slug + the artifact tree, runs the KB grounding (cache-before-requery), dispatches
the high-effort thinker (`fvs-crypto-thinker`) to AUTHOR the plan by return, and persists the
returned artifacts. The plan is RUNTIME-NEUTRAL: it must be executable by ANY runtime's executor with
no thinker in the loop -- the loop runs as a `(R1; R1)` same-runtime pair by default, and an optional
secondary runtime (the reserved `--codex` mode, wired in a later wave) may take the planning and/or
eval stages.

Hard invariants this workflow preserves:
- All loop writes confined to `.formalising/fv-plans/<topic>/{plans,reviews,sources,merge}`.
- Generated Lean (`Types.lean` / `Funs.lean`) is NEVER written.
- The topic slug + iteration arg are untrusted input: reject shell metacharacters, quote every path,
  never `eval` a path.
- Builds verify via `nice -n 19 lake build` under the `set -o pipefail` / `${PIPESTATUS` guard --
  never a bare `lake build`.
</objective>

<process>

<step name="resolve_topic">
## Step 1: Resolve the topic slug + artifact tree (path safety)

Resolve the topic into a slug: collapse whitespace runs to a single `-`, PRESERVE meaningful
capitalization (`CKA from KEM` -> `CKA-from-KEM`). REJECT a slug containing shell metacharacters,
QUOTE every path expansion, NEVER `eval` a path.

Resolve and create `.formalising/fv-plans/<topic>/{plans,reviews,sources,merge}`. The four subfolders
split the loop's records by ROLE (not by runtime):
- `plans/` -- `PLAN_nN.md` (high-level) + `EXEC_PLAN_nN.md` (bounded executor plan) + `FOLLOWUP_PLAN_nN.md`.
- `reviews/` -- `EVAL_nN.md` (the adversarial eval; leads with findings; decides the verdict).
- `sources/` -- paper excerpts, theorem maps, normalization choices, and CACHED KB answers.
- `merge/` -- branch integration state: conflict files, conflict themes, the next safe action when an
  accepted iteration lands back on the project branch.
</step>

<step name="restart_from_records">
## Step 2: Restart from records -- resolve the iteration

The loop is restartable from its own on-disk records. Read the latest `PLAN_nN.md` from `plans/` and
author the next iteration (`latest + 1`), honoring an explicit `nN` arg if given. Iteration naming is
runtime-neutral and role-based: `PLAN_nN.md`, `EXEC_PLAN_nN.md`, `EVAL_nN.md`, `FOLLOWUP_PLAN_nN.md`.
</step>

<step name="kb_grounding">
## Step 3: KB grounding -- intensive when configured, cache-before-requery

Ground the plan in the paper via the NotebookLM KB. For EACH planning question, compute a stable
cache key (`shasum -a 256` of the question) and reuse the cached answer under `sources/` BEFORE ever
re-querying:

```bash
QHASH=$(printf '%s' "$QUESTION" | shasum -a 256 | cut -c1-16)
if [ -f "$ROOT/sources/$QHASH.json" ]; then
  cat "$ROOT/sources/$QHASH.json"            # cache hit -- re-read, do NOT re-query
else
  python3 scripts/fvs-kb-query.py ask "$QUESTION" --notebook "$NOTEBOOK_ID" --json \
    | tee "$ROOT/sources/$QHASH.json"        # cache the answer under sources/
fi
```

If no KB is configured (`fvs-kb-query.py` returns `NOT_INSTALLED` / `AUTH_EXPIRED`, or no notebook is
set): LOUD-FAIL EXACTLY ONCE with the `/fvs:kb-setup` setup instructions, then PROCEED only at the
user's explicit choice in a LABELED DEGRADED mode -- record `KB: degraded -- not configured` in the
plan artifact. Loud-fail ONCE (not per question); never silently continue ungrounded.
</step>

<step name="dispatch_thinker">
## Step 4: Dispatch the thinker -- author the bounded plan

Resolve the thinker model via the model-profiles dispatch sequence, then dispatch the high-effort
thinker, INLINING the topic context + the cached KB sources (references do not cross the Task
boundary):

```
Task(subagent_type="fvs-crypto-thinker", model="$THINKER_MODEL",
     description="Author bounded plan",
     prompt="Mode: plan ...inlined topic + branch state + KB sources... Return with ## PLAN COMPLETE")
```

The thinker authors BY RETURN; the command body persists `plans/PLAN_nN.md` (high-level) and
`plans/EXEC_PLAN_nN.md` (the bounded executor plan).
</step>

<step name="bounded_plan_contract">
## Step 5: The bounded-plan contract (written into EXEC_PLAN_nN.md)

`EXEC_PLAN_nN.md` carries the full bounded-plan contract verbatim, so any runtime's executor can run
it with no thinker in the loop:

1. **Branch and current state** -- the branch name and what already compiles / is proven.
2. **Exact target files and theorems** -- precise files + named theorems/defs; no "etc.".
3. **Public statements that must NOT change** -- the immutable signatures preserved verbatim.
4. **Old -> new API map** (if a port) -- a literal mapping table.
5. **Allowed-`sorry` policy** -- which `sorry`s are permitted as NAMED obligations with the exact
   statement each must carry (never judged by count).
6. **Stop conditions** -- the explicit conditions under which the executor HALTS.
7. **Verification commands** -- ALWAYS `nice -n 19 lake build` under the `set -o pipefail` /
   `${PIPESTATUS` guard (never a bare `lake build`).
8. **Expected artifact updates** -- which `fv-plans/<topic>/{plans,reviews,sources,merge}` files the
   run is expected to produce or update.
</step>

</process>

<success_criteria>
- [ ] Topic resolved into a runtime-neutral slug; shell metacharacters rejected; paths quoted; no `eval`.
- [ ] Artifact tree `fv-plans/<topic>/{plans,reviews,sources,merge}` resolved/created; restart-from-records reads the latest `nN`.
- [ ] KB grounded intensively when configured; cached under `sources/` and re-read before re-querying; loud-fail-once + labeled-degrade + `/fvs:kb-setup` when unconfigured.
- [ ] The high-effort thinker (`fvs-crypto-thinker`) dispatched with inlined context; the plan authored by return.
- [ ] The bounded-plan contract (stop conditions, verification commands `nice -n 19 lake build`, immutable public statements) written into `EXEC_PLAN_nN.md`.
- [ ] No bare `lake build`, no `gh` open/create, no generated-Lean write.
</success_criteria>
