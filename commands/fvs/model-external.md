---
name: fvs:model-external
description: Model one external Rust stub and its bounded closure in Lean, then review, prove, build, and trust-audit it
argument-hint: "<external-stub> [--iteration nN] [--resume ARTIFACT_DIR]"
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
  - Write
  - AskUserQuestion
  - Task
---

<objective>
Replace one external Rust stub and only its required external-stub dependency closure with faithful,
reviewed, proved Lean models. Resolve immutable Rust source provenance first; keep candidate writes
reversible; finish only after separate model-fidelity and specification reviews, proof completion, a
green build, and a CLEAN trust audit.
</objective>

<execution_context>
@~/.claude/fv-skills/workflows/model-external.md
@~/.claude/fv-skills/references/external-modeling.md
@~/.claude/fv-skills/references/model-profiles.md
@~/.claude/fv-skills/references/review-policy.md
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
