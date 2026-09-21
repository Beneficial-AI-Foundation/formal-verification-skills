---
name: fvs-model-external
description: Model one external Rust stub and its bounded closure in Lean, then review, prove, build, and trust-audit it
---

<pi_package_runtime>
- This skill lives under `pi/skills/<name>/SKILL.md`; the FVS package root is `../../..` relative to its directory.
- Resolve every bundled relative path against the skill directory and pass absolute paths to tool calls and shell commands.
- Agent role instructions live under `../../../agents/`. When a workflow requests Task/subagent dispatch, use an available Pi subagent facility with the matching role instructions. If none is installed, perform the role inline and state that fresh-context separation was unavailable. Exception: a review workflow that requires a fresh reviewer must remain pending or offer its documented fallback; never perform that review inline.
- Use Pi's structured question tool when available; otherwise ask the same question in plain text.
- Never write state into the managed package. Project state belongs under the user's current project (normally `.formalising/`).
</pi_package_runtime>

<objective>
Replace one external Rust stub and only its required external-stub dependency closure with faithful,
reviewed, proved Lean models. Resolve immutable Rust source provenance first; keep candidate writes
reversible; finish only after separate model-fidelity and specification reviews, proof completion, a
green build, and a CLEAN trust audit.
</objective>

<execution_context>
@../../../fv-skills/workflows/model-external.md
@../../../fv-skills/references/external-modeling.md
@../../../fv-skills/references/model-profiles.md
@../../../fv-skills/references/review-policy.md
</execution_context>

<process>
Follow the workflow with `$ARGUMENTS`.

The public interface is intentionally small: one target external stub, an optional iteration/resume
selector, and confirmed runtime/model settings. The workflow hides locked-source resolution,
candidate journaling, independent reviews, proof execution, guarded build, and trust accounting.

Dispatch only `fvs-external-modeler` for candidate model/specification/proof writes. Do not broaden
`fvs-executor` and do not reuse `fvs-crypto-executor`. Reviewers are fresh and read-only.

Before launch, show one manifest containing the requested root stub, computed bounded closure,
authoritative Rust source identity/hash/range, exact hand-written target files, executor settings,
model-review settings, specification-review settings, and stop conditions. Continue only after the
user confirms the manifest. Unsupported settings prompt interactively or fail closed.

Never edit generated `Funs.lean`, `Types.lean`, generated templates, or a legacy generated
`FunsExternal.lean`. Unsafe Rust stops. Observable effects or nondeterministic/platform abstractions
require `HUMAN_RULING`. A failed or interrupted run restores canonical Lean and preserves its source
evidence, candidate patch, reviews, diagnostics, and result under `.formalising/model-external/`.
</process>
