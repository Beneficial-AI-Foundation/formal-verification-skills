---
name: fvs-formalise
description: paper formalisation | formalise crypto refactor
---

<pi_package_runtime>
- This skill lives under `pi/skills/<name>/SKILL.md`; the FVS package root is `../../..` relative to its directory.
- Resolve every bundled relative path against the skill directory and pass absolute paths to tool calls and shell commands.
- Agent role instructions live under `../../../agents/`. When a workflow requests Task/subagent dispatch, use an available Pi subagent facility with the matching role instructions. If none is installed, perform the role inline and state that fresh-context separation was unavailable. Exception: a review workflow that requires a fresh reviewer must remain pending or offer its documented fallback; never perform that review inline.
- Use Pi's structured question tool when available; otherwise ask the same question in plain text.
- Never write state into the managed package. Project state belongs under the user's current project (normally `.formalising/`).
</pi_package_runtime>

Route to the appropriate paper-formalisation skill based on the user's intent.

When invoked WITH a request, match it against the table below and invoke the matched skill immediately, forwarding the request. When invoked BARE (no request), print this table as plain text and let the user reply free-form.

| User wants | Invoke |
|---|---|
| Formalise a paper/topic into Lean (one-shot) | fvs:lean-formalise |
| Refactor / simplify / decompose a proof | fvs:lean-refactor |
| Start/plan a topic-based crypto formalisation iteration | fvs:crypto-plan |
| Fresh-review an initial or follow-up crypto plan | fvs:crypto-review |
| Run the current iteration's plan | fvs:crypto-execute |
| Adversarially evaluate the iteration | fvs:crypto-eval |
| Write a follow-up plan from eval findings | fvs:crypto-followup |

The crypto iteration loop is
plan -> fresh review -> execute -> eval -> follow-up -> fresh review -> repeat,
restartable from records under `fv-plans/<topic>/`. `lean-formalise` stays the one-shot paper-track
command; the loop sits beside it for topic-based, multi-iteration crypto work.

The one-shot and iterative authoring stages share the bounded, indexed learning loop under
`.formalising/proof-engineering/`. `crypto-review` remains memory-blind; only verified
cross-runtime provenance is labeled independent.

Invoke the matched skill directly using the Skill tool.
