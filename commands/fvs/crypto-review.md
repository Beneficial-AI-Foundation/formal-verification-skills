---
name: fvs:crypto-review
description: Adversarially review a crypto plan with a chosen runtime, model, and effort
argument-hint: "<topic> [nN] [--target plan|followup] [--reviewer codex|claude|other] [--model ID] [--effort LEVEL]"
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

Honor explicit `--reviewer`, `--model`, and `--effort`. Ask only for missing choices in exactly
this order: reviewer -> model -> effort. Supplying all three flags is the standalone
non-interactive path; never replace an explicit choice.

1. Reviewer: recommend the normalized non-author runtime first. Offer `Codex`, `Claude`, and
   `Other`; a same-runtime choice is opt-in.
2. Model: Codex offers `gpt-5.6-sol` then `gpt-6-astra` and custom; Claude offers `fable` then
   `sonnet` and custom. Other requires the exact external model ID.
3. Effort: offer `max` first, then supported lower levels and `runtime-default`; offer Codex
   `ultra` only when supported. Other accepts the external provider's effort label.

Automatic callers also offer a one-run `Skip review`. Record it exactly as
`Unreviewed (user skipped)` and do not auto-start crypto execution.

## 2. Run or export the read-only review

First read `~/.claude/fv-skills/references/review-grounding.md` and complete its bounded
scout. Save a fresh inventory under this topic's `reviews/_grounding/` and set
`GROUNDING_FILE` to its project-relative path. Check the plan's `## Reuse audit`;
missing analysis belongs in reviewer findings, not a fabricated scout result.

```bash
node ~/.claude/scripts/fvs-codex-think.mjs review \
  --topic "$ROOT" --iteration "n$N" --target "$TARGET_KIND" \
  --reviewer "$REVIEWER" --model "$MODEL" --effort "$EFFORT" --grounding "$GROUNDING_FILE"
```

The shared provider machinery preflights only the selected CLI. Codex runs read-only and ephemeral
with user config ignored; Claude runs safe mode with Read/Glob/Grep and native-sandboxed Bash,
no MCP servers, and no persisted session. Read the appended diagnostic policy: the reviewer
never edits targets; scratch probes and explicitly listed generated Lake outputs are permitted.
The wrapper saves raw attempt evidence before validation and creates a
unique hash-bound packet, validates one track-valid verdict, and exclusively writes the final
review. Authentication, process, stale-input, or output failure is `failed`; never silently switch
reviewers.

For Other, the command reports `PENDING` and a managed packet. Give `prompt.md` to the selected
reviewer, save its Markdown response inside the project, then run the printed `review-import`
command with `--topic`, `--packet`, and `--response`. A pending export is not a completed review.

## 3. Triage in the authoring seat

Read `~/.claude/fv-skills/references/review-policy.md` and use its closed dispositions:
FIX, DESCOPE, DEFER-WITH-RULING, REJECT-FINDING, ASK-HUMAN. Apply its stronger rule
for accepted major reuse findings without starting another review for completed bounded edits.

Keep the raw response and recorded review byte-for-byte intact. Any wrapper-only formatting
normalization is separately inspectable under `validation-*/`; substantive omissions remain
failed reviews. Never append triage to the review. The planning seat
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
- [ ] Reviewer -> model -> effort selection honored, including explicit same-runtime and Other.
- [ ] Provenance says only cross-runtime, same-runtime fresh reviewer, or unverified as observed.
- [ ] Reviewer remained read-only and memory-blind; final response and separate triage are immutable.
- [ ] APPROVE-WITH-EDITS becomes approved after edits once author edits and local gates pass.
- [ ] REJECT alone starts a fresh review round; at most three reviews run per invocation.
- [ ] Failed/cancelled/pending/unverified states do not start execution.
</success_criteria>
