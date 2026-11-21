<purpose>
For the orchestrator session: turn the agreed scope into reviewed Lean statements, one draft pull request
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
   modules and features fixed at `/fvs:auto-init`), with the Rust file each one lives in. Read the public
   items of the in-scope Rust modules and cross-check the list against the generated Lean. There is no
   per-item confirmation. Nothing leaves the scope silently: note the items you think are out of scope
   and why, and leave the pruning to the owner in the pull request review.

   Before the first review round, list every public API case of each item: the normal result, each
   error and panic path, and each limit and overflow case, such as a running count that can pass its
   limit across several calls. Give the list to the author and to the reviewer. A reviewer who finds a
   case missing in round 3 has found it too late. A case without a statement is named in the pull
   request body, with the reason.
2. **Prepare the working branch before any author starts.** Work on a branch of the project's own
   repository; its pull request is the spec PR. Spawn each author from this branch's head: its worktree
   is made from the committed head, so it holds only what is committed. In a fresh project the extraction
   output, the patches, the Aeneas configuration and the Lake configuration are not committed, and a
   statement that imports the generated translation fails with a bad import. Commit the generated
   translation, the patches and the extraction and Lake configuration as the first commit on the branch,
   and never commit local state and caches (`.formalising/`, `.claude/`, `.lake/` and `.aeneas/`).

   Many environments cut new worker worktrees from the project's remote base branch, so a commit that
   exists only in your local checkout never reaches an author or a reviewer. Push the working branch to
   the project's own repository and make it the base new workers start from, in whatever way your
   environment sets the base of new worktrees (for example a project default branch, or a base-branch
   option of the command that creates the worktree). Push it with the FVS push command,
   `node <FVS scripts folder>/fvs-auto-push.mjs --branch fvs/<name>`, and never with `git push`; the command pushes
   a branch under the namespace recorded at init and refuses a name outside it, so name the working branch under it. The spec and proof
   pull requests use it as their base unless the agreement says otherwise.

   The build must also reach the new files. A Lake library that keeps its default roots compiles no file
   under `formal/`, so a build can finish while no spec was compiled. Widen the library's module globs
   so they cover the spec and proof folders: in `lakefile.toml`, give the `[[lean_lib]]` entry
   `globs = ["<Library>.+"]`, and if the spec and proof folders are separate module roots, add each one
   the same way. The extraction folders need the same coverage, or a built module must import them:
   the lakefile is frozen once this pull request is merged, and the build check refuses a spec, proof
   or extraction file that Lake would not compile, so a gap found later takes a spec refactor to fix.
   A Lake `path` dependency that lives in the repository is frozen the same way, folder and all, and the
   proofs may not change it, so a local package the proofs need belongs in this pull request.
   Confirm that the build really compiles a new spec file before you rely on it; the spec
   pull request carries this Lake change. A fresh worktree has no Lake
   packages. Give each worktree its own copy of the primary checkout's Lake packages folder (a
   copy-on-write clone is fast where the filesystem supports it), or fall back to `lake exe cache get`
   and a dependency build; never share one packages folder between worktrees, because concurrent builds
   would write the same package outputs. If your environment does not let you write into a
   worker's worktree, tell the worker to fetch its own packages with `lake exe cache get` and a
   dependency build. Authors have no recorded state in their worktrees, so only you
   run the engine's steps, in the project checkout, after the authors' files are on the branch.

   Spawn one author first. Check that its worktree head is the working branch head and that a new spec
   file compiles there, and only then spawn the rest.
