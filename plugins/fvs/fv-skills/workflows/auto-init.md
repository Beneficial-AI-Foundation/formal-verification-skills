<purpose>
The AO orchestrator's single entry for the auto track: show the compatibility profile with every
stage's readiness up front, reuse a current applicable agreement, or settle only the missing scope,
boundaries, conventions and execution choices with a short roadmap conversation, and record the
agreement. A missing agreement is a warning, never a stop. The goal and the pipeline are fixed; how the
agents get there is theirs to decide. Persist state only through `scripts/fvs-auto.mjs`. A stored
agreement is declared owner evidence, not proof acceptance.
</purpose>

<process>

## Goal

The project's source revision, scope, execution choices and agreement are recorded, the owner knows
up front which stages have a route, and the later stages need no further owner decision until the
spec pull request. Initial scope is what the owner actually agrees: the crates, modules and features
to verify.

## Pipeline

The whole auto track, so the owner sees where this entry leads:

1. `/fvs:auto-init` records the agreement (this command).
2. `/fvs:auto-extract` extracts the recorded revision with FVS's extraction and translation patches.
3. `/fvs:auto-top-specs` lists every public API item in the agreed scope, has an author write the
   statements per Rust file and a fresh adversarial reviewer check them (at most three rounds), and
   opens the spec pull request as a draft.
4. The owner reviews the spec pull request, marks it ready and merges it.
5. `/fvs:auto-execute` has workers prove one file per Rust item, complete first and improve later.
6. FVS's build check in a fresh clean copy decides what is accepted.
7. The proof pull request follows as a draft. Spec refactors found later arrive as new draft pull requests.

## GitHub rule

Agents may open draft pull requests and edit a pull request body. They never post comments or reviews
on GitHub, never mark a pull request ready and never merge: only the owner comments, marks ready and
merges.

## Step 1: Require Agent Orchestrator

```bash
AUTO="${CLAUDE_PLUGIN_ROOT}/scripts/fvs-auto.mjs"
command -v ao >/dev/null 2>&1 || {
  echo "FVS >> ERROR: the auto track requires the Agent Orchestrator ao CLI on PATH." >&2
  echo "Install Agent Orchestrator and put its ao CLI on PATH (see auto-setup.md), then rerun /fvs:auto-init." >&2
  exit 1
}
```

Stop when this fails. Agreement storage alone launches no workers.

## Step 2: Inspect existing state and evidence before asking anything

```bash
node "$AUTO" read-state --project-root .
```

Read `phase`, `warnings` and `nextAction` from the result. Call it plainly, without the strict
stored-context flag: the steps below never call the strict lane (see the last section).

- `no-state`: inspect the project and the profile, and synthesize the known facts for Step 3.
- `ok`: inspect `state.choices`, the extraction history and the latest `state.agreements`, if present.
  Do not ask Keep/Change or repeat an interview when the applicable agreement is current. Reuse the
  owner's actual earlier responses rather than asking again. Read the recorded agreement and the
  roadmap against the current request, and when they conflict settle only that decision with the owner.
  A project that already has an agreement goes straight on to the stage `phase` names, with no
  re-interview. A missing or outdated agreement is a warning: put it in the report, resolve only the
  affected setup through Steps 3 and 4, and do not hold the stages for it. When the owner asks for a
  material change, show only the affected choices and use those steps.
- `malformed-state` or `malformed-externals`: print `message` and `nextStep` verbatim and stop.
  Never repair, delete or overwrite the file.

The roadmap offer (`state.roadmap`, accepted or declined) is a historical preference, not an agreement
or authorization. A recorded decline is not asked again as an optional offer. The updated reader
accepts older state files without writing; an older strict binary may refuse the optional extension.
Never strip history or downgrade state to satisfy an older binary.

## Step 3: Establish only the missing agreement

For a fresh project, show the compatibility profile first:

```bash
node "$AUTO" profile --project-root . --format text
```

