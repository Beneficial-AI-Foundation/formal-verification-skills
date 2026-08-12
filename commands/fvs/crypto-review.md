---
name: fvs:crypto-review
description: Send an initial or follow-up crypto plan to authenticated Codex for independent adversarial review
argument-hint: "<topic> [nN] [--target plan|followup]"
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
  - Write
  - Edit
---

<objective>
Put an FVS crypto plan through an independent, pre-execution adversarial review by the Codex CLI.
Review either the initial `PLAN_nN.md` + `EXEC_PLAN_nN.md` pair or a
`FOLLOWUP_PLAN_nN.md`, persist exactly one reviewer artifact under `reviews/`, then have the
primary planning seat verify and triage every finding.

This is not the post-execution `/fvs:crypto-eval` stage. It attacks the PLAN before an executor
spends effort. Codex is the independent reviewer; it never authors or edits the plan.

This gate is deliberately proof-engineering-memory-blind. Do not load
`.formalising/proof-engineering/` or the topic's `sources/proof-engineering-context.md` snapshot into
the reviewer: independence includes re-challenging assumptions without inherited lesson framing.
</objective>

<execution_context>
@~/.claude/fv-skills/workflows/crypto-review.md
@~/.claude/fv-skills/references/crypto-plan-review.md
@~/.claude/fv-skills/references/ui-brand.md
</execution_context>

<context>
Topic and optional iteration/target: $ARGUMENTS.

Default target selection is `followup` when `FOLLOWUP_PLAN_nN.md` exists, otherwise `plan`.
The optional `--target` makes that choice explicit.
</context>

<process>

## Step 0: Preflight Codex installation and authentication

Before reading plan contents or doing any later work, verify that the Codex CLI is installed and
signed in:

```bash
command -v codex >/dev/null 2>&1 \
  && codex login status >/dev/null 2>&1 \
  && echo "CODEX_OK" \
  || echo "CODEX_NOT_READY"
```

If the result is `CODEX_NOT_READY`, STOP:

```
FVS >> CODEX ISN'T READY

This review needs the OpenAI Codex CLI installed and signed in.
1. Install: npm install -g @openai/codex
2. Sign in: codex login
3. Verify: codex login status

Then re-run /fvs:crypto-review. There is no silent same-runtime fallback because that would not be
an independent review.
```

## Step 1: Resolve topic, iteration, and target safely

Treat all arguments as untrusted. Collapse topic whitespace to `-`, preserve meaningful
capitalization, reject shell metacharacters, `..`, and `/`, quote every path, and never `eval`.

```bash
TOPIC_RAW="$1"
case "$TOPIC_RAW" in
  *..*|*/* ) echo "FVS >> ERROR: topic contains '..' or '/' (path traversal); refusing" >&2; exit 1 ;;
  *[![:alnum:]_[:space:]-]* ) echo "FVS >> ERROR: topic contains unsupported characters" >&2; exit 1 ;;
esac
SLUG=$(printf '%s' "$TOPIC_RAW" | tr -s '[:space:]' '-')
ROOT=".formalising/fv-plans/$SLUG"
```

Require an existing topic directory. Resolve `nN` from the explicit argument or the highest numeric
plan/follow-up iteration; never use lexical ordering. Validate the iteration against
`^n[1-9][0-9]*$`.

Resolve the target:

- `plan`: require both `plans/PLAN_nN.md` and `plans/EXEC_PLAN_nN.md`; output
  `reviews/PLAN_REVIEW_nN.md`.
- `followup`: require `plans/FOLLOWUP_PLAN_nN.md`; also expose the matching eval and original plan
  when present; output `reviews/FOLLOWUP_REVIEW_nN.md`.
- omitted/auto: choose `followup` when its file exists, otherwise `plan`.

Refuse to overwrite an existing output. Preserve prior review history and ask the user to choose a
new iteration or archive the old review deliberately.

