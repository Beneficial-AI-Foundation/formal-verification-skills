<objective>
The EVAL stage of the crypto formalisation loop: adversarially evaluate the current iteration's
executed work and end in EXACTLY ONE decision verb.

This workflow is the state machine for `/fvs:crypto-eval`. The command body dispatches the
high-effort `fvs-crypto-thinker` in eval mode (always adversarial), persists the returned eval to
`reviews/EVAL_nN.md`, and routes the decision. The loop is runtime-neutral: it runs as a `(R1; R1)`
same-runtime pair by default; an optional secondary runtime (the reserved `--codex` mode) may take
the eval and/or planning stages in a later wave.

Hard invariant: the eval is ALWAYS adversarial and ends in EXACTLY ONE of
`ACCEPT | FOLLOWUP | HUMAN_RULING | BLOCKED`. A `sorry` is judged as a named obligation, never by
count.
</objective>

<process>

<step name="resolve_topic">
## Step 1: Resolve the topic + iteration (path safety)

Resolve the topic into a runtime-neutral slug (whitespace -> `-`, capitalization preserved). REJECT
shell metacharacters, QUOTE every path, NEVER `eval` a path. Confine writes to
`.formalising/fv-plans/<topic>/{plans,reviews,sources,merge}`; never write a generated Lean file.
</step>

<step name="dispatch_thinker">
## Step 2: Dispatch the thinker (eval mode -- always adversarial)

Resolve `$THINKER_MODEL` via the model-profiles sequence, then dispatch the high-effort thinker,
INLINING the iteration's bounded plan + the executed artifacts (touched files, `build.log`) + the
cached KB sources:

```
Task(subagent_type="fvs-crypto-thinker", model="$THINKER_MODEL",
     description="Adversarial eval",
     prompt="Mode: eval ...inlined plan + executed artifacts + KB sources... Return with ## EVAL COMPLETE")
```

The eval is ALWAYS adversarial: re-derive independently, take the posture of a reviewer trying to
REFUTE the spec, the proof, and the stated assumptions; do not echo the executor's reasoning. A
`sorry` is acceptable ONLY as an intentional, NAMED obligation carrying the correct statement --
never judged by count, never waved through because the build is green.
</step>

<step name="persist_and_route">
## Step 3: Persist + route the decision

The thinker authors by return; the command body writes the eval to `reviews/EVAL_nN.md`. The eval
ends in EXACTLY ONE of the four decision verbs; route:

- **ACCEPT** -- the spec/proof survives the adversarial pass; the loop is at its end.
- **FOLLOWUP** -- sound but incomplete; suggest `/fvs:crypto-followup <topic> nN`.
- **HUMAN_RULING** -- a modeling decision the loop must NOT make itself; HALT for the user's ruling
  (degrade to plain-text + WAIT on a secondary runtime that lacks an interactive prompt), then suggest
  `/fvs:crypto-followup <topic> nN` to encode the ruling.
- **BLOCKED** -- the work cannot proceed; a VALID outcome, not a failure. Record it and suggest
  `/fvs:pause-work fv-plans/<topic>`.
</step>

</process>

<success_criteria>
- [ ] Topic + iteration resolved; shell metacharacters rejected; paths quoted; no `eval`.
- [ ] `fvs-crypto-thinker` dispatched (`subagent_type="fvs-crypto-thinker"`) in eval mode with inlined plan + executed artifacts.
- [ ] The eval is ALWAYS adversarial and ends in EXACTLY ONE of `ACCEPT | FOLLOWUP | HUMAN_RULING | BLOCKED`, written to `reviews/EVAL_nN.md`.
- [ ] `HUMAN_RULING` routes to a HALT; `BLOCKED` is recorded as a valid outcome.
- [ ] A `sorry` is judged as a named obligation, never by count.
- [ ] No bare `lake build`, no `gh` open/create, no generated-Lean write.
</success_criteria>