3. **Write and review, one Rust file at a time.** An author agent writes the statements for the
   file's items, and a fresh adversarial reviewer (the chosen pair) checks them against the Rust code
   and its documentation. Is each statement faithful, strong enough to be useful, and free of
   assumptions it should prove? At most three rounds; put anything still open in the pull request body.
   Keep exact and conditional claims apart. An exact statement holds for every input. A statement
   that needs a hypothesis (a bound on the inputs, a capacity, an assumption about an external
   function) is conditional. Write them as separate statements with separate names, and label each
   one in its docstring as `exact` or `conditional` with the hypotheses it needs. Never weaken an exact
   statement into a conditional one without saying so in the pull request body.
   The reviewer is a different agent from the author, and a new reviewer reads each round. After every
   round the orchestrator records it for each spec file (see "Recording the review rounds"). A file that
   still needs changes after the third round is recorded as `blocked`, so it does not hold the pull
   request back.
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

   A gap or an assumption that a statement depends on is a `Prop` definition in `formal/specs/Defs`,
   and its docstring cites the externals record id in backticks. That citation is how the proof phase
   ties a record to the one proposition an accepted assumption may assert, so an assumption that the
   owner accepts after this pull request merged needs a merged spec refactor pull request that adds its
   `Prop` first. An explicit field on the record that names the proposition is the planned stronger
   form, for runs after this release.
5. **Open the SPEC PR as a draft** on the project's own repository: the destination recorded in the
   agreement at `/fvs:auto-init`, never an upstream. If none is recorded, ask the owner which repository
   before opening anything. Open it once the recorded status says the spec files are ready for a pull
   request; if no file passed, open it anyway and say in the body that none did, so the owner decides.
   Put in the body what each file covers, the items you left out, the axioms
   the statements rest on, the review rounds that were held, and which commit holds the generated
   translation and the Lake change. Then record the pull request (see "Recording the pull request").

   **Put the rulings in the body.** The owner should be able to rule on every claim that needs a model
   or an accepted assumption when the spec pull request is merged, before any proof starts. A claim
   needs one when it is exact and rests on the behaviour of a function the extraction leaves without
   a model: a standard-library function, a dependency function or a function left opaque. Before the
   body is written:
   1. For each statement, run `#print axioms` on the extracted functions it talks about. The proofs
      are still `sorry`, so the statement's own list says nothing, but each extraction axiom in the
      list of a function names an external function that the claim reaches.
   2. Check that each such function has a record in `externals.json`. If one has none, the extraction
      missed it: record it as open in the externals record (kind `external` or `opaque`) before you go
      on, with the externals command that `auto-seats.md` lists.
   3. Save a notes file that names, for each open record, the exact claims that need it in plain words
      (`auto-review-bundle.md`, "Pull request trust section", describes the file), and run
      `node "$HOME/.claude/scripts/fvs-auto-bundle.mjs" rulings --project-root . --notes FILE`.
      Paste its markdown into the body unchanged. It lists each open record with what it assumes, why
      it has no model, the claims that rest on it and the owner's choices: accept it as a named
      assumption, have it modelled, narrow the claim, or block it. A record with no claim named reads
      `NOT STATED`, so say which claims need it, or that none does.
   After the owner rules, record the decision in the externals record with the same command (the
   `decision` names the owner, the date and where the ruling is). Only the owner decides; never
   record a ruling yourself.
6. **Stop for the owner.** The owner reviews, prunes, marks the pull request ready and merges it.
   Once it is merged, record the merge (see "Recording the pull request"); `/fvs:auto-execute` starts
   the proofs after that.

## A statement restated with `recall`

One statement, in the two files that step 4 describes. The proof file declares it. The spec file
restates it with `recall`, which fails the build when the restatement is not the declared statement.
The guard after it names the axioms the statement rests on.

```lean
-- formal/proofs/Hmac.lean
theorem hmac_len (n : Nat) : n + 0 = n := rfl
```

```lean
-- formal/specs/Specs/Hmac.lean
import Proofs.Hmac

recall hmac_len (n : Nat) : n + 0 = n

/-- info: 'hmac_len' does not depend on any axioms -/
#guard_msgs in
#print axioms hmac_len
```

Write the module name that your Lake library gives the proof file in the `import`. From Lean 4.35,
`recall` is part of Lean and needs no import, so do not look for it in Mathlib. On Lean 4.34 and
earlier, add `import Mathlib.Tactic.Recall` to the spec file. In the spec pull request the proof is
`sorry` and the guard is left out until the proof lands.

