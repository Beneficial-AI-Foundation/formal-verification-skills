---
name: fvs:crypto-review
description: Adversarially review a crypto plan with a chosen runtime, model, and effort
argument-hint: "<topic> [nN] [--target plan|followup] [--reviewer codex|claude|pi|other] [--model ID] [--effort LEVEL]"
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
  - Write
  - Edit
  - AskUserQuestion
  - Task
---

<objective>
Run a fresh, read-only adversarial review before crypto execution. The reviewer returns evidence;
the distinct planning/authoring seat owns triage and any plan edits. Preserve every review and
triage record, and never load proof-engineering memory into the reviewer.
</objective>

<execution_context>
@~/.claude/fv-skills/workflows/crypto-review.md
@~/.claude/fv-skills/references/crypto-plan-review.md
@~/.claude/fv-skills/references/model-profiles.md
@~/.claude/fv-skills/references/ui-brand.md
</execution_context>

<context>Topic, iteration, target, and reviewer options: $ARGUMENTS.</context>

<process>

## 1. Resolve target and reviewer choices

Treat arguments as untrusted. Collapse topic whitespace to `-`, preserve capitalization, reject
shell metacharacters, `..`, and `/`, quote every path, and never `eval`:

```bash
TOPIC_RAW="$1"
case "$TOPIC_RAW" in
  *..*|*/* ) echo "FVS >> ERROR: topic contains '..' or '/' (path traversal); refusing" >&2; exit 1 ;;
  *[![:alnum:]_[:space:]-]* ) echo "FVS >> ERROR: topic contains unsupported characters" >&2; exit 1 ;;
esac
SLUG=$(printf '%s' "$TOPIC_RAW" | tr -s '[:space:]' '-')
ROOT=".formalising/fv-plans/$SLUG"
```

Resolve numeric `nN` and `--target plan|followup`. Initial review consumes `PLAN_nN.md` plus
`EXEC_PLAN_nN.md` and owns `PLAN_REVIEW_nN.md`; follow-up consumes `FOLLOWUP_PLAN_nN.md` plus
available original-plan/eval context and owns `FOLLOWUP_REVIEW_nN.md`. Refuse an occupied output.

Normalize the target's `Authoring runtime:` marker to `codex`, `claude`, `other`, or `unknown`.
Missing, foreign, or conflicting markers are `unverified`; they do not block review, but never
claim independence. Label a different known runtime `cross-runtime`, an explicitly selected
matching runtime `same-runtime, fresh reviewer`, and Other `unverified`.

Declare authority stage `crypto_review` and apply `model-profiles.md`. Precedence is explicit
one-run flags, non-null `crypto_review.reviewer` / `crypto_review.model` /
`crypto_review.effort`, then the quality opposite-runtime recommendation. Null saved values keep
profile routing active.

Recommend an authenticated opposite provider/runtime from the normalized author marker:
OpenAI/Codex-authored plans use Claude Code CLI; Claude-authored plans use a fresh
provider-qualified OpenAI Pi seat when running in Pi, then Codex CLI. The Pi route launches a fresh
read-only Pi child with the exact selected provider/model; it is not an Other/manual handoff.
Unknown authors receive an explicit reviewer menu without an independence claim. Never route a
Claude Code subscription through Pi.

Build one review selection manifest containing reviewer runner, provenance, exact catalog model,
and effort. Confirm it before launch with Continue once, Adjust once, Save override, or Cancel;
retain notes. Notes rebuild the manifest and require reconfirmation. Save writes only the
`crypto_review` object. Offer every effort value the selected model/provider reports as supported;
never advertise a guessed value such as `ultra`. Missing models or unsupported efforts ask for
one-run/save/cancel; unresolved noninteractive choices fail before launch with exact remediation.

If no opposite runner is authenticated, ask among setup/retry, fresh same-runtime review, Other
handoff, one-run skip, or cancel; never switch silently. A one-run skip records exactly
`Unreviewed (user skipped)`, stops at the review boundary, and does not auto-start crypto
execution.

## 2. Run or export the read-only review

First read `~/.claude/fv-skills/references/review-grounding.md` and complete its bounded
scout. Save a fresh inventory under this topic's `reviews/_grounding/` and set
`GROUNDING_FILE` to its project-relative path. Check the plan's `## Reuse audit`;
missing analysis belongs in reviewer findings, not a fabricated scout result.

Check the signature-line budget first. This is read-only: it creates no review files and
contacts no reviewer.

```bash
node ~/.claude/scripts/fvs-codex-think.mjs review-preflight \
  --topic "$ROOT" --iteration "n$N" --target "$TARGET_KIND" --grounding "$GROUNDING_FILE"
```

