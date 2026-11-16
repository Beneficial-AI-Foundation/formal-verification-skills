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
2. **Prepare the working branch before any author starts.** Work on a branch of the project's own
   repository; its pull request is the spec PR. An author's worktree is made from the committed head, so
   it holds only what is committed. In a fresh project the extraction output, the patches, the Aeneas
   configuration and the Lake configuration are not committed, and a statement that imports the
   generated translation fails with a bad import. Commit the generated translation, the patches and the
   extraction and Lake configuration as the first commit on the branch, and never commit local state
   and caches (`.formalising/`, `.claude/` and `.lake/`).

   The build must also reach the new files. A Lake library that keeps its default roots compiles no file
   under `formal/`, so a build can finish while no spec was compiled. Widen the library's module globs so they
   cover the spec and proof folders, and confirm that the build really compiles a new spec file before
   you rely on it; the spec pull request carries this Lake change. A fresh worktree has no Lake
   packages: run `lake exe cache get` and build the dependencies there, or point the worktrees at one
   shared packages folder, whichever works with the worktrees AO makes. Authors have no recorded state
   in their worktrees, so only you run the engine's steps, in the project checkout, after the authors'
   files are on the branch.
3. **Write and review, one Rust file at a time.** An author agent writes the statements for the
   file's items, and a fresh adversarial reviewer (the chosen pair) checks them against the Rust code
   and its documentation. Is each statement faithful, strong enough to be useful, and free of
   assumptions it should prove? At most three rounds; put anything still open in the pull request body.
   The reviewer is a different agent from the author, and a new reviewer reads each round.
4. **Put them where an auditor looks.** The default layout for a new project is `formal/specs/Defs`
   for the definitions the statements use and `formal/specs/Specs` with one file per Rust file. Each
   statement is declared once, in a proof file under `formal/proofs` with a placeholder proof (`sorry`),
   and restated in its spec file with `recall`. `recall` needs the declaration to exist, so this pull
   request carries one such stub proof file per Rust item. Hand-written axioms for code Aeneas does not
   translate go in `formal/trusted`, and the spec file lists the ones its statement uses. An existing
   project keeps its layout and follows the same split where it can.

   This pull request must build, and it may warn about `sorry`; warnings as errors applies to the proof
   pull request. After each restatement goes a guarded `#print axioms` list that names the axioms the
   statement rests on, with Lean's three standard axioms always fine. Until the proofs land that list
   shows `sorryAx`, so this pull request may leave the guards out or mark them pending, and agents
   complete or update them in the proof pull request.
5. **Open the SPEC PR as a draft** on the project's own repository: the destination recorded in the
   agreement at `/fvs:auto-init`, never an upstream. If none is recorded, ask the owner which repository
   before opening anything. Put in the body what each file covers, the items you left out, the axioms
   the statements rest on, the review rounds that were held, and which commit holds the generated
   translation and the Lake change.
6. **Stop for the owner.** The owner reviews, prunes, marks the pull request ready and merges it.
   `/fvs:auto-execute` starts the proofs after that.

## GitHub rule

Agents may open draft pull requests and edit a pull request body. They never post comments or reviews
on GitHub, never mark a pull request ready and never merge: only the owner comments, marks ready and
merges.

## Probes and the strict lane

No probe is needed for this pipeline, and a missing probe never stops it. Read the `auto-top-specs`
stage line in the profile first (`auto-setup.md`, "Probes and stage lines", says what each line
means). When `probe-lean` works, the strict lane stays available as an option: a verified dependency
graph, a closure plan from `fvs-closure-plan.mjs plan`, and the bounded transition protocol in
`fv-skills/references/auto-transitions.md`. Prose agreement boundaries do not match axioms
automatically, so the orchestrator translates them once into exact Lean names and passes them with
`--allow-axioms`. A plan made without a dependency graph is degraded: it exits 9, computes no closure
and is never admissible, so plan again with `--graph` once the probes are installed.

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
action. On `no-state`, use `message` and `nextAction`, and stop: run `/fvs:auto-init` first. A missing
or outdated agreement is a warning to carry into the report, not a stop: the owner records the
agreement in their own terminal and the spec phase does not wait for it.

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