Its `stages:` lines say up front whether each stage has a route and what is missing, so the owner
learns of a gap before answering anything (`auto-setup.md`, "Probes and stage lines", explains them).
No probe is needed for setup or extraction, and a missing probe never stops it.

Fresh rc2 setup requires the declared Aeneas and Charon executables locally even for an externally
prepared, validated extraction. A missing executable still blocks `init-state`; preserve and report
its `profile-blocked` next step. After separately authorized prerequisite setup, rerun the profile and
resume this workflow. Executable presence does not qualify a tuple or replace the bound extraction's
identity, correspondence and eligibility checks; it does not require repeating a valid extraction.
Once a recorded extraction has succeeded, a missing Aeneas or Charon is a warning, and the run goes on to the
spec phase.

Keep the conversation short. Read the repository first, then propose a default for every choice and let
the owner confirm or change it, instead of interviewing from scratch. Use
`/fvs:roadmap .formalising/auto-fv/ROADMAP.md <the project goal>` with its existing light/deep/reuse
route. The owner agrees the scope as crates, modules and features, kept distinct from discovered
roots. `auto-top-specs` lists the public API items inside that scope later. Write the scope in the
agreement's `boundaries` and `claims`; its `mode` keeps the first-release name `nonpublic-intent`,
which does not limit the scope to non-public items.

Record only the missing owner choices, using the current applicable evidence for known ones:

- source revision and configuration/features (prefer an exact full commit; moving refs are not immutable);
- the agreed scope, boundaries, conventions and single-crate/monorepo layout;
- the observer set, named once: what a caller or user of the target can see and therefore must not be
  able to tell apart after a source patch (return values, errors as callers match them, external
  effects, panic occurrence and the file and line a panic reports), and what is deliberately not observed;
- concurrent workers (default 3), an optional explicitly chosen total budget, and an optional memory
  disposition (new choices use no elapsed budget and explicitly disabled memory unless a backend is configured);
- the repository the draft pull requests go to: the project's own repository, never an upstream, and
  separately from any delegated execution actions and limits.

New choices use `limits:{workers}`, `budget:{kind:"none"}` or an explicitly selected wall budget, and
`memory:{mode:"disabled"|"beads"}`. Follow `auto-execution.md` for cancellation and small-proof progress
diagnosis. There is no arbitrary per-node proof timeout. Existing v1 `nodeHours` stays inactive metadata,
not enforced; retain its original finite budget unchanged. Existing resource and spending limits are
never raised or reset automatically. The initial owner agreement is the setup human gate. Later
provisional specify/review/revise cycles are autonomous within it;
there is no per-round human contract approval.
The owner's merge of the spec pull request is the sign-off before any proof starts.
Final PR acceptance remains human. Agreement storage does not dispatch; Step 5 hands off to the stages.

Write the known and answered choices to a temporary file outside the project:

```bash
node "$AUTO" init-state --project-root . --input "$CHOICES"
```

`init-state` reruns and records the profile; never copy it into state by hand. On `profile-blocked`,
show every `blocking` item's verdict, reason and next step and stop. On `invalid-input`, resolve only
the named fields. On `confirmation-required`, show every listed change. Only on an explicit yes rerun
the same command with `--confirm-overwrite`; otherwise keep the recorded state. Existing applicable
explicit confirmation may be cited; never infer it. A confirmed material choice change advances the
persistent generation. Changing A→B→A cannot revive approval of A0.

## Step 4: Retain the exact approved context in the existing roadmap

Use exactly one current, unindented `fvs-auto-agreement` JSON fence in the roadmap's `## Decisions`
section (a heading such as `## Decisions log` also works). No separate agreement/config store. Keep
historical versions in state and distinctly referenced historical Decisions entries using ordinary
JSON fences; never duplicate the current marker. The bounded reader recognizes active ATX Decisions
headings and ignores complete fenced examples/standalone HTML comments. Unclosed/ambiguous markup,
mixed comment/prose lines and other raw HTML blocks refuse; use ordinary prose or closed code examples.
Only the documented active unindented triple-backtick tag establishes current context. LF/CRLF are
supported. Generic roadmap invocations outside auto-init do not require this auto-specific fence.

