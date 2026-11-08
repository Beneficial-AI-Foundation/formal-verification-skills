<purpose>
The AO orchestrator's master entry for the auto track: inspect tools and existing state, reuse a
current applicable initial agreement, or use `/fvs:roadmap` light/deep/reuse to settle only missing
initial scope, boundaries, conventions, layout and execution choices. Persist state only through
`scripts/fvs-auto.mjs`. A stored agreement is declared owner evidence, not proof acceptance.
</purpose>

<process>

## Step 1: Require Agent Orchestrator

```bash
AUTO=~/.claude/scripts/fvs-auto.mjs
command -v ao >/dev/null 2>&1 || {
  echo "FVS >> ERROR: the auto track requires the Agent Orchestrator ao CLI on PATH." >&2
  echo "Install Agent Orchestrator and put its ao CLI on PATH (see auto-setup.md), then rerun /fvs:auto-init." >&2
  exit 1
}
```

Stop when this fails. Agreement storage alone launches no workers; the opt-in controller continuation
below requires its actual current execution/invocation context.

## Step 2: Inspect existing state and evidence before asking anything

```bash
node "$AUTO" read-state --project-root .
```

- `no-state`: inspect the project/profile and synthesize known facts for Step 3.
- `ok`: inspect `state.choices`, extraction history and the latest `state.agreements`, if present.
  Do not ask Keep/Change or repeat an interview when the applicable agreement is current. Reuse actual
  existing owner responses/grants rather than asking for them again. Check Step 5 first; if it passes,
  proceed to Step6's recorded memory disposition and then Step7 reconciliation and Step8 report without re-interviewing. Every start/resume
  needs its own current request; enabled memory also needs the fresh prime; never reuse an old memory-ready result. Missing/stale agreement blocks continuation;
  resolve only the affected setup through Steps 3–5. When the owner requests a material change,
  show only the affected choices and use those steps.
- `malformed-state` or `malformed-externals`: print `message` and `nextStep` verbatim and stop.
  Never repair, delete or overwrite the file.

The M1 roadmap offer (`state.roadmap`, accepted/declined) is historical preference, not an agreement
or authorization. A recorded decline is not asked again as an optional offer. The M2 route still
needs its actual initial agreement. Default M1 `read-state`, `record-roadmap` and extraction semantics
remain available; the new opt-in gate does not reinterpret their existing records. The updated reader
accepts legacy files without writing; old strict binaries may refuse the optional extension. Never
strip history or downgrade state to satisfy an older binary.

## Step 3: Establish only the missing initial agreement

For a fresh project, show the compatibility profile:

```bash
node "$AUTO" profile --project-root . --format text
```

Synthesize the repository facts and applicable decisions from sources first. Use
`/fvs:roadmap .formalising/auto-fv/ROADMAP.md <the project goal>` with its existing light/deep/reuse
route. Initial scope is whatever the owner actually agrees, kept distinct from discovered roots;
there is no automatic public-API or natural-language scope classifier here. An explicit `public-api`
mode is unsupported pending separately permitted ticket11 landing: report that held branch without
retrying it. Nonpublic intent can proceed independently, without top-level specifications.

Record only missing owner choices, using the current applicable evidence for known ones:

- source revision and configuration/features (prefer an exact full commit; moving refs are not immutable);
- initial scope, boundaries, conventions and single-crate/monorepo layout;
- concurrent workers (default3), optional explicitly chosen total budget, and optional memory disposition; new v2 uses no elapsed budget and explicit disabled memory unless a backend is configured;
- actual delegated execution actions/limits and any draft-PR destination/authority, separately.

New v2 choices use `limits:{workers}`, `budget:{kind:"none"}` or an explicitly selected wall budget, and `memory:{mode:"disabled"|"beads"}`. Follow `auto-execution.md` for cancellation and small-proof progress diagnosis. There is no arbitrary per-node proof timeout. Existing v1 `nodeHours` stays inactive metadata, not enforced; retain its original finite budget unchanged. Existing resource and
spending limits are never raised or reset automatically. The initial owner scope/execution agreement
is the setup human gate. Later provisional specify/review/revise cycles are autonomous within it;
there is no per-round human contract approval. Final PR acceptance remains human. Agreement storage
does not dispatch; Step6 handles the recorded memory disposition and Step7 selects the configured controller continuation.

Write the known/answered choices to a temporary file outside the project:

```bash
node "$AUTO" init-state --project-root . --input "$CHOICES"
```

`init-state` reruns and records the profile; never copy it into state by hand. On `profile-blocked`,
show every `blocking` item's verdict, reason and next step and stop. On `invalid-input`, resolve only
the named fields. On `confirmation-required`, show every listed change. Only on an explicit yes rerun
the same command with `--confirm-overwrite`; otherwise keep the recorded state. Existing applicable
explicit confirmation may be cited; never infer it. A confirmed material choice change advances the
persistent generation when the M2 extension exists. Changing A→B→A cannot revive approval of A0.

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
`choicesGeneration` from the post-init state; absent generation means0 for the first M2 agreement.
`layout` is `single-crate` or `monorepo`. Boundaries/conventions may be explicit empty arrays; the other
text lists require at least one entry. An execution grant is null or
`{"actions":["<explicit delegated action>"],"reference":"<actual grant evidence>"}`; a draft-PR grant is
null or `{"destination":"<explicit destination>","reference":"<actual grant evidence>"}`. Null remains
ungranted; an owner-response reference, roadmap offer or passing check grants neither by inference.

Prepare the actual payload and present its exact content/version in the initial discussion. The
exported `agreementPayloadSha256` computes compact UTF-8 JSON of `{schema,schemaVersion,mode,payload}`
with recursively sorted keys, preserved array order/string bytes and no newline. For a temporary
`$AGREEMENT` envelope, compute its digest without creating an approval:

```bash
node --input-type=module - "$AUTO" "$AGREEMENT" <<'NODE'
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const { agreementPayloadSha256 } = await import(pathToFileURL(process.argv[2]).href);
console.log(agreementPayloadSha256(JSON.parse(fs.readFileSync(process.argv[3], 'utf8'))));
NODE
```

Only after reading the actual applicable response/grants associate them with that exact payload and
retain the response text/reference. Human authenticity is declared workflow evidence, not independent
authentication. The operation compares actual retained content and never treats a supplied hash alone
as approval. After writing this envelope into the existing roadmap Decisions section, pass an exact
copy as temporary input:

```bash
node "$AUTO" record-agreement --project-root . --input "$AGREEMENT"
```

A changed successor needs a greater `contextVersion` and explicit confirmation of the exact affected
agreement before `--confirm-overwrite`. History is retained. `unchanged` replays write nothing. Missing,
malformed, unknown/future/public-API mode, mismatched content or stale generation/context refuses;
show the actual reason and resolve only the affected agreement. No operation selects roots or grants
publication, launches workers, resets budgets or reinterprets `nodeHours`.

## Step 5: Mandatory stored-context gate AND semantic applicability check

```bash
node "$AUTO" read-state --project-root . --require-agreement
```

A refusal stops the M2 route; no dispatch without agreement. `agreement-required` means the M1 state
has no initial agreement. `stale-agreement` requires an explicitly approved successor for the current
choices generation; reverting values does not revive an old generation. Missing/duplicate/changed,
unknown or superseded current context and changed retained owner evidence also refuse. Malformed
state never gets repaired. Default M1 extraction records remain readable.

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

## Step 6: Apply the recorded memory disposition

For v2 disabled memory, retain the explicit disabled disposition and continue to Step7 with
`memoryRequest:null`; no backend command or substitute prime receipt is produced. For enabled Beads,
follow the existing bootstrap path below. Existing v1 records keep their original memory requirements.

Follow `auto-memory.md` after Step5's stored-context AND semantic applicability checks. Use the recorded
canonical primary control root and existing store, never worker-cwd discovery or FVS's development store.
Register it through the state operation when needed; do not initialize/migrate a missing real store:

```bash
node "$AUTO" record-memory --project-root "$PRIMARY" --input "$REGISTRATION"
```

The caller owns a fresh UUID, actual target project/session/resume identity and expected canonical
binding/context. Prepare and retain its current request before invoking a route. For a configured coordinator continuation, follow Step7/`auto-resume.md`; its `state` operation performs this fresh20 refresh and independent consumption. The standalone coordinator route remains:

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

## Step 7: Reconcile configured continuation

For a current applicable agreement and its verified enabled/disabled memory disposition, read `auto-resume.md`. Prepare the fresh
caller-owned request from actual AO/controller associations, Git inputs, existing runtime head and
accounting. Call `state`, then consume it with `verifyReconciliation` against that same independently
held request. Stop continuation on partial/missing/uncertain context with its actual reason; preserve
all reservations and original budgets. Missing invocation context is a technical partial condition,
not another scope interview. Legacy M1 reads and the standalone worker prime remain available.

When the actual AO orchestrator has the complete current execution grant, stage manifest, controller
request and original accounting, continue directly through `fv-skills/references/auto-transitions.md`. It owns the bounded
proposal/before/effect/after loop through specification, fresh review, proof and serial independent
checks to the17 reference handoff. Do not ask the owner to launch each stage. Fill operational inputs
from actual state and existing decisions; a genuinely missing capability/input is partial. Initial
scope agreement and final human PR decision remain the human gates. Actual live provider execution
requires the separately concrete19 setup/permission; fixture qualification supplies no such grant.

Use that reference's **Production driver: authorized v2 continuation** recipe: resolve its one
trusted engine and closed caller context, then use `prepareCurrentRequest`/`advanceOnce` and the
actual paired effect/after APIs. Continue extraction/discovery → `auto-top-specs` actual author and
fresh bound14 review → `auto-execute` dependency-ready proof, serial15 acceptance and17 human bundle.
Existing input/grant/profile/capability gaps remain partial; v2 or agreement storage alone enables
nothing. Keep the original run on resume and explain stale-store revisions through the finite
v2basis route. Do not ask the owner to manually launch the next stage.

Without that complete opt-in context, report the available16 continuation below and stop. Do not
infer dispatch permission from a stored agreement, remembered grant, partial result or worker verdict.

## Step 8: Report the available continuation

Use the refreshed post-init/post-record state, not the pre-init `no-state` result. Print:

```
FVS >> AUTO-INIT

State:            revision {revision} ({configuration}); scope {scope}; resources {workers} workers; budget {none | original explicitly selected deadline | literal legacy v1 budget}; extraction {not run | succeeded | failed}; agreement {missing | stale | stored-context-current, semantic check passed}
Next action:      {opt-in controller proposal/partial reason, or existing standalone extraction/reconciliation continuation}
Memory:           {explicitly disabled | unregistered | missing | stale | blocked/partial reason | memory-primed for current caller request}
Pending decision: {only affected missing initial decisions, or none}
```

Report the script's actual refusal/next step when blocked. Successful agreement storage is ticket12
slice readiness only. The configured20 adapter reports current memory-primed;16 records checkpoints and
current observations, while the opt-in controller uses the separate current22 transition protocol.
The legacy `nextAction` string may name an extraction or M2 placeholder; it is not executable authority.
Report only actual current checker receipts and whole-scope gaps. Local FVS-development Beads is not
target-project memory.

</process>