To list the Rust functions that Aeneas translated, with a scope you choose, run
`node "$AUTO" list-items --project-root . --scope PATH[,PATH...]`. A scope is a source file, a
directory or a Rust path such as `crate::module`. It reads `translation.json` from the recorded
extraction, or from `--translation PATH`. The file records no visibility, so the list holds candidates:
check each one in the Rust source before you call it public API.

## Several crates

A repository with several crates has one target per crate. At `/fvs:auto-init` the owner decides which
crates to verify, and the agreement records the answer in `targets`: the crates to verify (by default every
crate the extraction holds) and, for each crate the owner decided not to verify, that decision in their own
words. `fvs-extract-patches.mjs crates --out OUT --release DIR` lists the crates of the patched repository, and the
order that puts each crate after the crates it depends on. A crate the
owner does not verify only has assumptions: nobody writes statements for its items, and an assumption about
one of its items needs an entry in the externals record that the owner accepted.

`read-state` reports `crates`: the target crates, the crates that are not verified, an order that puts each
crate after the crates it depends on, and any decision the owner has not recorded yet (`pendingDecisions`).
Carry the pending decisions into the report. Work crate by crate, providers first:

- List the items of one crate with `node "$AUTO" list-items --project-root . --crate NAME`. With several
  crates the command asks for `--crate`, so a list of one crate never reads as complete.
- One spec file covers one crate. The crate of an item is the first segment of its Rust path, for example
  `base_crate::module::function`. `record-spec` refuses an item of a crate the owner does not verify, an item
  of a crate the agreement names but the extraction lacks, an item Charon could not translate and a spec
  file that names items of two crates.
- A crate that calls another target crate uses that crate's real translation, not an axiom (the
  extraction is not recorded as succeeded otherwise), and its statements use the other crate's
  statements as lemmas. No statement may rest on a hand-written axiom
  that stands in for a function of another target crate that the stitching translated, or on a stale copy
  of it: prove the function in its own crate and use the result. An item a target crate could not
  translate itself, or that the run declares opaque, is a disclosed assumption that the owner accepts in
  the externals record, and statements may rest on it. An
  author may start such a statement early against the other crate's reviewed statement; the proof is
  accepted only after the other crate is accepted (`auto-execute.md`).
- `spec-status` lists each crate with its spec files, providers first, and is ready for the pull request
  only when every target crate has a reviewed pass. `record-pr` names each crate that is not ready.

## GitHub rule

Agents may open draft pull requests and edit a pull request body. They never post comments or reviews
on GitHub, never mark a pull request ready and never merge: only the owner comments, marks ready and
merges.

## Probes and the strict lane

The strict lane handles one crate in 3.0.0-rc3. For a repository with several target crates, use the pipeline
above and the build check; do not start the strict lane for any of them.

No probe is needed for this pipeline, and a missing probe never stops it. Read the `auto-top-specs`
stage line in the profile first (`auto-setup.md`, "Probes and stage lines", says what each line
means). When `probe-lean` works, the strict lane stays available as an option (in 3.0.0-rc3 it drives an
Agent Orchestrator controller and needs its `ao` CLI): a verified dependency
graph, a closure plan from `fvs-closure-plan.mjs plan`, and the bounded transition protocol in
`fv-skills/references/auto-transitions.md`. Prose agreement boundaries do not match axioms
automatically, so the orchestrator translates them once into exact Lean names and passes them with
`--allow-axioms`. A plan made without a dependency graph is degraded: it exits 9, computes no closure
and is never admissible, so plan again with `--graph` once the probes are installed.

## Step 1: Locate the engine

```bash
AUTO="$HOME/.claude/scripts/fvs-auto.mjs"
```

This command runs in the orchestrator session: the agent session of your development environment that can
start worker sessions, each in its own worktree, and message them (see `auto-seats.md`). FVS checks for no
particular environment. A session that cannot start workers reports the recorded state and stops without
writes.

## Step 2: Read the recorded state

```bash
node "$AUTO" read-state --project-root .
```