The closed envelope is:

```json
{
  "schema": "fvs/auto-agreement",
  "schemaVersion": 2,
  "mode": "nonpublic-intent",
  "payload": {
    "choicesGeneration": 0,
    "choices": {
      "source": { "revision": "<selected revision>", "configuration": "<configuration>" },
      "scope": "<owner-agreed initial scope>",
      "limits": { "workers": 3 },
      "budget": { "kind": "none" },
      "memory": { "mode": "disabled" }
    },
    "contextVersion": 1,
    "boundaries": ["<explicit boundary>"],
    "conventions": ["<agreed convention>"],
    "layout": "single-crate",
    "claims": ["<claim to establish>"],
    "trust": ["<trust and axiom policy>"],
    "acceptance": ["<acceptance evidence and authority>"],
    "ownerReserved": ["<human final PR decision and other reserved decisions>"],
    "execution": null,
    "draftPr": null
  },
  "ownerEvidence": { "reference": "<actual response reference>", "response": "<actual owner response text>" },
  "approvedPayloadSha256": "<computed canonical approval-payload SHA-256>"
}
```

This is a schema example, **not** an owner answer, limit or grant. Copy exact normalized choices and
`choicesGeneration` from the post-init state; absent generation means 0 for the first agreement.
`layout` is `single-crate` or `monorepo`. Boundaries/conventions may be explicit empty arrays; the other
text lists require at least one entry. An execution grant is null or
`{"actions":["<explicit delegated action>"],"reference":"<actual grant evidence>"}`; a draft-PR grant is
null or `{"destination":"<the project's own repository>","reference":"<actual grant evidence>"}`. Null
remains ungranted; an owner-response reference, roadmap offer or passing check grants neither by
inference. The draft pull requests of the later stages go to that recorded destination and nowhere else.

The observer set has no payload key of its own, and none may be added. Record it as one `conventions`
entry that starts with the fixed prefix `Observer set:`, listing what is observed and, after `Not
observed:`, what is not. Name it once, here; later equivalence gates and patch reviews cite this entry
instead of defining "observable" again. A project that has no auto agreement states the same set in an
`observer-set.md` file in the target's extraction workspace directory (`<extract_workspace>/<target>/`).

Prepare the actual payload and present its exact content/version in the initial discussion. The
drafting helper `fvs-auto-agreement.mjs`, installed next to the engine, builds it: the choices, the
choices generation and the state schema version come from the recorded state, so they are never
retyped, and the digest is computed by the engine's own `agreementPayloadSha256` (compact UTF-8 JSON of
`{schema,schemaVersion,mode,payload}` with recursively sorted keys, preserved array order and string
bytes, no newline). Write the owner-visible fields to a temporary `$DRAFT` JSON file: `layout`,
`claims`, `trust`, `acceptance`, `ownerReserved`, plus `boundaries`, `conventions`, `execution` and
`draftPr` where agreed. Then draft without creating an approval:

```bash
HELPER="$(dirname "$AUTO")/fvs-auto-agreement.mjs"
node "$HELPER" --project-root . --input "$DRAFT"
```

Without `ownerEvidence` the helper prints the payload and its digest and nothing else. It checks the
payload against the engine's own record rules on a scratch copy in a temporary directory outside the
project (a project-local `TMPDIR` is skipped), so a refusal appears now, naming the field. This dry run
writes nothing in the project. Show the owner the printed payload: the owner only confirms it.

