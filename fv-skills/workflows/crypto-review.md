<purpose>
Run an initial or follow-up crypto plan through a selected fresh reviewer, then let the separate
authoring seat triage it. Reviewer evidence is immutable and proof-engineering-memory-blind.
</purpose>

<process>

<step name="select">
Resolve the safe topic, numeric iteration, and `plan|followup` target. Initial targets own
`PLAN_REVIEW_nN.md`; follow-ups own `FOLLOWUP_REVIEW_nN.md`. Refuse overwrites.

Honor `--reviewer`, `--model`, and `--effort`; otherwise ask reviewer -> model -> effort. Supplying
all three flags is the standalone non-interactive path; never replace an explicit choice. Recommend
the normalized non-author runtime first. Offer Codex `gpt-5.6-sol` / `gpt-6-astra`, Claude `fable`
/ `sonnet`, custom IDs, max-first supported efforts, and Other. Explicit same-runtime review is
allowed but labeled `same-runtime, fresh reviewer`; known different runtimes are `cross-runtime`;
missing, foreign, conflicting, and Other identity is `unverified`. Automatic callers offer a
one-run `Skip review`, recorded exactly as `Unreviewed (user skipped)`; do not auto-start crypto
execution.
</step>

<step name="review">
Invoke the helper with all choices:

```bash
node ~/.claude/scripts/fvs-codex-think.mjs review \
  --topic "$ROOT" --iteration "n$N" --target "$TARGET_KIND" \
  --reviewer "$REVIEWER" --model "$MODEL" --effort "$EFFORT"
```

Codex is ephemeral/read-only with user config ignored. Claude uses safe mode with Read/Glob/Grep
and native-sandboxed Bash, no MCP, and no persisted session. Follow the appended diagnostic
policy for scratch probes and generated Lake output paths. The reviewer never edits targets.
Every attempt's raw evidence survives validation failure. Other receives
the managed prompt packet and returns through `review-import`. Authentication, failed processes,
invalid output, stale inputs, cancelled choice, and pending handoff remain visibly unreviewed; no
silent fallback.

Never include `.formalising/proof-engineering/` or `sources/proof-engineering-context.md` in the
review prompt. Prior review/triage history is separately delimited process data, not that memory.
</step>

<step name="triage">
Preserve reviewer text byte-for-byte. The authoring seat exclusively writes separate immutable
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
