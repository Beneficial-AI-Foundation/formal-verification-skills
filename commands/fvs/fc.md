---
name: fvs:fc
description: "formal-verification core | plan specify verify explain refactor"
argument-hint: ""
allowed-tools:
  - Read
  - Skill
requires: [fc-plan, lean-specify, lean-verify, natural-language, lean-refactor, trust-audit]
---

Route to the appropriate formal-verification-core skill based on the user's intent.

When invoked WITH a request, match it against the table below and invoke the matched skill immediately, forwarding the request. When invoked BARE (no request), print this table as plain text and let the user reply free-form.

| User wants | Invoke |
|---|---|
| Pick next verification targets | fvs:fc-plan |
| Generate a Lean spec skeleton | fvs:lean-specify |
| Attempt a proof | fvs:lean-verify |
| Explain a module/function in natural language | fvs:natural-language |
| Refactor / simplify / decompose a proof | fvs:lean-refactor |
| Audit every sorry/axiom affecting a target layer (build-backed) | fvs:trust-audit |

Invoke the matched skill directly using the Skill tool.
