<objective>
The EXECUTE stage of the crypto formalisation loop: run the current iteration's bounded executor
plan under a green-build guard and a bounded loop, so a failed proof triggers a SHORT interactive
redirect early rather than a long unattended grind.

This workflow is the state machine for `/fvs:crypto-execute`. The command body resolves the topic +
iteration, reads the bounded plan from `plans/`, dispatches the dedicated `fvs-crypto-executor`, and
owns the build-status check + routing the executor's ESCALATE/BLOCKED return to the user. The plan is
RUNTIME-NEUTRAL: the loop runs as a `(R1; R1)` same-runtime pair by default, with an optional
secondary runtime for the planning/eval stages in a later wave.

Hard invariants this workflow preserves:
- The build's exit status is read from the TOOL (`set -o pipefail` / `${PIPESTATUS`), never from the
  tail of a piped log (the green-build trap).
- Builds always run under `nice -n 19 lake build` -- never a bare `lake build`.
- Generated Lean (`Types.lean` / `Funs.lean`) is NEVER written.
- The topic + iteration are untrusted input: reject shell metacharacters, quote every path, never
  `eval`.
</objective>

<process>

<step name="resolve_topic">
## Step 1: Resolve the topic + iteration (path safety)

Resolve the topic into a runtime-neutral slug (whitespace -> `-`, capitalization preserved) and
validate the iteration arg is of the form `nN`. REJECT shell metacharacters, QUOTE every path, NEVER
`eval` a path. Confine writes to `.formalising/fv-plans/<topic>/{plans,reviews,sources,merge}`.
</step>

<step name="read_plan">
## Step 2: Read the bounded plan

Read the bounded executor plan for this iteration -- `plans/EXEC_PLAN_nN.md`, or
`plans/FOLLOWUP_PLAN_nN.md` if a follow-up plan exists. The bounded plan is the only input the
executor needs (runtime-neutral: branch/state, exact targets, immutable public statements,
allowed-`sorry` policy, stop conditions, verification command).
</step>

<step name="dispatch_executor">
## Step 3: Dispatch the crypto executor

Resolve `$EXECUTOR_MODEL` via the model-profiles sequence, then dispatch the dedicated crypto
executor, INLINING the bounded plan:

```
Task(subagent_type="fvs-crypto-executor", model="$EXECUTOR_MODEL",
     description="Run bounded plan",
     prompt="Execute the bounded crypto plan. ...inlined bounded plan... Return with ## IMPLEMENTATION COMPLETE")
```

The `fvs-crypto-executor` owns its own implement -> check -> complete -> escalate -> BLOCKED
discipline; this workflow does not re-drive a per-goal grind.
</step>

<step name="green_build_guard">
## Step 4: Verify under the green-build guard

Run the verification build and read the TOOL's real exit status -- never the tail of a pipe. Always
build under `nice -n 19 lake build`:

```bash
set -o pipefail
nice -n 19 lake build 2>&1 | tee "$ROOT/build.log"
test ${PIPESTATUS[0]} -eq 0 || echo "build red -- a proof did not close"
```

`lake build` is the STYLE authority: `lake env lean` / `--stdin` isolation does NOT run the package
style linters (`linter.style.show`, `linter.style.longLine` from `weak.linter.mathlibStandardSet`),
so a style warning surfaces only here. Reproduce it cheaply and early with `lake env lean
-Dlinter.style.show=true -Dlinter.style.longLine=true <file>`. House style uses `change` (not a
goal-altering `show`) and wraps lines to <=100 columns.
</step>

<step name="route_escalation">
## Step 5: Route the executor's ESCALATE/BLOCKED return

The `fvs-crypto-executor` owns escalation (implement -> check -> complete -> escalate -> BLOCKED);
this workflow does not enforce a per-goal attempt grind. When the executor returns ESCALATE (a
public-statement change is needed) or BLOCKED (it cannot proceed), HALT and redirect to the user (a
short interactive redirect beats a long unattended grind). On a secondary runtime that lacks an
interactive prompt, degrade to plain-text and WAIT (fail-closed).
</step>

</process>

<success_criteria>
- [ ] Topic + iteration resolved; shell metacharacters rejected; paths quoted; no `eval`.
- [ ] The bounded plan read and inlined; `fvs-crypto-executor` dispatched (`subagent_type="fvs-crypto-executor"`).
- [ ] The build runs under `set -o pipefail` + `${PIPESTATUS` reading the tool's real status; always `nice -n 19 lake build` (never a bare `lake build`).
- [ ] The executor's ESCALATE/BLOCKED return is routed to the user (short interactive redirect early, never a long unattended grind).
- [ ] No generated-Lean write; no `gh` open/create.
</success_criteria>
