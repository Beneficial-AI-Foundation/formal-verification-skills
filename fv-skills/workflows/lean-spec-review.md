<purpose>
Review one FC specification through a fresh adversarial reviewer. The user controls runtime,
model, and effort; the orchestrator records the response and checks the findings. The shared
`fv-skills/references/fc-spec-review.md` is the canonical reviewer contract.
</purpose>

<process>

## 1. Resolve the target and choose the reviewer

Resolve the requested existing `.lean` spec, its function, Rust source, extracted Funs/Types,
interpretation definitions, relevant dependency specs, and any explicit statement of intent.
Use the paths already resolved by `lean-specify` when called automatically. Ask when the target
is ambiguous. Report absent evidence; do not invent sources or infer correctness from compilation.
For legacy specs, record author runtime as `unknown` unless the user or generation record supplies
it. The current host is not evidence of who authored an existing spec.

Declare authority stage `spec_review` and use the canonical profile resolution and review routing
in `model-profiles.md`. Explicit flags win, then non-null saved `spec_review` values, then the
quality opposite-runtime recommendation. Recommend Claude Code CLI for OpenAI/Codex-authored specs;
for Claude-authored specs running under Pi, prefer a fresh provider-qualified OpenAI Pi seat, then
Codex CLI. Never route a Claude Code subscription through Pi.

Build and confirm one selection manifest with reviewer runner, provenance, exact catalog model, and
effort. Retain the question UI's notes/custom path: notes rebuild the manifest and require
reconfirmation. Adjust once is ephemeral; Save override changes only `spec_review`. Missing models
or unsupported efforts ask one-run/save/cancel; unresolved noninteractive choices fail before
launch. If no opposite runner is authenticated, ask among setup/retry, fresh same-runtime review,
Other handoff, one-run skip, or cancel. Label same-runtime and unverified choices honestly; never
switch silently. A skip records exactly `Unreviewed (user skipped)` and stops without auto-starting
proof work.

For **Other**, ask for provider/runtime identity, model ID, and effort. Export the review packet
in Step 2 for that reviewer and import its returned response in Step 3. This route supports manual
handoff without executing arbitrary user-supplied shell commands.

## 2. Run or hand off the review

Read `~/.claude/fv-skills/references/review-grounding.md` and perform its FC scout.
Ground behavior in implementation source; inventory proposed helper lemmas and
existing project/mathlib analogs. Save the companion inventory under a fresh
`.formalising/spec-reviews/_grounding/` directory. No extra prose is required in the Lean file.

The helper uses a JSON request so paths and source contents never become shell commands. Create an
OS temporary request file with the Write tool (preserve JSON escaping):

```json
{
  "spec": "Specs/Module/Function.lean",
  "context": ["src/module.rs", "Generated/Funs.lean", "Generated/Types.lean", "Defs.lean"],
  "runtime": "codex",
  "model": "<exact catalog ID>",
  "effort": "<supported effort>",
  "author_runtime": "claude",
  "grounding": ".formalising/spec-reviews/_grounding/<unique>/inventory.json"
}
```

Use actual existing project-relative paths. Include complete relevant files, including definitions
used by the statement; do not pass only the theorem, an author summary, or proof-engineering
lessons. The reviewer must report unresolved/missing evidence as BLOCKED. `runtime` is
`codex|claude|pi|other`; `author_runtime` is `codex|claude|other|unknown`. Use `pi` only inside Pi
with an authenticated provider-qualified catalog model. Record the precise identity of Other
separately in triage. Keep the selected model/effort explicit.
If relevant dependencies were omitted, add them to the request and run a new review. PASS must
cover only the hashed evidence packet; a reviewer's additional source reads are not captured by
the original hashes. Oversized packets fail at the selected runtime's context limit rather than
being silently summarized or truncated.

Check the grounding budget read-only with the same request before running it:

```bash
node ~/.claude/scripts/fvs-spec-review.mjs preflight "$REQUEST_FILE"
```

Preflight creates no `.formalising/spec-reviews/` state, needs no Pi host or authentication, and
contacts no reviewer. It prints charged lines out of 200 with analog and `cited_apis` subtotals;
every span occurrence is charged, including repeats, and the distinct-span count is informational.
On overrun it exits nonzero and names the first span that crossed the limit. Narrow the scope per
`review-grounding.md` (never compact repeated spans) and rerun it until it passes. `run` repeats the
same check against current sources before creating the review directory:

```bash
node ~/.claude/scripts/fvs-spec-review.mjs run "$REQUEST_FILE"
```

The helper records input hashes and a complete `prompt.md` under a new
`.formalising/spec-reviews/<spec>-<unique>/` directory. It checks CLI installation/authentication,
then launches a fresh process with the selected model/effort. Codex uses an ephemeral session with
user config disabled: its saved scratch cwd is writable while the repository remains read-only.
Claude uses safe mode with Read/Glob/Grep and native-sandboxed Bash, no MCP servers, and a scratch
cwd. Offer `runtime: "pi"` only when the active Pi host has a fresh-child facility that accepts the
exact provider-qualified model and per-child effort and reports the completed child's run ID, actual
model, and actual effort. Otherwise treat Pi as unavailable and use the review fallback menu. The
helper stops with `PI_READY` after preparing the packet: read the complete `prompt.md`, launch that
fresh-context Pi child, restrict it to source reads plus bounded scratch diagnostics, and save only
its final Markdown response. Never run this branch outside Pi or inline it in the authoring seat. The appended
diagnostic policy permits small probes and necessary existing-source builds with explicit generated
output paths. `LEAN_NUM_THREADS` defaults to 4 and must be a positive safe integer. Reviewed sources
remain read-only. Each attempt's raw evidence is saved before validation. These flags are per
process; they do not change the user's runtime configuration. Use an up-to-date CLI if a flag is
unsupported.

