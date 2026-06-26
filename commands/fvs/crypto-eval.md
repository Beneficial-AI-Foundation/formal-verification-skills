---
name: fvs:crypto-eval
description: Adversarially evaluate the current iteration; end in exactly one decision verb
argument-hint: "<topic> nN [--codex]"
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
Adversarially evaluate the current iteration's executed work. The high-effort `fvs-crypto-thinker`
(eval mode) takes the posture of a reviewer actively trying to REFUTE the spec, the proof, and the
stated assumptions; this command body persists the returned eval to `reviews/EVAL_nN.md` and routes
the decision.

This command is the EVAL stage of the single-runtime loop (plan -> execute -> eval -> followup). The
eval is ALWAYS adversarial and MUST end in EXACTLY ONE of `ACCEPT | FOLLOWUP | HUMAN_RULING | BLOCKED`.
The loop is runtime-neutral: it runs as a `(R1; R1)` same-runtime pair by default; an optional
secondary runtime (the reserved `--codex` mode) may take the eval and/or planning stages in a later
wave.

Output: `reviews/EVAL_nN.md` carrying exactly one decision verb, with the decision routed.
</objective>

<execution_context>
@~/.claude/fv-skills/workflows/crypto-eval.md
@~/.claude/fv-skills/references/model-profiles.md
@~/.claude/fv-skills/references/ui-brand.md
</execution_context>

<context>
Topic + iteration: $ARGUMENTS (required -- `<topic> nN`). The optional `--codex` flag is RESERVED
here (the thinker swap lands in a later wave). The eval reads the iteration's plan + executed
artifacts and produces the adversarial verdict.
</context>

<process>

## Step 1: Resolve the topic slug + paths (path safety)

Resolve the topic into a slug (whitespace -> `-`, capitalization preserved). Treat the topic +
iteration arg as UNTRUSTED: REJECT a slug with shell metacharacters, QUOTE every path expansion,
NEVER `eval` a path. Confine all writes to `.formalising/fv-plans/<topic>/{plans,reviews,sources,merge}`;
never write a generated Lean file.

## Step 2: Resolve the thinker model + dispatch (eval mode)

Resolve `$THINKER_MODEL` for `fvs-crypto-thinker` via the model-profiles dispatch sequence. `cat` the
iteration's bounded plan + the executed artifacts (touched files, `build.log`) + the cached KB
sources, and INLINE them into the prompt:

```
Task(
  subagent_type="fvs-crypto-thinker",
  model="$THINKER_MODEL",
  description="Adversarial eval",
  prompt="Mode: eval

<plan>...the inlined EXEC_PLAN_nN.md / FOLLOWUP_PLAN_nN.md...</plan>
<executed>...the touched files + build.log...</executed>
<kb_sources>...the inlined sources/*.json...</kb_sources>

Re-derive independently and try to REFUTE. End in exactly one of ACCEPT | FOLLOWUP | HUMAN_RULING |
BLOCKED. Return with ## EVAL COMPLETE"
)
```

The eval is ALWAYS adversarial (re-derive independently; do not echo the executor's reasoning). A
`sorry` is acceptable ONLY as an intentional, NAMED obligation carrying the correct statement --
never judged by count, never waved through because "the build is green".

## Step 3: Persist + route the decision

The thinker authors by return; THIS command body writes the eval to `reviews/EVAL_nN.md`. The eval
ends in EXACTLY ONE decision verb; route it:

- **ACCEPT** -- the spec/proof survives the adversarial pass; the loop is at its end.
- **FOLLOWUP** -- the work is sound but incomplete; suggest `/fvs:crypto-followup <topic> nN`.
- **HUMAN_RULING** -- a modeling decision is required that the loop must NOT make itself. HALT for the
  user's ruling via `AskUserQuestion` (degrade to plain-text + WAIT on a secondary runtime that lacks
  it); fail-closed -- never auto-pick a side. Then suggest `/fvs:crypto-followup <topic> nN` to encode
  the ruling.
- **BLOCKED** -- the work cannot proceed (the build will not compile, a prerequisite is absent); this
  is a VALID outcome, not a failure. Record it and suggest `/fvs:pause-work fv-plans/<topic>`.

## Step 4: Run-end banner

```
FVS >> CRYPTO EVAL COMPLETE

Topic:     {TOPIC_RAW}
Iteration: {ITER}
Decision:  {ACCEPT | FOLLOWUP | HUMAN_RULING | BLOCKED}
Review:    reviews/EVAL_{ITER}.md
```

</process>

<codex_skill_adapter>
The `--codex` flag is RESERVED here -- the Codex thinker swap is wired in a later wave; this command
runs the `fvs-crypto-thinker` dispatch unchanged. On a secondary runtime, the `HUMAN_RULING` HALT
degrades to a plain-text question and WAITS for the user; it is fail-closed (never auto-picks a side,
never writes an upstream artifact). The `Task(...)` dispatch survives intact (the `model=` parameter
is silently ignored on Codex).
</codex_skill_adapter>

<success_criteria>
- [ ] Topic + iteration resolved; shell metacharacters rejected; every path quoted; no `eval`.
- [ ] `$THINKER_MODEL` resolved; `fvs-crypto-thinker` dispatched (`subagent_type="fvs-crypto-thinker"`) in eval mode with inlined plan + executed artifacts.
- [ ] The eval is ALWAYS adversarial and ends in EXACTLY ONE of `ACCEPT | FOLLOWUP | HUMAN_RULING | BLOCKED`, written to `reviews/EVAL_nN.md`.
- [ ] `HUMAN_RULING` routes to a HALT; `BLOCKED` is recorded as a valid outcome (suggest `/fvs:pause-work`).
- [ ] A `sorry` is judged as a named obligation, never by count.
- [ ] No bare `lake build`, no `gh` open/create, no generated-Lean write.
</success_criteria>
