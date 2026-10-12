<overview>

# Lean writer diagnostics and readiness

Strongly recommend live diagnostics AND goals between meaningful proof edits. Existing
lean-lsp-mcp is the preferred configured candidate; IDE diagnostics remain conditional. Optional
Beam is opt-in, never a shell-derived default or mandatory replacement. Preserve working owners.
Clean live feedback never replaces the final compiler/build, style or trust gates.

The preflight helper evaluates supplied evidence only; it does not enumerate tools, attest native
permissions, authenticate a call record, discover executables or qualify a backend. A user-written
JSON record, parent inventory or `ready` label cannot establish actual child access. The command
owner must obtain and validate native evidence before supplying it and before authorizing writes.

Implementation boundary: `fvs-lean-diagnostics.mjs preflight --request /absolute/request.json`
implements pure readiness policy. No executable Beam subprocess or real qualification harness is
provided by this policy seam yet. A Beam candidate requires the exact native launch/confinement
facility and separately accepted qualification below; do not advertise it as runnable from FVS.
This does not declare Beam unsupported or remove another existing, genuinely callable route.

</overview>

<diagnostics_context>

## One request, one same-writer gate

Inline this COMPLETE reference plus the request's `diagnostics_context` in the existing writer
prompt. Resolve this reference and helper beneath the installed FVS root/header, not project cwd.
Keep existing role/model/effort confirmation and requested/resolved/observed Stage settings.

Required context (unknown values are labelled with reason/source, never invented):

- `requestId`, `runtime`, exact `channel`, `role`, writing `mode`;
- canonical `root`, exact absolute `targets` (no generated-source authority inferred);
- exact `toolchain` name and resolved Lean/Lake executable paths/digests;
- `requestedBackend`, `requireLive`, `configuredCandidates`, `effectiveGrants` and actual schemas;
- `observations`: actual child ID, callable inventory, call-record source/evidence location,
  backend, exact `scope`, saved target identity, diagnostics and goals separately;
- `savedFiles`: exact paths, saved-source SHA256, accepted document version and position convention;
- independently verified `hostControls`: sandbox/write restriction evidence and safely promotable
  same-writer ownership, not a flag obtained from project config or preflight itself;
- applicable `session`: exact root/session selector, owner, generation and lifecycle;
- current status/reason/evidence location and optional request-local `fallbackAcceptance`.

Before dispatch show candidates, verified effective grants/qualified host evidence and actual
unobserved access as unknown in the EXISTING confirmed selection manifest. Never show config or
parent registration as live-ready. Do not add a second model-selection flow.

Dispatch the existing writer ONLY as a host-enforced readiness-only bootstrap: no Write/Edit, shell
write or Lean metaprogram IO may modify target sources. Omitting Write while allowing unrestricted
Bash is insufficient. Inspect its actual tool/schema inventory and make a fresh saved-target
semantic diagnostic and goal call through the selected native tools. Diagnostics errors, pending
elaboration, missing goals, transport success alone or an unowned generation do not pass.

Promote the SAME writer to its original exact source allowlist only after confirmed readiness or
warned explicit request-local compiler acceptance. Host controls, not these instructions, enforce
withholding/promotion. If current host controls cannot safely do this, STOP at the precise missing
control and offer setup/another backend/cancel; do not dispatch a source-authorized unknown writer.
A supplied preflight result is a policy disposition, never permission to write.

Policy states: `unknown`, `blocked`, `ready`, `compiler-accepted`. Diagnostics and goals are separate.
Auto considers working configured lean-lsp-mcp and actually available IDE; alternatives are user
choices, not forced replacement. Beam requires explicit selection and exact local qualification.
A different request/root/target/toolchain/runtime/channel/role/backend or owner generation invalidates
feedback and fallback consent. Backend loss revokes readiness before the next write; no automatic
recovery loop or compiler downgrade. One explicit fresh resync/recheck may resolve stale feedback;
otherwise return to the existing interactive gate. Existing attempt/review bounds do not change.

## Compiler-only choice and preferences

Offer setup, choose an actually available backend, explicitly accept degraded compiler feedback,
or cancel (at most four menu choices). Warn that compiler-only lacks live diagnostics/goals and
may cost a build per iteration. Acceptance must explicitly name THIS request/root/targets/role/
channel/toolchain after that warning. Do not persist it. Required-live requests stop without live
feedback; they have no compiler alternative. Failure of an IDE/MCP/Beam call is not fallback consent.
Saved preferences/free-test consent/prior approvals are not per-request acceptance.