On `malformed-state` or `malformed-externals`, use `message` as the state and `nextStep` as the next
action. On `no-state`, use `message` and `nextAction`, and stop: run `/fvs:auto-init` first. A missing
or outdated agreement is a warning to carry into the report, not a stop: the owner records the
agreement in their own terminal and the spec phase does not wait for it.

The result holds `fvs`, the folder of the installed FVS and its version. Put both in every worker's
brief, so a worker uses this install and does not search for an older one. When you only need to know
where the run stands, add `--brief`: it prints the phase, the next action, the warnings, the pending
decisions, the externals counts, `fvs` and any `overrides`, and leaves out the recorded profile.
`overrides` are decisions made after the agreement, such as a changed pull request base. They take
precedence over the agreement for this run and do not amend it. Record one with
`node "$AUTO" record-override --project-root . --key KEY --value TEXT --reason WHY`, so that a resumed
run keeps it.

## Recording the review rounds

After every review round, in the project checkout and once the authors' files are on the working
branch, record the round for each spec file:

```bash
node "$AUTO" record-spec --project-root . --spec-file PATH --items ID[,ID...] --round N --verdict pass|changes|blocked --review FILE [--out-of-scope ID[,ID...]] [--commit SHA]
```

`PATH` is the spec file and `FILE` is the reviewer's report saved as a file; both are existing files
inside the project, named relative to its root. Reviewers write in their own worktrees, so copy each
report into the project checkout yourself, under `.formalising/` for example: that folder is never
committed, so the report stays out of the spec pull request. If your environment does not let you read a
reviewer's worktree, have the reviewer return the report text in its final reply and save it yourself. The IDs are the items' Rust paths without spaces, for
example `crate::module::function`, and `--out-of-scope` names the items an agent left out. The command
stores a hash of both files. A later row for the same spec file is the current one, and a round past the
third is recorded with a warning.

If the authors' files are only on a branch, add `--commit SHA`. The spec file is then read from that
commit instead of the checkout, so the checkout can stay where it is: do not check the branch out just
to record a round. The commit must be local, so fetch the branch first. `PATH` is then the file's path
inside the project, `FILE` is still read from the checkout, and the row keeps the commit. Then read
where things stand:

```bash
node "$AUTO" spec-status --project-root .
```

Add `--commit SHA` to read the spec files at a commit, such as the head of the authors' branch, when the
checkout holds none of them.

It lists each spec file with its items, round, verdict and label: `spec reviewed: pass`,
`spec reviewed: changes requested (round N)`, `spec blocked after N rounds` or
`out of scope (noted by agent)`. It says whether the file changed since its review (`stale`) and
reports `readyForPr`: at least one pass, no file still waiting for changes and nothing stale. A blocked
file does not hold the pull request back; the body names it with its label. A file that still needs
changes after the third round never becomes ready on its own, so record that round as `blocked`. When a
file is stale, have it reviewed again and record that round before opening the pull request.

## Recording the pull request

After you open the draft pull request, record it. `BRANCH` is the pull request's head branch and `SHA`
the commit at its head:

```bash
node "$AUTO" record-pr --project-root . --kind spec --url URL --branch BRANCH --head SHA
```

The step never calls GitHub and does not refuse on content; it warns when no spec file has a reviewed
pass, when the status is not ready, when `SHA` is not a commit in the checkout (fetch the pull request
branch first), and when a recorded spec file is missing from the head or differs there from the file
that was reviewed. Fix what a warning names, or name it in the pull request body. The state stays in the
spec phase, and its next action says the owner reviews and merges the pull request.

When the owner has merged it, read the pull request yourself (`gh pr view` shows its merge commit),
fetch the merged branch so that commit is in the checkout, and record the merge:

```bash
node "$AUTO" record-pr --project-root . --kind spec --merged --merge-commit SHA
```

This moves the state to the proof phase, where `/fvs:auto-execute` takes over. It refuses only a commit
that is not in the checkout. It warns when no open draft spec pull request was recorded, and for each
spec file the owner removed or edited in review; `spec-status` then labels those files `pruned by owner`
or `changed by owner in review`.

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
