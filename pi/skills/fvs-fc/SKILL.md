---
name: fvs-fc
description: formal-verification core | plan specify review verify explain refactor
---

<pi_package_runtime>
- This skill lives under `pi/skills/<name>/SKILL.md`; the FVS package root is `../../..` relative to its directory.
- Resolve every bundled relative path against the skill directory and pass absolute paths to tool calls and shell commands.
- Agent role instructions live under `../../../agents/`. When a workflow requests Task/subagent dispatch, use an available Pi subagent facility with the matching role instructions. If none is installed, perform the role inline and state that fresh-context separation was unavailable. Exception: a review workflow that requires a fresh reviewer must remain pending or offer its documented fallback; never perform that review inline.
- Use Pi's structured question tool when available; otherwise ask the same question in plain text.
- Never write state into the managed package. Project state belongs under the user's current project (normally `.formalising/`).
</pi_package_runtime>

Route to the appropriate formal-verification-core skill based on the user's intent.

`lean-specify` and `lean-verify` share the bounded, indexed learning loop under
`.formalising/proof-engineering/`; it is project memory, not a separate command.

When invoked WITH a request, match it against the table below and invoke the matched skill immediately, forwarding the request. When invoked BARE (no request), print this table as plain text and let the user reply free-form.

| User wants | Invoke |
|---|---|
| Pick next verification targets | fvs:fc-plan |
| Generate a Lean spec skeleton | fvs:lean-specify |
| Adversarially review a specification against source | fvs:lean-spec-review |
| Attempt a proof | fvs:lean-verify |
| Explain a module/function in natural language | fvs:natural-language |
| Refactor / simplify / decompose a proof | fvs:lean-refactor |
| Audit every sorry/axiom affecting a target layer (build-backed) | fvs:trust-audit |

Invoke the matched skill directly using the Skill tool.
