<purpose>
Adversarially review an initial or follow-up FVS crypto plan before execution by handing it to an
authenticated Codex CLI running as an independent, read-only second runtime.

The reviewer returns evidence-backed findings and exactly one verdict. The FVS wrapper persists one
review artifact under `reviews/`; the primary planning seat then verifies and triages the claims.
This pre-execution review is distinct from the post-execution `crypto-eval` stage.
</purpose>

<process>

<step name="preflight_codex">
## Step 0: Preflight Codex

Before reading plan contents, require both `command -v codex` and `codex login status` to succeed.
If either fails, stop with install/sign-in/verify instructions. Never silently fall back to the
authoring runtime because that would defeat independent review.
</step>

<step name="resolve_target">
## Step 1: Resolve Topic, Iteration, and Review Target

Apply the crypto-loop path-safety rules: reject shell metacharacters, `..`, and `/`; quote paths;
never `eval`. Require the existing `.formalising/fv-plans/<topic>/` tree.

Resolve the explicit `nN` or highest numeric iteration. Target either:

- initial plan: `PLAN_nN.md` + `EXEC_PLAN_nN.md` -> `PLAN_REVIEW_nN.md`;
- follow-up: `FOLLOWUP_PLAN_nN.md` (+ matching plan/eval context) ->
  `FOLLOWUP_REVIEW_nN.md`.

Auto-select follow-up when present. Refuse an existing output rather than destroying review history.
</step>

<step name="check_independence">
## Step 2: Check Reviewer Independence

Require a truthful `Authoring runtime:` marker. Refuse a `Codex CLI` author and stop on missing
provenance. On the Codex host runtime, stop: recursive Codex review is same-runtime, not independent.
</step>

<step name="run_review">
## Step 3: Run the Read-Only Reviewer

Invoke:

```bash
node ~/.claude/scripts/fvs-codex-think.mjs review \
  --topic "$ROOT" --iteration "n$N" --target "$TARGET_KIND" --effort xhigh
```

The helper loads `fv-skills/references/crypto-plan-review.md`, runs authenticated Codex with an argv
array, no model override, xhigh effort, `--sandbox read-only`, and `--ephemeral`. Codex returns
Markdown only; the wrapper validates its single `VERDICT:` and writes exactly one review artifact.
</step>

<step name="triage">
## Step 4: Re-verify and Triage

Preserve the Codex review verbatim. Re-check each claim against its citations/probes and append a
planning-seat triage to the same artifact. Report exactly:

1. `Codex's review`
2. `What I'll do in response`
3. `What I'll deliberately NOT do`

Only APPROVE routes to `crypto-execute`. APPROVE-WITH-EDITS and REJECT stop for plan revision and a
fresh independent review.
</step>

</process>

<success_criteria>
- Codex installation and authentication verified before review work.
- Initial and follow-up plans resolve safely and preserve review history.
- Self-review and unknown provenance fail closed.
- Reviewer has read-only repository access and writes no repository file.
- Wrapper writes exactly one review artifact with one allowed verdict.
- Planning-seat triage is evidence-backed and non-APPROVE verdicts stop execution.
</success_criteria>