Project `diagnostics` contains preferences only: `backend: auto`, `require_live: false`,
`mcp_server: lean-lsp`, `beam_path: null`. Missing settings retain defaults. Preserve unrelated keys;
malformed/unknown values fail before dispatch. No saved availability, qualification or compiler
approval. Setup/profile/extension/agent-definition edits need exact preview and separate consent;
never invoke an installing uvx/elan/toolchain shim as a readiness check.

</diagnostics_context>

<backend_contracts>

## Exact native semantics and setup

- Existing lean-lsp-mcp: official source f00f625810d183dbb597a3677d2d5a83b084f761, version0.31.0,
  Python>=3.10. Diagnostic, goal, outline and hover names are runtime/server-qualified and must
  actually be exposed to the child; parent config is only a candidate. Positions are one-based.
  Partial diagnostics, `still_elaborating` or `no_goal_at_position` are not a completed proof.
  Reuse a qualified installed absolute server executable. New package installation remains a
  separate legitimacy/consent gate: https://pypi.org/project/lean-lsp-mcp/0.31.0/ . Do not upgrade
  system Python, install latest or modify normal profiles implicitly.
- Conditional IDE: `mcp__ide__getDiagnostics` only when the actual child can call it. It is NOT a
  goal tool without actual schema/result evidence. Never infer an IDE connection in a terminal.
- Optional Beam: official https://github.com/leanprover/lean-beam/tree/6511cd96917d74cf59e03e303c69e2b6785aba78 .
  Public CLI only, pinned source6511cd96917d74cf59e03e303c69e2b6785aba78. Saved-file positions are
  zero-based UTF-16; `sync FILE +all-diagnostics` returns a document version for `goals before/after`
  or bounded non-editing `run-at`. Check process status AND semantic JSON, including diagnostic
  errors/readiness and completed elaboration. A successful transport can contain Lean errors.
  Match source hash/version/root/session exactly; never guess versions. No save/checkpoint,
  recovery/prune, MCP registration, custom toolchain, dependency or pin change through this seam.

Before ANY real Beam/Lean-loading operation qualify the owned scope, exact installed wrapper/runtime/
Lean/Lake/downstream elan, clean pinned source/binary digests, exact prebuilt bundle/toolchain/
platform, writable HOME/cache/tool homes, network denial and native OS sandbox. Root selection,
readOnlyHint, a top-level environment or handwritten ready/confinement booleans are not enforcement.
Missing exact bundle must stop before a hidden build/install/download. Research Lean4.33.1 does
not qualify a consumer's Lean4.31.0 or a native writer. Use existing artifacts before setup.

The qualification operation requires ONE simultaneous Lean compiler process, at most TWO threads
per compiler and nice19 throughout descendants including a setsid daemon/server/file workers.
Use only an actually proven existing host facility; no guessed Lake jobs/global setting/shim.
Withhold source writes during readiness, then promote only through verified native controls.

Every public Beam call must repeat the same absolute --root and --session-dir. Own one foreground
serve lifetime in the existing bounded host subprocess/session facility, with private0700 state,
redacted bounded output and deadlines. Bind selector/generation before attaching/stopping; never
kill/recover a pre-existing or unrelated owner. Stop/reap the owned lifetime before the authoritative
final compiler/build. Cancellation/denied startup/timeout/lost owner must revoke readiness and leave
an actionable fenced failure, not fake successful cleanup. Preserve unrelated IDE/LSP services.
Coexistence is unqualified until actually demonstrated on one canonical root/toolchain with separate
permitted owners, fresh saved-file feedback and cleanup preserving the other route.

</backend_contracts>

<evidence_and_completion>

Native route claims require actual exact host/version/channel/role/tools/schema/permissions, enforced
readiness-only bootstrap, semantic negative/positive diagnostic AND goal calls, saved-file/version/
root rejection, ownership/cancellation/reaping and final compiler failure/success. Pure policy,
converter/mock/schema tests and a free CLI-only harness do not prove native FVS child capability.
Missing evidence remains unknown/blocked at its precise checkpoint, not unsupported or parity.

Record diagnostics disposition in existing Stage settings/run report: requested backend, configured
candidates/grants, independently observed actual calls or unknown, source hashes/versions, owner,
readiness/fallback warning and scoped acceptance. Preserve existing reviewer/triage/approval and
whole-unit/statement/write ownership. Final guarded compiler/build exit status and style/trust
checks remain authoritative even when live feedback is green. No intentional scaffold is promoted
to a completed proof. No automatic upload, provider call, installation or profile edit.

</evidence_and_completion>