On unavailable authentication, CLI failure, unsupported model/effort, or invalid output: show the
error and setup guidance, then let the user retry, choose a different reviewer/model/effort, or
leave the review pending. Installing/signing in is the user's action; never auto-install or
silently fall back. Claude setup: https://code.claude.com/docs/en/overview; `claude auth login`.
Codex setup: install `@openai/codex`, then `codex login`.

**Same-runtime fallback without a usable CLI:** offer a fresh read-only subagent, never the author
or its resumed session. Inline the entire `prompt.md` content in its prompt; restrict tools to
source reads. Use the user's model/effort if supported. If the host cannot honor per-call controls,
state the actual inherited/configured values and obtain a revised selection before dispatch.
Record this limitation and import the returned text through Step 3. If fresh subagents are
unavailable, use the Other handoff or leave the review pending; do not relabel self-review.

## 3. Record and triage

Read `~/.claude/fv-skills/references/review-policy.md` and use FIX, DESCOPE,
DEFER-WITH-RULING, REJECT-FINDING, ASK-HUMAN. Apply the stronger accepted-major-reuse
rule. The helper's single mechanical format pass cannot fill substantive omissions;
`validation-*/raw-response.md` remains unchanged and `normalized-response.md`, when present, is the
separate cleaned copy identified by the sibling README.

For CLI reviewers, successful execution records `review.md` beside the packet. For Other, save the
complete returned text to an OS temporary file and use `import`. For native Pi, save the exact child
response and write a host dispatch receipt from the completed child result (never from requested
values):

```json
{
  "version": 1,
  "run_id": "<actual Pi child run ID>",
  "status": "complete",
  "fresh_context": true,
  "read_only": true,
  "model": "<actual provider/model reported by Pi>",
  "effort": "<actual effort/thinking reported by Pi>",
  "packet_sha256": "<SHA-256 of exact packet.json>",
  "response_sha256": "<SHA-256 of exact response file>"
}
```

If the child facility does not report any required receipt field, leave the review pending and
choose another route; never infer it from the request. Then import:

```bash
node ~/.claude/scripts/fvs-spec-review.mjs import "$REVIEW_DIRECTORY" "$RESPONSE_FILE"       # Other
node ~/.claude/scripts/fvs-spec-review.mjs import-pi "$REVIEW_DIRECTORY" "$RESPONSE_FILE" "$DISPATCH_RECEIPT" # Pi
```

Both importers verify the packet's explicit runtime/model/effort, author/provenance, input hashes,
the response structure, and exactly one
`VERDICT: PASS | APPROVE-WITH-EDITS | REVISE | BLOCKED`. They refuse overwrites and changed inputs.
Other responses are labeled externally supplied. Pi import also requires an active Pi host, a
provider-qualified model, matching actual model/effort, a completed fresh/read-only child receipt,
and packet/response hash matches. CLI/Pi-reported settings are recorded separately from requested
settings; surface any runtime/model fallback.

Keep the raw reviewer response byte-for-byte intact. The reviewer never edits the specification. The
authoring seat (`lean-specify`) re-checks every finding and exclusively writes `triage.md` beside
`review.md`, recording finding IDs, accept/reject/defer evidence, requested versus observed
reviewer/model/effort, source coverage, and pre-edit/post-edit (old/new) hashes. Refuse to overwrite
either artifact.

Report the review path, provenance, selected model/effort, prioritized findings, accepted next
actions, and rejected/deferred findings with reasons. Keep the full reviewer response accessible
in the artifact. Distinguish the reviewer verdict from the orchestrator's disposition:

- **PASS**, supported by triage with no unresolved semantic issue: statement ready for
  `/fvs:lean-verify`; the theorem still has its original proof obligations.
- **APPROVE-WITH-EDITS:** the authoring seat applies every accepted, exhaustively named bounded
  edit, reruns the structure, style, and optional build gates, records finding IDs and old/new
  hashes, then sets `approved after edits`. This is terminal with no second review.
- **REVISE:** make a fresh substantive revision, then run another fresh review.
- **BLOCKED:** add the missing authority/evidence, then run another fresh review.
- **Failed, cancelled, disabled, or exported without a response:** report `Unreviewed`, including
  the reason. Do not claim successful adversarial verification or automatically begin proof work.

REVISE/BLOCKED cycles preserve each unique packet, `review.md`, and `triage.md`. Pass the prior
review and triage in the next request's `history` array as separately delimited untrusted process
history, never as source authority or proof-engineering memory. Run at most three reviewer rounds
per command invocation. At the cap stop with the latest artifact paths and the exact standalone
`/fvs:lean-spec-review <spec.lean>` resume command; never auto-approve.

</process>