Only after reading the actual applicable response/grants associate them with that exact payload: add
the owner's reply, word for word, to `$DRAFT` as `"ownerEvidence": {"reference": "<where the reply
is>", "response": "<the reply text>"}`. Never write that reply yourself. Human authenticity is declared
workflow evidence, not independent authentication. Run the helper again with `--out "$AGREEMENT"`, a
new file it never overwrites. Choose it outside the project's `.formalising` directory (a temporary
file is fine); the helper resolves links on both the destination and the `.formalising` directory (a
linked `.formalising` or `auto-fv` counts where it really lives) and refuses a destination under
`.formalising` or among the engine scripts, so it does not create or replace the state, the externals
record or the roadmap. A new file elsewhere, even inside the project, is allowed. These checks are
static; `auto-seats.md` says what they do not cover:

```bash
node "$HELPER" --project-root . --input "$DRAFT" --out "$AGREEMENT"
```

The helper then prints the finished fence and the one command only the owner runs. Put the fence under
the roadmap's `## Decisions` as the only current fence, then ask the owner to run the printed command
in their own terminal: it is `fvs-auto.mjs record-agreement`
with `--input` the new file and `--project-root` the project. The helper never records the agreement
and never edits the roadmap or the state. The record step compares actual retained content and never
treats a supplied hash alone as approval. When the owner has run it, read the state again (Step 2);
until then the missing agreement is a warning and the stages go on. `auto-seats.md` lists which seat
(owner, orchestrator or worker) runs each engine operation: only `record-agreement` is the owner's, and
the orchestrator runs the other state-changing steps itself, such as recording the extraction and the
externals.

A changed successor needs a greater `contextVersion` and explicit confirmation of the exact affected
agreement before `--confirm-overwrite`; the helper picks the next free version, and the command it
prints carries `--confirm-overwrite` only for a successor. History is retained. `unchanged` replays write
nothing. Missing, malformed, unknown or future mode, mismatched content or stale generation/context
refuses; show the actual reason and resolve only the affected agreement. No operation selects roots or
grants publication, launches workers, resets budgets or reinterprets `nodeHours`.

## Step 5: Hand off to the stages

With a recorded agreement, or its absence reported as a warning, the pipeline above takes over and the
orchestrator does not ask the owner to launch each stage. `/fvs:auto-extract` comes next, then
`/fvs:auto-top-specs`, which ends at the draft spec pull request. Fill operational inputs from the
recorded state and existing decisions; a genuinely missing capability or input is partial, not another
scope interview. Do not infer dispatch permission from a stored agreement, a remembered grant, a partial
result or a worker verdict.

## Step 6: Report

Use the refreshed post-init or post-record state, not the pre-init `no-state` result. Print:

```
FVS >> AUTO-INIT

State:            revision {revision} ({configuration}); scope {scope}; resources {workers} workers; budget {none | original explicitly selected deadline | literal legacy v1 budget}; extraction {not run | succeeded | failed}; agreement {missing | outdated | recorded}
Next action:      {the next stage, the partial reason, or the standalone extraction continuation}
Warnings:         {the warnings from read-state, such as a missing agreement, or none}
Stages:           {the profile's stage lines, one per stage, as printed}
Draft PRs:        {the recorded destination repository | not recorded}
Memory:           {explicitly disabled | enabled: its status from the strict lane below}
Pending decision: {only affected missing initial decisions, or none}
```

Report the script's actual refusal or next step when blocked. Successful agreement storage is agreement
and scope readiness only. The engine's `nextAction` string is a suggestion, not executable authority.
Report only actual current checker receipts and whole-scope gaps.

## Optional strict lane

Everything above works without this section, and the relaxed path never calls what is in it: the
stored-context gate (`read-state` with its strict flag), the memory commands, owned work, the driver,
the review bundle and the re-specification command. Use it only when the owner wants the strict graph
lane and `probe-lean` works, or when the agreement records enabled Beads memory. The strict lane's
human re-specification is not available in 3.0.0-rc2; on the relaxed path a spec refactor is a new
draft pull request.

### Stored-context gate AND semantic applicability check

```bash
node "$AUTO" read-state --project-root . --require-agreement
```

