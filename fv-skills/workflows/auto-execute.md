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
   the statement's spec file lists. A proof that starts using a new axiom fails the check.
   `native_decide` and `bv_decide` are fine while developing a proof and are flagged by the check, so
   remove them before it runs.
3. **FVS's build check decides accepted.** It runs in a fresh clean copy of the commit, never in a
   worker's checkout. The whole project builds with warnings as errors, so any `sorry` fails, and each
   statement's guarded `#print axioms` list must still match. Run it on the integration tree's head:

   ```bash
   node "$HOME/.claude/scripts/fvs-build-check.mjs" --project-root <root> --commit <SHA>
   ```

   It prints `accepted (build check)` or `build check failed: REASON`. Read that label
   from the output. The state reports `done` only once the proof pull request is recorded and its head
   has passed the check, so record that pull request with the commit you checked, and run the check
   again after any new commit on its branch. Do not redirect the receipt: the state reads it only from
   the build check's default location. A worker's report, or a green build in its own checkout, is not
   acceptance.
4. **Open the PROOF PR as a draft** on the project's own repository: the destination recorded in the
   agreement at `/fvs:auto-init`, never an upstream. Put in the body which statements are accepted,
   which are not and why, and what each unproved one is missing. Nothing leaves the scope silently.
   Then record it (see "Recording the merge and the proof pull request").
5. **Refactors.** A spec refactor found while proving arrives as a new draft pull request, either
   one per refactor or one cumulative pull request. The owner reviews and merges it like the first.
   Record its review rounds and the pull request as for the first, and record its merge once the owner
   merges it; until then the state warns that a spec pull request is still open.

## Several crates

With several target crates the build check still builds the whole project once and writes one receipt for a
head. It also gets the list of axioms the statements may rest on beyond Lean's three standard ones. The
engine writes that list for the commit it checks, with one section for each target crate: the crate's spec
files and the axioms its statements may rest on. The check holds each statement to the section of the crate
whose spec file holds it, and refuses a statement that rests on an axiom its section does not name, or that
is in a spec file no section lists, naming the statement and the axiom:

```bash
node "$AUTO" allowed-axioms --project-root . --commit <SHA>
node "$HOME/.claude/scripts/fvs-build-check.mjs" --project-root <root> --commit <SHA> --spec-base <MERGE> \
  --allow-axioms .formalising/auto-fv/allowed-axioms.json
```

The state reports `done` only when the receipt was made with the list the engine derives from that commit
today, was made with the externals records as they are now, and also holds for every target crate. A new,
accepted or revoked externals record, or a changed Lean file, can change the list, so write it again. The
check also records the externals file it read, and a record that changed in any other way (its model, its
decision or its evidence) makes the receipt stale even when the list stays the same: run the check again
in both cases. `allowed-axioms` prints each axiom it leaves out and why.

A native-decision axiom (`native_decide` or `bv_decide`) is never in the list, and a name that only looks
native does not get in. The check judges it against the merged spec: one a statement already rested on
there is kept and flagged, a new one fails. When an accepted receipt carries flags, `read-state` shows
them as a warning on the `done` state, so the owner's review sees them.

A crate's section holds the axioms its own published Lean declares and the owner may assume, those of every
crate it depends on (a crate it is stitched to, or one its code calls, followed to the end), and the Trusted
axioms. So a statement of a crate that others use never rests on an assumption made only for a crate that
uses it.

An axiom is in a section only when its origin shows it is the owner's to assume:

- the extraction declares it for an item of another library or of a crate the owner does not verify. It
  only says that the item exists;
- the extraction declares it for an item of another target crate that the crate has no definition for, and
  the extraction's stitch lists that item as assumed;
- the extraction declares it for an item of the crate itself that was left opaque, and the owner accepted an
  externals record whose source starts with that item's path;
- a Trusted file declares it by hand, and its docstring names, in backticks, the id of an accepted externals
  record whose source names a crate path and no target crate.

Everything else stays off the list: a hand-written axiom that stands in for a function the stitching
translated, a stale copy of such a function (a crate's own copy of another target crate's function that
the stitching replaced), a Trusted axiom with no accepted record, an axiom the engine cannot place. Prove
such a function in its own crate and use that crate's theorem in the crate that calls it, or stitch the
calling crate to it. A target crate's own item that Charon or Aeneas cannot translate, or that the run
declares opaque, is different: it is a disclosed assumption, and the owner accepts it with an externals
record (the third rule above).
`read-state` shows `crates`: for each crate whether it is accepted and, when it is not, why. A crate is
accepted when:

- its recorded spec files built and hold at least one statement;
- it is stitched to every target crate it uses, so none of those calls is an axiom in its own Lean. When
  the owner's decisions change after the extraction and leave such a crate unstitched, `read-state`
  warns and the crate is not accepted: stitch it and extract again, or record the crate it uses as a
  non-target in the agreement;
- every target crate it depends on is accepted too.

A crate the extraction only assumes (a non-target) also keeps the run from being done until the owner records
the decision about it in the agreement; `pendingDecisions` names it. Nobody but the owner decides that a
crate is not verified. The same holds for a library crate of the workspace that is missing from the
extraction, and for one a patch removed from the copy.

The extraction is recorded as succeeded only for the scope the owner agreed. When the agreement names
several crates, or the workspace holds several library crates, a copy with no extraction attempt and one
with the attempt of a single crate are refused: extract every crate, then record again. A run whose crates
do not agree with its roster (each crate's package, folder and stitch providers, the order, the non-targets
and the crates a patch removed) is refused too, and so is a stitch that does not name the Lean modules it
imports and the digest of the provider's publication it was made from. A label such as an import does not
count as a stitch. In each case the reason says what to do.

That the work is a single crate is a fact the extraction records when it prepares the copy; it is never what
is left when nothing says otherwise. A copy that does not say whether it is one crate or several, such as a
workspace prepared without a release folder, is refused, and so is a recorded extraction that lacks this fact:
the state stays at the extraction until it is settled. Extracting again settles it. An extraction recorded
by an earlier FVS lacks the fact only because it was made before the scope was kept, and it can be settled
without extracting again: the workspace at the commit the extraction was made from (not the working tree,
which has moved on) is read, and when it holds exactly one library crate, the owner confirms that and it is
recorded. The release folder is the one the extraction used.

```
node "$AUTO" record-scope --project-root . --release DIR
node "$AUTO" record-scope --project-root . --release DIR --confirm
```

The first call only reports what it found and writes nothing. Run the second only after the owner agrees.
Settling rewrites the state file, and the Lean graph record binds that file's bytes, so a Lean graph record
that was already made over the earlier state is no longer bound to the settled one and the Lean run behind it
is repeated: settle the scope before that run. A build-check receipt does not bind the state file, and
settling changes none of the Lean checks it is compared with, so it is not affected. If the workspace holds
several library crates, or the scan cannot tell, the command refuses and says so: a
multi-crate extraction is needed. A run of several crates that loses a crate's row or the crate list is not
read as a smaller run; the crates stay owed until they are extracted again. A build-check receipt counts for a crate
with stitches only while the Lean checks it verified are exactly the ones the extraction recorded; after any
other change the build check runs again.

Dispatch workers providers first, in the order `crates.order` gives, and accept bottom-up, one crate at a
time. A crate that depends on another may be proved early against the other crate's reviewed statement, but
it counts as accepted only after the other crate is. An item of a crate the owner does not verify may be
assumed, with the owner's accepted entry in the externals record. A project whose extraction says it is one
crate is not affected: the receipt alone decides, and the build check runs without the list.

## GitHub rule

Agents may open draft pull requests and edit a pull request body. They never post comments or reviews
on GitHub, never mark a pull request ready and never merge: only the owner comments, marks ready and
merges.

## Probes and the strict lane

The strict lane handles one crate in 3.0.0-rc3. For a repository with several target crates, accept through
the build check as above and do not start the strict lane for any of them.

No probe is needed for this pipeline. Read the `auto-execute` stage line in the profile first
(`auto-setup.md`, "Probes and stage lines", says what each line means); without `probe-lean`, proof
acceptance through the strict lane refuses, and the build check above is the route. When `probe-lean`
works, the strict lane stays available: dependency-ready proof units, serial independent acceptance and
the human review bundle, driven by `fv-skills/references/auto-transitions.md` and
`fv-skills/references/auto-review-bundle.md`. Keep the agreement's optional budget and its memory
disposition (`auto-execution.md`, `auto-resume.md`). The strict lane's human re-specification command is
not available in 3.0.0-rc2; in this pipeline a spec refactor is a new draft pull request.

## Step 1: Require Agent Orchestrator

```bash
AUTO="$HOME/.claude/scripts/fvs-auto.mjs"
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
action. When only the recorded extraction cannot be read, the next step is to run `/fvs:auto-extract`
again: it replaces that one record, changes nothing else, and keeps the state file as it was beside it as
`state.json.<time>.bak`. On `no-state`, use `message` and `nextAction`, and stop: run `/fvs:auto-init` first. A missing
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
