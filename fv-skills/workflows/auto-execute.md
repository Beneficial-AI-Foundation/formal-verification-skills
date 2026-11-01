<purpose>
Read the recorded auto-track state. For an agreed configured project, reconcile the current
coordinator continuation through the bounded checkpoint adapter, then report and stop.22 dispatch
and automatic stage sequencing remain unavailable; this invocation accepts no proof.
</purpose>

<process>

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

When current agreement, project memory and caller invocation context exist, follow `auto-resume.md`.
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