A refusal stops the strict route; nothing on it is dispatched without an agreement. `agreement-required`
means the state has no initial agreement. `stale-agreement` requires an explicitly approved successor
for the current choices generation; reverting values does not revive an old generation.
Missing/duplicate/changed, unknown or superseded current context and changed retained owner evidence
also refuse. Malformed state never gets repaired. Earlier extraction records remain readable.

Success is narrowly `agreement.status: stored-context-current`. Before reporting **applicable**
agreement readiness or using it, read the actual referenced owner response and the current roadmap
Goal, Claims to establish, Assumptions and external boundaries, scope/conventions/layout and
Owner-reserved decisions together with non-superseded Decisions. Compare their effective intent to
the marked payload, current request and selected source/configuration. A moving revision is not a
source-identity receipt. A conflicting/missing/superseding canonical statement stops the affected
decision even if the stored gate succeeds. This mandatory workflow check cannot be replaced by an
agent approval header or a CLI hash; the CLI does not classify natural-language prose or authenticate
its author.

A material goal/claim/trust/scope/configuration change updates the explicit context/version and
reconsiders only affected decisions. Routine Status log appends outside the fence, permitted helper
contract/proof revisions and ordinary progress within the agreement do not cause new owner questions.
Never refresh approval from candidate-generated contracts. Record declared uncertainties and report
outside/unresolved discovered roots before any later dispatch; never silently add them or reduce scope.

### Memory

When the strict lane reuses a current agreement it proceeds to the recorded memory disposition below.
Every start/resume needs its own current request; enabled memory also needs the fresh prime: never
reuse an old memory-ready result.

For disabled memory, retain the explicit disabled disposition and continue with
`memoryRequest:null`; no backend command or substitute prime receipt is produced. For enabled Beads,
follow the existing bootstrap path below. Existing v1 records keep their original memory requirements.

Follow `auto-memory.md` after the stored-context AND semantic applicability checks. Use the recorded
canonical primary control root and existing store, never worker-cwd discovery or FVS's development store.
Register it through the state operation when needed; do not initialize/migrate a missing real store:

```bash
node "$AUTO" record-memory --project-root "$PRIMARY" --input "$REGISTRATION"
```

The caller owns a fresh UUID, actual target project/session/resume identity and expected canonical
binding/context. Prepare and retain its current request before invoking a route. For a resume, follow
the resume paragraph below and `auto-resume.md`; its `state` operation performs this fresh memory
refresh and independent consumption. The standalone coordinator route remains:

```bash
node "$AUTO" refresh-memory --project-root "$PRIMARY" --request "$REQUEST" --out "$MEMORY_OUT"
```

Workers on start/resume use a separate fresh `worker-readonly` request and the read-only route:

```bash
node "$AUTO" prime-memory --project-root "$PRIMARY" --request "$REQUEST" --out "$MEMORY_OUT"
```

This route rejects refresh selectors. Verify actual request-bound prime bytes through `verifyMemoryBootstrap` against the
caller's independently held request, then read/inject the text; status/hash alone or a returned request
is insufficient. Missing/stale/malformed/foreign store/context, partial output, wrong identity or drift
stops readiness with its actual reason. No automatic setup, task queue, worker launch or receipt/proof
authority is introduced. Current target IDs come from caller context, never a new owner policy interview;
if the necessary invocation context is unavailable, report that missing input and stop continuation.
The configured memory adapter reports current memory-primed; the resume coordinator records checkpoints
and current observations. Local FVS-development Beads is not target-project memory.

### Resume

On a resume, read `auto-resume.md`: prepare the fresh caller-owned request from the actual AO
associations, Git inputs and recorded accounting, call `state`, then consume it with
`verifyReconciliation` against that same independently held request. Stop on partial, missing or
uncertain context with its actual reason, and preserve all reservations and original budgets. The
strict graph lane, when `probe-lean` works, follows `fv-skills/references/auto-transitions.md`.

</process>
