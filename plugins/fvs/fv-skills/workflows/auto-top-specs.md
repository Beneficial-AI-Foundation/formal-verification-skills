<purpose>
For the AO orchestrator: turn the agreed scope into reviewed Lean statements, one draft pull request
for the owner. The goal and the pipeline are fixed; how the agents get there is theirs to decide.
Without the orchestrator, report the recorded state and stop without writes.
</purpose>

<process>

## Goal

Every public API item in the agreed scope has a statement in Lean that an author agent wrote and a
fresh adversarial reviewer checked, and all statements sit in one draft pull request that the owner
reviews and merges. The statements are what an auditor trusts, so they matter more than the proofs.

## Pipeline

1. **List the items.** After extraction, list every public API item in the agreed scope (the crates,
   modules and features fixed at `/fvs:auto-init`), with the Rust file each one lives in. There is no
   per-item confirmation. Nothing leaves the scope silently: note the items you think are out of scope
   and why, and leave the pruning to the owner in the pull request review.
2. **Write and review, one Rust file at a time.** An author agent writes the statements for the
   file's items, and a fresh adversarial reviewer (the chosen pair) checks them against the Rust code
   and its documentation. Is each statement faithful, strong enough to be useful, and free of
   assumptions it should prove? At most three rounds; put anything still open in the pull request body.
   The reviewer is a different agent from the author, and a new reviewer reads each round.
3. **Put them where an auditor looks.** The default layout for a new project is `formal/specs/Defs`
   for the definitions the statements use and `formal/specs/Specs` with one file per Rust file. Each
   statement is restated with `recall`, followed by a guarded `#print axioms` list that names the axioms
   it rests on. Lean's three standard axioms are always fine. Hand-written axioms for code Aeneas does
   not translate go in `formal/trusted`, and the spec file lists the ones its statement uses. An existing
   project keeps its layout and follows the same split where it can. Placeholder proofs (`sorry`) are
   fine in this pull request, because proofs start only after the owner merges it.
4. **Open the SPEC PR as a draft** on the project's own repository: the destination recorded in the
   agreement at `/fvs:auto-init`, never an upstream. If none is recorded, ask the owner which repository
   before opening anything. Put in the body what each file covers, the items you left out, the axioms
   the statements rest on and the review rounds that were held.
5. **Stop for the owner.** The owner reviews, prunes, marks the pull request ready and merges it.
   `/fvs:auto-execute` starts the proofs after that.

## GitHub rule

Agents may open draft pull requests and edit a pull request body. They never post comments or reviews
on GitHub, never mark a pull request ready and never merge: only the owner comments, marks ready and
merges.

## Probes and the strict lane

No probe is needed for this pipeline, and a missing probe never stops it. Read the `auto-top-specs`
stage line in the profile first (`auto-setup.md`, "Probes and stage lines", says what each line
means). When `probe-lean` works, the strict lane stays available: a verified dependency graph, a closure
plan from `fvs-closure-plan.mjs plan`, and the bounded transition protocol in
`fv-skills/references/auto-transitions.md`. Prose agreement boundaries do not match axioms
automatically, so the orchestrator translates them once into exact Lean names and passes them with
`--allow-axioms`. A plan made without a dependency graph, or from an identity record that rests on
`translation.json` alone, is degraded: it exits 9, lists every identity item in source order, computes
no closure and is never admissible. Report the strict lane as partial with that loss, plan again with
`--graph` and a full identity record once the probes are installed, and never substitute a guess for
the missing probe output.

## Step 1: Require Agent Orchestrator

```bash
AUTO="${CLAUDE_PLUGIN_ROOT}/scripts/fvs-auto.mjs"
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
action. On `no-state`, use `message` and `nextAction`, and stop: run `/fvs:auto-init` first.

## Step 3: Run the pipeline, then report

Run the pipeline above for the recorded scope, then print:

```
FVS >> AUTO-TOP-SPECS

State:            {recorded choices, extraction status, items listed, files authored and reviewed}
Next action:      {nextAction, or the owner's review of the spec pull request}
Pending decision: {pendingDecisions, or none}
Spec PR:          {draft pull request URL, or not opened and why}
```

Without the orchestrator or the recorded state, report and stop; write nothing and dispatch no agent.

</process>
