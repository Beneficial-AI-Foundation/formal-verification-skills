<objective>
The FOLLOWUP stage of the crypto formalisation loop: convert the latest adversarial eval's findings
into the next bounded follow-up plan -- or HALT for a human modeling ruling when the eval decided
`HUMAN_RULING`.

This workflow is the state machine for `/fvs:crypto-followup`. The command body reads the latest
`EVAL_nN.md` from `reviews/`, routes by its decision verb, and (on `FOLLOWUP`) dispatches the
high-effort thinker to author the follow-up by return. The loop is runtime-neutral: it runs as a
`(R1; R1)` same-runtime pair by default; an optional secondary runtime (the reserved `--codex` mode)
may take the planning and/or eval stages in a later wave.

Hard invariant: on `HUMAN_RULING` the loop HALTS and asks the human for the modeling decision -- it
NEVER fabricates a follow-up that silently picks one side of a modeling ruling.
</objective>

<process>

<step name="resolve_topic">
## Step 1: Resolve the topic slug + paths (path safety)

Resolve the topic into a slug (whitespace -> `-`, capitalization preserved). REJECT a slug with shell
metacharacters, QUOTE every path expansion, NEVER `eval` a path. Confine all writes to
`.formalising/fv-plans/<topic>/{plans,reviews,sources,merge}`; never write generated Lean.
</step>

<step name="read_eval">
## Step 2: Read the latest eval + route by decision

Read the latest `EVAL_nN.md` from `reviews/` and extract its decision verb -- exactly one of
`ACCEPT | FOLLOWUP | HUMAN_RULING | BLOCKED`. Route:

- `ACCEPT` -- the loop is at its end; report and stop.
- `BLOCKED` -- the work cannot proceed; suggest `/fvs:pause-work fv-plans/<topic>` and stop.
- `FOLLOWUP` -- author the bounded follow-up plan (Step 4).
- `HUMAN_RULING` -- HALT for the modeling decision (Step 3); never fabricate a plan.
</step>

<step name="human_ruling_halt">
## Step 3: HUMAN_RULING -- HALT for the modeling decision

When the eval decided `HUMAN_RULING`, a modeling decision is required that the loop must NOT make
itself. HALT and ask the human, presenting the exact choice at stake, the options, and what each
implies for the formalisation. Use `AskUserQuestion`; on a secondary runtime that lacks it, degrade
to a plain-text question and WAIT (fail-closed -- never auto-pick a default, never self-rule).

Only AFTER the human supplies the ruling does the command author a follow-up plan that ENCODES the
ruling. On `HUMAN_RULING`, never invent a follow-up without the human's ruling.
</step>

<step name="dispatch_thinker">
## Step 4: Dispatch the thinker (followup mode)

Resolve the thinker model via the model-profiles sequence, then dispatch the high-effort thinker,
INLINING the eval findings (and the human's ruling, if any):

```
Task(subagent_type="fvs-crypto-thinker", model="$THINKER_MODEL",
     description="Author follow-up plan",
     prompt="Mode: followup ...inlined EVAL_nN.md findings + ruling... Return with ## PLAN COMPLETE")
```

The thinker authors BY RETURN; the command body persists `plans/FOLLOWUP_PLAN_nN.md` carrying the
full bounded-plan contract (branch/state, exact target files + theorems, immutable public statements,
allowed-`sorry` policy, stop conditions, the verification command `nice -n 19 lake build` under the
`set -o pipefail` / `${PIPESTATUS` guard, expected artifact updates).

The follow-up also records `Authoring runtime: <actual runtime>` (`Codex CLI` for `--codex`) so the
independent `/fvs:crypto-review --target followup` stage can reject self-review or unknown
provenance before execution.
</step>

</process>

<success_criteria>
- [ ] Topic resolved into a runtime-neutral slug; shell metacharacters rejected; paths quoted; no `eval`.
- [ ] Latest `EVAL_nN.md` read; decision routed (`ACCEPT` stop / `BLOCKED` pause / `FOLLOWUP` author / `HUMAN_RULING` HALT).
- [ ] On `HUMAN_RULING` the loop HALTs and asks the human -- it NEVER fabricates a follow-up plan.
- [ ] On `FOLLOWUP` the high-effort thinker (`fvs-crypto-thinker`) dispatched; the bounded follow-up plan written to `plans/`.
- [ ] The follow-up records truthful authoring provenance and routes next to independent review.
- [ ] No bare `lake build`, no `gh` open/create, no generated-Lean write.
</success_criteria>
