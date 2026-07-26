---
name: fvs:formalise
description: "paper formalisation | formalise crypto refactor"
argument-hint: ""
allowed-tools:
  - Read
  - Skill
requires: [lean-formalise, lean-refactor, crypto-plan, crypto-review, crypto-execute, crypto-eval, crypto-followup]
---

Route to the appropriate paper-formalisation skill based on the user's intent.

When invoked WITH a request, match it against the table below and invoke the matched skill immediately, forwarding the request. When invoked BARE (no request), print this table as plain text and let the user reply free-form.

| User wants | Invoke |
|---|---|
| Formalise a paper/topic into Lean (one-shot) | fvs:lean-formalise |
| Refactor / simplify / decompose a proof | fvs:lean-refactor |
| Start/plan a topic-based crypto formalisation iteration | fvs:crypto-plan |
| Independently review an initial or follow-up crypto plan | fvs:crypto-review |
| Run the current iteration's plan | fvs:crypto-execute |
| Adversarially evaluate the iteration | fvs:crypto-eval |
| Write a follow-up plan from eval findings | fvs:crypto-followup |

The crypto iteration loop is
plan -> independent review -> execute -> eval -> follow-up -> independent review -> repeat,
restartable from records under `fv-plans/<topic>/`. `lean-formalise` stays the one-shot paper-track
command; the loop sits beside it for topic-based, multi-iteration crypto work.

Invoke the matched skill directly using the Skill tool.
