<purpose>
Run an initial or follow-up crypto plan through a selected fresh reviewer, then let the separate
authoring seat triage it. Reviewer evidence is immutable and proof-engineering-memory-blind.
</purpose>

<process>

<step name="select">
Resolve the safe topic, numeric iteration, and `plan|followup` target. Initial targets own
`PLAN_REVIEW_nN.md`; follow-ups own `FOLLOWUP_REVIEW_nN.md`. Refuse overwrites.

Declare authority stage `crypto_review` and use the canonical profile resolution and review routing
in `model-profiles.md`. Explicit flags win, then non-null saved `crypto_review` values, then the
quality opposite-runtime recommendation. Recommend Claude Code CLI for OpenAI/Codex-authored plans;
for Claude-authored plans running under Pi, prefer a fresh provider-qualified OpenAI Pi seat, then
Codex CLI. The Pi choice launches a fresh read-only Pi child with the exact selected model/effort;
it is not an Other handoff. Never route a Claude Code subscription through Pi.

Build and confirm one selection manifest with reviewer runner, provenance, exact catalog model, and
effort. Notes rebuild the manifest and require reconfirmation. Adjust once is ephemeral; Save
override changes only `crypto_review`. Missing models/unsupported efforts ask one-run/save/cancel;
unresolved noninteractive choices fail before launch. If no opposite runner is authenticated, ask
among setup/retry, fresh same-runtime review, Other handoff, one-run skip, or cancel. Record known
opposite runtimes/providers as `cross-runtime`, explicit matching runtimes as `same-runtime, fresh reviewer`,
and missing/foreign/Other identity as `unverified`; never switch silently. A skip records exactly
`Unreviewed (user skipped)` and stops without auto-starting crypto execution.
</step>

<step name="review">
Read `~/.claude/fv-skills/references/review-grounding.md`, perform the bounded source/API
scout, and save `GROUNDING_FILE` under a fresh topic `reviews/_grounding/` directory.
Invoke the helper with all choices:

```bash
node ~/.claude/scripts/fvs-codex-think.mjs review \
  --topic "$ROOT" --iteration "n$N" --target "$TARGET_KIND" \
  --reviewer "$REVIEWER" --model "$MODEL" --effort "$EFFORT" --grounding "$GROUNDING_FILE"
```

Codex is ephemeral with user config ignored: its saved scratch directory is writable while the
repository remains read-only. Claude uses safe mode with Read/Glob/Grep and native-sandboxed Bash,
no MCP, and no persisted session. Offer reviewer `pi` only when the active Pi host has a fresh-child
facility that accepts the exact provider-qualified model/per-child effort and reports the completed
child's run ID, actual model, and actual effort. Otherwise treat Pi as unavailable. The helper stops
with `PI_READY` after writing the managed packet: read its complete `prompt.md`, launch that child
with read-only source tools, and save its final Markdown response under the project. Write a JSON
dispatch receipt from the actual child result with `version: 1`, its `run_id`, `status: "complete"`,
`fresh_context: true`, `read_only: true`, reported `model` and `effort`, plus SHA-256 hashes of the
exact `packet.json` and response. Never infer receipt fields from requested values. Run
`review-import-pi --dispatch-receipt <receipt.json>` with the packet and response; the importer
requires an active Pi host and verifies provider qualification, matching model/effort, child state,
and both hashes. Missing child capability or receipt fields leave the review pending. Follow the
appended diagnostic policy for saved scratch probes and generated Lake output paths. `LEAN_NUM_THREADS` defaults to 4 and must be
a positive safe integer. The reviewer never edits targets. Every attempt's raw evidence survives
validation failure. Other receives the managed prompt packet and returns through `review-import`. Authentication, failed processes,
invalid output, stale inputs, cancelled choice, and pending handoff remain visibly unreviewed; no
silent fallback.

Never include `.formalising/proof-engineering/` or `sources/proof-engineering-context.md` in the
review prompt. Prior review/triage history is separately delimited process data, not that memory.
</step>

<step name="triage">
Read `~/.claude/fv-skills/references/review-policy.md` for FIX, DESCOPE,
DEFER-WITH-RULING, REJECT-FINDING, ASK-HUMAN and the accepted-major-reuse rule.
Preserve `validation-*/raw-response.md` byte-for-byte. If deterministic formatting normalization
is needed, keep the cleaned copy separately as `validation-*/normalized-response.md`; the sibling
README identifies both. The authoring seat exclusively writes separate immutable
`PLAN_REVIEW_nN_TRIAGE.md` or `FOLLOWUP_REVIEW_nN_TRIAGE.md`, recording finding IDs,
accept/reject/defer evidence, requested/observed provenance, pre-edit and post-edit hashes, gates,
and status.

- APPROVE -> `approved`.
- APPROVE-WITH-EDITS -> authoring seat applies accepted bounded edits, reruns plan gates, and sets
  `approved after edits`; terminal without another review (no second review).
- REJECT -> fresh authored revision and fresh review; never convert it to bounded edits.

A REJECT round passes its prior review and triage as delimited untrusted `--history`, never as
source authority or proof-engineering memory. Run at most three reviewer rounds per invocation.
At the cap, stop and print the exact standalone resume command; never auto-approve.

Failed, cancelled, pending, and unverified states never auto-start execution or crypto-execute.
</step>

</process>

<success_criteria>
- Reviewer/model/effort and Other handoff are explicit and provenance is honest.
- Reviewer is read-only; review and separate triage never overwrite history.
- Approved bounded edits are terminal after author edits plus local gates.
- REJECT alone drives a fresh review, with prior history, up to three rounds.
</success_criteria>