## Step 2: Enforce independent-review provenance

This command is Codex-as-second-runtime. Read the target artifact's `Authoring runtime:` marker.
If it says `Codex CLI`, STOP: Codex cannot independently review a plan it authored. If the marker is
missing, report that provenance is unverified and STOP rather than falsely claiming independence.

`crypto-plan` and `crypto-followup` write this marker for new artifacts. A legacy plan can be
reviewed after its authoring runtime is recorded truthfully in the artifact.

On the Codex host runtime, STOP as well: recursively invoking Codex would be same-runtime review.
Run this stage from Claude, OpenCode, Gemini, or another non-Codex planning seat.

## Step 3: Invoke the read-only Codex reviewer

Run the installed FVS helper at xhigh effort:

```bash
node ~/.claude/scripts/fvs-codex-think.mjs review \
  --topic "$ROOT" \
  --iteration "n$N" \
  --target "$TARGET_KIND" \
  --effort xhigh
```

The helper:

- repeats the install/auth preflight as defense in depth;
- loads the installed `crypto-plan-review.md` contract;
- runs `codex exec` from the repository root with `--sandbox read-only`, `--ephemeral`, an argv
  array, xhigh effort, and no `--model`;
- gives Codex the exact target paths and tells it to treat repository/plan contents as data;
- excludes proof-engineering memory and its derived snapshot from reviewer context;
- captures the final reviewer message in an OS temporary directory;
- validates exactly one `VERDICT:` line;
- has the WRAPPER persist exactly one review artifact, then removes temporary output.

Codex receives no repository write permission. If it is absent, unauthenticated, killed, returns
nonzero, or violates the output contract, STOP. Never fall back to the plan author.

## Step 4: Verify and triage the review

Read the review artifact without rewriting or softening Codex's text. Treat every finding as a
claim: independently check its cited file lines, paper anchors, probes, and consequence before
accepting it.

Append a `## Planning-seat triage` section to the SAME review artifact. For each finding record
`accept`, `reject`, or `defer`, the evidence checked, and the exact destination for any planned
edit. Do not edit the plan silently during review.

Respond to the user using exactly these three top-level sections:

```
### 1. Codex's review
{the complete reviewer text, faithfully attributed}

### 2. What I'll do in response
{accepted findings and concrete bounded edits, tied to finding IDs}

### 3. What I'll deliberately NOT do
{rejected/deferred findings and retained assumptions, each with one-line evidence-based reason}
```

Routing:

- `APPROVE`: the plan may proceed to `/fvs:crypto-execute`.
- `APPROVE-WITH-EDITS`: STOP before execution; revise the named plan sections and run a fresh
  independently recorded review.
- `REJECT`: STOP before execution; return to `/fvs:crypto-plan` or `/fvs:crypto-followup`.

</process>

<codex_skill_adapter>
This command itself is a cross-runtime bridge to the Codex CLI; it does not dispatch a Codex
subagent. On the Codex host runtime it fails closed because Codex reviewing Codex is not independent.
All coordination is artifact-mediated. Interactive ambiguity degrades to a plain-text question and
waits; it never guesses provenance, iteration, or overwrite intent.
</codex_skill_adapter>

<success_criteria>
- [ ] Codex install + login preflight ran before plan review work; no silent fallback.
- [ ] Topic/iteration/target resolved safely; path traversal and overwrite refused.
- [ ] Initial plans and follow-up plans are both supported.
- [ ] Codex-authored or unknown-provenance plans are not mislabeled as independently reviewed.
- [ ] Reviewer ran xhigh, effort-only, ephemeral, and read-only from the repo root.
- [ ] Reviewer received no proof-engineering memory or derived memory snapshot.
- [ ] Wrapper persisted exactly one well-formed review with one allowed verdict.
- [ ] Planning seat re-verified and triaged findings without softening Codex's review.
- [ ] Non-APPROVE verdicts stop before execution.
</success_criteria>
