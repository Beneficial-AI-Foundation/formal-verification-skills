<purpose>
For the configured AO orchestrator, advance nonpublic specification and fresh review through the
bounded transition protocol. Otherwise explain the recorded state and stop without writes. Public
API discovery is separately held; graph roots do not select scope automatically.
</purpose>

<process>

## Opt-in AO controller continuation

With the actual orchestrator's current controller request, execution grant and complete stage
manifest, follow the author/fresh-review/registry portion of `fv-skills/references/auto-transitions.md`. Start without
owner-supplied specs; ground selected nonpublic obligations in actual13 closure and agreed scope,
never a public-name classifier. The controller resumes proof through auto-execute after readiness.
Missing capability/context is partial; actual providers require the concrete19 setup/permission.
Without this context retain the standalone read-only report below.

## Step 1: Require Agent Orchestrator

```bash
AUTO=${CLAUDE_PLUGIN_ROOT}/scripts/fvs-auto.mjs
command -v ao >/dev/null 2>&1 || {
  echo "FVS >> ERROR: the auto track requires the Agent Orchestrator ao CLI on PATH." >&2
  echo "Install Agent Orchestrator and put its ao CLI on PATH (see auto-setup.md), then rerun /fvs:auto-top-specs." >&2
  exit 1
}
```

## Step 2: Read the recorded state

```bash
node "$AUTO" read-state --project-root .
```

On `malformed-state` or `malformed-externals`, use `message` as the state and `nextStep` as the next
action. On `no-state`, use `message` and `nextAction`.

## Step 3: Report and stop

```
FVS >> AUTO-TOP-SPECS

State:            {recorded choices, extraction status and externals counts, or the reason above}
Next action:      {nextAction}
Pending decision: {pendingDecisions, or none}

Root selection and top-level specifications: milestone 2 functionality not yet available.
See the "Auto track" section of the FVS README for what milestone 1 provides.
```

Stop here. Do not select roots, draft specifications or start any other command.

</process>
