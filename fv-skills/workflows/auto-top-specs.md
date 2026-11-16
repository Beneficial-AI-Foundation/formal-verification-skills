<purpose>
For the configured AO orchestrator, advance nonpublic specification and fresh review through the
bounded transition protocol. Otherwise explain the recorded state and stop without writes. Public
API discovery is separately held; graph roots do not select scope automatically.
</purpose>

<process>

## Opt-in AO controller continuation

With the actual orchestrator's current controller request, execution grant and complete stage
manifest, use the **Production driver: authorized v2 continuation** recipe in
`fv-skills/references/auto-transitions.md`, then perform these steps. Start without
owner-supplied specs; ground selected nonpublic obligations in the actual closure and agreed scope,
never a public-name classifier. The controller resumes proof through auto-execute after readiness.
Missing capability/context is partial; actual providers require separately granted concrete setup/permission.
Without this context retain the standalone read-only report below.

1. Read the current applicable agreement and original source/configuration, roles, memory and
   execution authority. V2 alone is insufficient. Resolve the one trusted engine path from this
   context; installed workflow copies are not independent checker authorities.
2. If extraction/discovery is missing, continue the existing shared auto-extract/repair, discovery and dependency-record
   producers under those grants. Run `fvs-closure-plan.mjs plan --identity ... --graph ... --roots ...`
   for the actual same-extraction IDs corresponding to the agreed targets. Retain the full
   applicability/omission inventory and all unsupported groups; no name-only or public-API classifier.
   **Probes unavailable.** No probe is needed for setup or extraction, but this stage needs them
   all (see `auto-setup.md`). Read the `auto-top-specs` stage line of the profile first: `no route`
   names what is missing and who supplies it. The plan command still records the loss. Run without
   `--graph` when no dependency graph can be built. A plan made without a graph, or from an identity
   record that rests on `translation.json` alone, is degraded and exits 9 (a blocked identity record
   exits 7 instead). It lists every identity item in source order, computes no closure, puts a
   `closure-not-computed` blocker on each requested root, and a `degraded` field names what was lost.
   A degraded plan is never admissible, so the contract registry refuses it and no review or proof
   work can start from it. Report the stage as partial with that loss, and plan again with `--graph`
   and a full identity record once the probes are installed. Do not substitute a graph, a closure or
   a public-name guess for the missing probe output.
3. Prepare fresh requests through `prepareCurrentRequest`. Use `advanceOnce` for ordinary proposals.
   For an existing executable effect, call `runPairedEffect` directly with its concrete before
   request and retained v2 basis when needed; it records its own before exactly once. Use
   `advanceOnce`'s concrete-before route for externally managed construction/composition/resolution,
   then the existing producer procedure. Finish each route with actual `recordAfter` evidence.
4. For author work, launch the actual selected `fc_spec` actor, or sequential `research` then
   `fc_spec` when tuples differ. Merge only its explicitly granted actor gate profile, publish the
   permission-ready notice, verify startup, prepare/release the exact `lean-specify/controller-direct`
   (or split direct) packet and wait for conclusive results. Preserve all branches/drafts. Compose
   only the checked allowed paths/content, with one owner for each shared helper.
5. Export a grounded Other review packet in the actual integration/spec root. Before reviewer
   dispatch, call `prepareReviewBinding` with the canonical primary `projectRoot` and the explicit
   current `{kind:"git",root,commit,expectedTree}` source identity;
   include the returned binding/input in the actual fresh review packet. After the read-only reviewer
   returns, call `importReviewedContract` with its exact response/start/session/settings evidence.
   Its sealed response and actual imported normalized artifact determine the verdict; response
   substitution or a different integration source remains held.
   A packet export is not a review, and Other import alone is not the contract registry's candidate/head envelope.
6. Publish the fresh envelope through the existing paired registry register/revise action. Clean PASS may
   establish machine readiness only. Changes/blocked evidence returns to the grounded author loop;
   changed semantics invalidate consumers. Serialize review preparation/publication because every registry
   append stales unused review. Keep the original run/grants; no routine owner approval or weakened
   contracts. At three rounds checkpoint/resume with the actual reasons.
7. Continue directly into `auto-execute`'s authorized proof loop when registry contexts are ready. Missing
   capability or unsupported target remains partial while independent supported families continue.
   Initial material scope changes and final human review retain their separate authority.

After this authorized branch, report actual current spec/review/registry references and pending
items. Do not fall through to the legacy unavailable message. If authority/context is absent, the
standalone path below remains read-only and performs no partial authoring or dispatch.

## Step 1: Require Agent Orchestrator

```bash
AUTO="$HOME/.claude/scripts/fvs-auto.mjs"
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

Stop here on the legacy/read-only path; it selects nothing and dispatches no actor.

</process>
