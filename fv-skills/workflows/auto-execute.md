<purpose>
For the configured AO orchestrator, continue the bounded transition protocol to authoritative17
references. Otherwise reconcile the recorded state and report the standalone continuation. Worker
reports establish no proof acceptance; trusted15 remains the sole publication authority.
</purpose>

<process>

## Opt-in AO controller continuation

For a v2 project, follow `auto-execution.md`: keep its original optional budget and explicit memory
disposition. During active small proof work use cheap progress observations, diagnose around1h when
useful, and stop/reconcile the exact known scope before replacement. This is not a proof deadline.
The current source component and protocol fixtures do not qualify actual stock-AO replacement;
report unsupported known-work stop scope honestly and retain the cooperative handoff fallback.

For an actual orchestrator with a complete current controller request, execution grant and resolved
stage manifest, follow `fv-skills/references/auto-transitions.md` through the bounded proposal/effect/checkpoint loop to
the17 reference handoff. Reuse initial agreement; no routine per-round human gate or hidden provider
children. Actual live provider execution requires the concrete19 setup/permission. Missing context
stays partial. Otherwise use the standalone reconciliation/report path below; it dispatches nothing.

At an end-of-run or partial-results boundary, use `fv-skills/references/auto-review-bundle.md`
to build and verify the17 local human-review artifact. Supply the independently held full scope
inventory and current source/context references, including failed/unmapped items; the22 proposal
alone is not complete coverage evidence. Capture pending/expired/unfinished reasons without restarting
work. Bundle integrity, historical proof facts, fresh currentness and human approval are separate.
This step writes no PR, checker receipt, registry, runtime or memory state. Human re-specification
continues through the bounded route in `fv-skills/references/auto-respec.md`; it is not inferred from bundle verification.

For an actual owner request X/Y/Z, retain that payload and the original complete scope/inspect frame.
Use fresh16/20 caller requests at each boundary and independently consume the18 result before preparing
or releasing revision work. The result creates no dispatch grant: existing22 startup, paired effects,
current heads and recovery rules still apply. Run grounded specify/fresh review,14 invalidation, proof
and trusted15 checks automatically within the original limits. Keep old receipts as history; unchanged
proof text needs whatever fresh current-context checks15 requires. Finish with whole-scope checks and
a NEW17 artifact, listing unfinished items. Human review remains at the end; actual providers still need19.

## Step 1: Require Agent Orchestrator

```bash
AUTO=~/.claude/scripts/fvs-auto.mjs
command -v ao >/dev/null 2>&1 || {
  echo "FVS >> ERROR: the auto track requires the Agent Orchestrator ao CLI on PATH." >&2
  echo "Install Agent Orchestrator and put its ao CLI on PATH (see auto-setup.md), then rerun /fvs:auto-execute." >&2
  exit 1
}
```

## Step 2: Read the recorded state

```bash
node "$AUTO" read-state --project-root .
```

On `malformed-state` or `malformed-externals`, use `message` as the state and `nextStep` as the next
action. On `no-state`, use `message` and `nextAction`.

## Step 3: Reconcile an agreed configured continuation

When current agreement, the recorded memory disposition and caller invocation context exist, follow `auto-resume.md`.
Perform the mandatory canonical semantic applicability/actions check, prepare a fresh request and
run `state` with exclusive output, then `verifyReconciliation` against the independently held request.
Preserve partial reasons, reservations and original limits. The adapter may update only its runtime
history and the owned20 context; a read-only M1 invocation still reports its recorded continuation.
Missing agreement/store/association/accounting/context stops that affected route without setup,
budget reset, guessed identities or a new scope interview. This is no dispatch/publication grant.

## Step 4: Report and stop

```
FVS >> AUTO-EXECUTE

State:            {recorded choices/extraction/externals; current reconciliation or partial reasons}
Next action:      {nextAction}
Pending decision: {pendingDecisions, or none}

Automatic stage sequencing/proof dispatch: milestone 2 functionality not yet available; no proof accepted by this invocation.
See the "Auto track" section of the FVS README for what milestone 1 provides.
```

Stop after the report. Checkpoint metadata and currentness inspection establish no new proof acceptance;
keep provisional results and accepted checker receipts distinct.

</process>
