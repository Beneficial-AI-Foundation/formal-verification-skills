<purpose>
For the AO orchestrator: after the owner has merged the spec pull request, have workers prove the
statements, let FVS's build check decide what is accepted, and open the proof pull request as a draft.
The goal and the pipeline are fixed; how the workers get there is theirs to decide. Worker reports
establish no proof acceptance. Without the orchestrator, reconcile the recorded state and report.
</purpose>

<process>

## Goal

Every statement in the merged spec pull request has a Lean proof with no `sorry`, and FVS's build check
has accepted it in a fresh clean copy. The result is one draft pull request of proofs for the owner.

## Pipeline

Start only when the owner has merged the spec pull request. If it is not merged, say so and stop;
the agent never marks it ready or merges it. Once it is merged, record the merge (see "Recording the
merge and the proof pull request").

1. **Prove, one proof file per Rust item** (`formal/proofs`). The merged spec pull request holds each
   statement in a stub proof file with `sorry`; a worker replaces the `sorry` and leaves the statement
   alone. Run as many workers as the agreement allows. Complete first: get every statement proved by
   whatever works. Improve later: once everything is proved, make the proofs shorter, more robust to
   translation changes and better factored into lemmas. The statements do not change in either phase.
   A statement that turns out wrong or too weak is noted for a refactor pull request, never edited in
   a proof.
2. **Axioms.** Lean's three standard axioms are always fine, and so are the hand-written axioms that
   the statement's spec file lists. In a multi-crate run that holds only for axioms on the engine's
   allowed list (step 3): a statement that rests on an axiom about a function of another targeted
   crate does not pass, whatever its spec file lists. A proof that starts using a new axiom fails the check. The one way
   through is the owner's ruling: if the owner accepts the assumption, mark it `assumption-accepted` in
   the externals record, and put the axiom in a new file under `formal/trusted`, with the record id in
   backticks in the axiom's docstring (one axiom for each record). The axiom's type must be exactly one
   proposition, a `Prop` definition in `formal/specs/Defs` of the merged spec whose docstring cites the same
   record id in backticks; the spec pull request is where that definition is written. The docstring
   citation is how the record and its proposition are tied in this release; an explicit field on the
   record that names the proposition is the planned stronger form, for runs after this release. `native_decide` and `bv_decide` are
   fine in scratch work, but the check refuses a commit that adds one, so remove them before it runs.
3. **FVS's build check decides accepted.** It runs in a fresh clean copy of the commit, never in a
   worker's checkout. Run it on the integration tree's head, and pass the spec merge commit you
   recorded as the spec base:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/fvs-build-check.mjs" --project-root <root> --commit <SHA> --spec-base <SPEC-MERGE-SHA>
   ```

   Before it builds anything, it compares the commit with the merged spec. It does not accept, and
   no build runs, when:
   - a recalled statement (its binders, hypotheses or conclusion) differs in more than spaces and
     comments, or is removed or added;
   - the lakefile, the manifest, `lean-toolchain`, `formal/specs/Defs`, `formal/trusted` or an extraction folder (every
     crate's folder in a multi-crate extraction) changed in more than comments, docstrings and axiom
     guards (spacing and indentation count there, because Lean reads blocks from columns), or a file
     was added to them (a new Trusted file is allowed only as step 2 says), or a lakefile appeared
     below the project root;
   - a change added `sorry`, `admit`, `native_decide`, `bv_decide` (to a declaration that had none),
     or an axiom outside `formal/trusted` (an axiom is told by its name and type, so replacing one
     axiom with another is an addition);
   - a spec file, proof file or extraction file is not covered by a `lean_lib` glob of a default
     target, and no built module imports it, so Lake would never compile it.

   When the engine has written a list of allowed axioms (`fvs-auto.mjs allowed-axioms`, a multi-crate
   run), add `--allow-axioms <FILE>`. A statement then passes only if every axiom it rests on, beyond
   Lean's three, is named in the list by the full name Lean reports (read from Lean, not from the guard
   text). A name is covered only by itself: the same function under another namespace is another axiom.
   Version 2 of the file has one section for each crate with the spec files that belong to it, and holds
   a statement to the section of the crate whose spec file holds it. A spec file that no section lists is
   refused by name, and so is a file that repeats a crate, lists a spec file under two crates, or has an
   unknown key or an empty name. An axiom whose type is a proposition asserts something, so it may only
   be a hand-written axiom in `formal/trusted`, bound to its accepted record as step 2 says (or already
   in the merged spec); a proposition declared anywhere else, the extraction's included, is refused even
   when the list names it. The list names the axioms that have a legitimate record, never one about a
   function of a targeted crate. The receipt records the file's sha256, its number of names and, for
   version 2, its number of crates, so the engine can tell which list a receipt was made with.

   Each refusal names the file, the statement and the kind of change. A statement that is wrong or too
   weak is not fixed in a proof: it becomes a refactor pull request (step 5), and once the owner
   merges it and you record the merge, that merge commit is the new spec base. The check reads the
   recorded spec merge itself and refuses a `--spec-base` that differs from it.

   Then the whole project builds with warnings as errors, so any `sorry` fails, and each statement's
   guarded `#print axioms` list must still match. Every spec, proof and extraction file must also have
   produced a compiled module in that build, whether or not it holds a recall (a lakefile that does not
   build a proof file is refused, in either lakefile format). Last, a Lean program compares what each
   recalled statement rests on with the merged spec, which the check builds in a copy of its own: the
   elaborated statement and every definition, instance or abbreviation it reaches must be the same, so
   a helper, notation or instance in a proof file that changes what an unchanged statement means is
   refused. The axioms a statement rests on are read from Lean, not from the guard text: Lean's three,
   an axiom the merged spec already had, or a new axiom that is in `formal/trusted` and asserts exactly
   its record's proposition (an axiom `: False` under an accepted record is refused). If the Lean
   program cannot run, or the merged spec does not build, the commit is not accepted. The JSON result is on stdout and the report for
   people is on stderr. Read `label` from the JSON: it is `accepted (build check)`,
   `build check failed: REASON`, or `built, integrity not checked` when no spec base was given or
   recorded (a build alone is not an acceptance, and the exit status is not 0 then). The state reports
   `done` only once the proof pull request is recorded and its head has passed the check against the
   recorded spec merge (a receipt made without `--spec-base`, or against another commit, does not
   count), so record that pull request with the commit you checked, and run the check again after any
   new commit on its branch. A receipt also stops counting when an externals record that its
   acceptance relied on changes, and an acceptance from an older build check (a receipt before version
   2, or one with no Lean-level comparison) does not count either: run the check again. A check that is refused or does not finish leaves a receipt that is
   not an acceptance, so an earlier acceptance of the same commit does not stand. Do not redirect
   the receipt: the state reads it only from the build check's default location. A worker's report,
   or a green build in its own checkout, is not acceptance.
4. **Open the PROOF PR as a draft** on the project's own repository: the destination recorded in the
   agreement at `/fvs:auto-init`, never an upstream. Put in the body which statements are accepted,
   which are not and why, and what each unproved one is missing. Nothing leaves the scope silently.
   Generate the trust section of the body, never write it by hand. Once the build check has written its
   receipt for the commit, save a notes file with, for each spec file, the owner questions still open
   and each change you made to a reviewer's brief (an empty list says there is none), then run
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/fvs-auto-bundle.mjs" trust --project-root . --commit SHA --notes FILE`
   and paste its markdown unchanged (`auto-review-bundle.md`, "Pull request trust section"). If it
   exits with a refusal, fix what it names; do not write the section yourself. Do not turn a pass
   that the section shows as qualified, or as NOT STATED, into a plain pass in your own text.
   Then record it (see "Recording the merge and the proof pull request").
5. **Refactors.** A spec refactor found while proving arrives as a new draft pull request, either
   one per refactor or one cumulative pull request. The owner reviews and merges it like the first.
   Record its review rounds and the pull request as for the first, and record its merge once the owner
   merges it; until then the state warns that a spec pull request is still open.

## GitHub rule

Agents may open draft pull requests and edit a pull request body. They never post comments or reviews
on GitHub, never mark a pull request ready and never merge: only the owner comments, marks ready and
merges.

## Probes and the strict lane

No probe is needed for this pipeline. Read the `auto-execute` stage line in the profile first
(`auto-setup.md`, "Probes and stage lines", says what each line means); without `probe-lean`, proof
acceptance through the strict lane refuses, and the build check above is the route. When `probe-lean`
works, the strict lane stays available: dependency-ready proof units, serial independent acceptance and
the human review bundle, driven by `fv-skills/references/auto-transitions.md` and
`fv-skills/references/auto-review-bundle.md`. Keep the agreement's optional budget and its memory
disposition (`auto-execution.md`, `auto-resume.md`). The strict lane's human re-specification command is
not available in 3.0.0-rc3; in this pipeline a spec refactor is a new draft pull request.

## Step 1: Require Agent Orchestrator

```bash
AUTO="${CLAUDE_PLUGIN_ROOT}/scripts/fvs-auto.mjs"
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
action. On `no-state`, use `message` and `nextAction`, and stop: run `/fvs:auto-init` first. A missing
or outdated agreement is a warning to carry into the report, not a stop.

The result holds `fvs`, the folder of the installed FVS and its version. Put both in every worker's
brief, so a worker uses this install and does not search for an older one. When you only need to know
where the run stands, add `--brief`: it prints the phase, the next action, the warnings, the pending
decisions, the externals counts, `fvs` and any `overrides`, and leaves out the recorded profile.
`overrides` are decisions made after the agreement, such as a changed pull request base. They take
precedence over the agreement for this run and do not amend it. Record one with
`node "$AUTO" record-override --project-root . --key KEY --value TEXT --reason WHY`, so that a resumed
run keeps it.

## Recording the merge and the proof pull request

If the state still says the spec phase, the merge is not recorded yet. When the owner has merged the
spec pull request, read it yourself (`gh pr view` shows its merge commit), fetch the merged branch so
that commit is in the checkout, and record the merge:

```bash
node "$AUTO" record-pr --project-root . --kind spec --merged --merge-commit SHA
```

This moves the state to the proof phase. It refuses only a commit that is not in the checkout. It
warns when no open draft spec pull request was recorded, and for each spec file the owner removed or
edited in review; `node "$AUTO" spec-status --project-root .` then labels those files `pruned by owner` or
`changed by owner in review`. Prove what the owner merged: a pruned file is out of scope.

After you open the draft proof pull request, record it with the commit the build check accepted:

```bash
node "$AUTO" record-pr --project-root . --kind proof --url URL --branch BRANCH --head SHA
```

This only records the pull request; it accepts nothing. The state stays in the proof phase until a
passing build check exists for that head. After a new commit on the branch, record the new head the
same way and run the build check on it again.

## Step 3: Run the pipeline, then report

Run the pipeline above for the recorded scope, then print:

```
FVS >> AUTO-EXECUTE

State:            {recorded choices, extraction and spec pull request status, items proved, accepted and open}
Next action:      {nextAction, or the owner's review of the proof pull request}
Pending decision: {pendingDecisions, or none}
Proof PR:         {draft pull request URL, or not opened and why}
```

Without the orchestrator or the recorded state, report and stop; dispatch no worker. Only an accepted
result counts as accepted; keep provisional worker results apart from it.

</process>