It prints charged lines out of 200, with analog and `cited_apis` subtotals. Every span occurrence
is charged, including repeats; the distinct-span count is informational only. On overrun it
names the first span that crossed the limit and exits nonzero. Narrow the inventory or review
scope as `review-grounding.md` describes (never compact repeated spans) and rerun it until it
passes. Then run the review, which repeats the same check against current sources:

```bash
node ~/.claude/scripts/fvs-codex-think.mjs review \
  --topic "$ROOT" --iteration "n$N" --target "$TARGET_KIND" \
  --reviewer "$REVIEWER" --model "$MODEL" --effort "$EFFORT" --grounding "$GROUNDING_FILE"
```

The shared provider machinery preflights only the selected CLI. Codex runs ephemeral with user
config ignored: its saved scratch directory is writable while the repository remains read-only.
Claude runs safe mode with Read/Glob/Grep and native-sandboxed Bash, no MCP servers, and no
persisted session. Read the appended diagnostic policy: the reviewer never edits targets; saved
scratch probes and explicitly listed generated Lake outputs are permitted. `LEAN_NUM_THREADS`
defaults to 4, must be a positive safe integer, and is validated before launch. The wrapper saves raw
attempt evidence before validation and creates a
unique hash-bound packet, validates one track-valid verdict, and exclusively writes the final
review. Authentication, process, stale-input, or output failure is `failed`; never silently switch
reviewers.

For Pi, require an active Pi host and preflight a fresh-child facility that accepts the exact
provider-qualified model/per-child effort and reports run ID plus actual model/effort. `PI_READY`
means to dispatch that read-only child from the complete managed `prompt.md`, save its exact
response, and create the workflow's hash-bound host dispatch receipt from actual result fields.
`review-import-pi` requires that receipt and refuses missing/mismatched child evidence; never fill it
from requested values. If capability or result evidence is missing, leave the review pending.

For Other, the command reports `PENDING` and a managed packet. Give `prompt.md` to the selected
reviewer, save its Markdown response inside the project, then run the printed `review-import`
command with `--topic`, `--packet`, and `--response`. A pending export is not a completed review.

## 3. Triage in the authoring seat

Read `~/.claude/fv-skills/references/review-policy.md` and use its closed dispositions:
FIX, DESCOPE, DEFER-WITH-RULING, REJECT-FINDING, ASK-HUMAN. Apply its stronger rule
for accepted major reuse findings without starting another review for completed bounded edits.

Keep `validation-*/raw-response.md` byte-for-byte unchanged. When harmless wrapper-only formatting
is needed, `validation-*/normalized-response.md` is the separate cleaned copy used for validation;
its sibling README identifies both files. Substantive omissions remain failed reviews. Never append
triage to the review. The planning seat
re-checks every finding and exclusively writes one separate file:

- `PLAN_REVIEW_nN_TRIAGE.md`, or
- `FOLLOWUP_REVIEW_nN_TRIAGE.md`.

Record requested and observed runtime/model/effort, provenance, each finding ID with
accept/reject/defer and checked evidence, pre-edit target hashes, post-edit target hashes when
applicable, gates rerun, and one status. Refuse to overwrite either review or triage history.

Route the verdict:

- `APPROVE`: write supported triage status `approved`; execution may be suggested.
- `APPROVE-WITH-EDITS`: the authoring seat applies every accepted, exhaustively named bounded edit,
  reruns the plan's own verification gates, records accepted/rejected finding IDs plus pre-edit and
  post-edit hashes, then writes `approved after edits`. This is terminal: no second review.
- `REJECT`: bounded edits cannot promote it. The authoring seat creates a fresh authored revision
  at the next immutable iteration and a fresh review.

For a true REJECT revision, pass the preceding review and triage to the new author prompt and next
review packet as separately delimited untrusted history using repeated `--history` flags. Do not
load `.formalising/proof-engineering/` or `sources/proof-engineering-context.md` into the reviewer.

Hard cap each command invocation at at most three reviewer rounds. After the third REJECT, stop
with the latest artifacts and print the exact standalone `/fvs:crypto-review <topic> nN --target
<kind>` resume command; never auto-approve.

Failed, cancelled, pending, or unverified review states never auto-start execution or
`/fvs:crypto-execute`. Report them honestly. Standalone invocation remains usable.

</process>

<success_criteria>
- [ ] Explicit flags, saved crypto review defaults, then reviewer -> model -> effort selection honored, including explicit same-runtime and Other.
- [ ] Provenance says only cross-runtime, same-runtime fresh reviewer, or unverified as observed.
- [ ] Reviewer remained read-only and memory-blind; final response and separate triage are immutable.
- [ ] APPROVE-WITH-EDITS becomes approved after edits once author edits and local gates pass.
- [ ] REJECT alone starts a fresh review round; at most three reviews run per invocation.
- [ ] Failed/cancelled/pending/unverified states do not start execution.
</success_criteria>
