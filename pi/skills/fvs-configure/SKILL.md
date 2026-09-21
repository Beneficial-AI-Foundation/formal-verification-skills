---
name: fvs-configure
description: Configure runtime-aware FVS stage models, effort levels, and review defaults
---

<pi_package_runtime>
- This skill lives under `pi/skills/<name>/SKILL.md`; the FVS package root is `../../..` relative to its directory.
- Resolve every bundled relative path against the skill directory and pass absolute paths to tool calls and shell commands.
- Agent role instructions live under `../../../agents/`. When a workflow requests Task/subagent dispatch, use an available Pi subagent facility with the matching role instructions. If none is installed, perform the role inline and state that fresh-context separation was unavailable. Exception: a review workflow that requires a fresh reviewer must remain pending or offer its documented fallback; never perform that review inline.
- Use Pi's structured question tool when available; otherwise ask the same question in plain text.
- Never write state into the managed package. Project state belongs under the user's current project (normally `.formalising/`).
</pi_package_runtime>

<objective>
Edit `.formalising/fvs-config.json` through bounded choice menus. Store exact runtime model IDs only
when the runtime reports them, keep quality role-aware by stage, configure the project
`native_decide` policy, preserve one-run user control, and preserve unrelated project configuration.
</objective>

<execution_context>
@../../../fv-skills/references/model-profiles.md
@../../../fv-skills/templates/config.json
</execution_context>

<process>

## 1. Load without clobbering

Read `.formalising/fvs-config.json` when it exists; otherwise start from the shipped template. Reject
malformed JSON and stop before writing. Preserve unknown keys and every unrelated nested value.
Never replace the whole file with a partial settings object.

Add missing current-schema containers without deleting old settings: `stage_overrides`,
`model_overrides`, `effort_overrides`, `spec_review`, and `crypto_review`. A missing top-level
`native_decide` value defaults to `ask`; reject values outside `avoid | ask | allow`.

## 2. Detect runtime, provider, and catalog

Prefer explicit host identity over directory guesses:

1. `PI_CODING_AGENT=true` or `AI_AGENT=pi` means Pi.
2. A host adapter or `AI_AGENT` value naming Claude, Codex, OpenCode, or Gemini wins next.
3. If identity is still unknown, ask which runtime is being configured.

Read the runtime's current model catalog or picker. On Pi, `pi --list-models` is the CLI fallback.
Keep Pi IDs provider-qualified and identify its active provider. Never invent or persist a guessed
slug. Read the canonical quality stage and runtime matrices from `model-profiles.md`; do not copy or
weaken them here.

For ordinary Pi stages, stay within the active provider. Review routing is configured separately and
may use an authenticated opposite-runtime CLI. Never treat a Claude Code subscription as a Pi
Anthropic credential.

## 3. Main settings menu

Use `AskUserQuestion` and repeat until the user saves or cancels. Retain the question UI's notes or
custom-answer path. Present at most these four choices:

- **Profile** — choose `quality`, `balanced`, or `budget`.
- **Stage overrides** — configure one exact canonical stage for the active runtime.
- **Advanced defaults** — open agent-compatibility or review-default settings.
- **Save/exit** — preview, save, discard, or continue.

If structured questions are unavailable, print the same numbered choices plus a notes/custom line,
then stop and wait. Never select on the user's behalf.

## 4. Configure a stage override

Read stage keys and tiers from the sole canonical table in `model-profiles.md`. First choose a tier,
then a stage in that tier. Do not infer a stage from an agent name.

Show the quality recommendation for the detected runtime/provider as an exact catalog match. The
model menu offers:

1. the exact detected quality model when available;
2. `inherit`;
3. up to one other detected runtime/provider model;
4. catalog/custom selection.

If the preferred model is absent, show the detected catalog and require a choice; do not silently
choose a lower family. Custom input must exactly match a catalog entry. On Pi it must include the
provider. For ordinary Pi stages, reject entries whose catalog provider differs from the active
provider; review stages use their separate opposite-provider policy.

For effort, offer every value the selected catalog model reports as supported, with the stage
tier's quality effort first. Never advertise a value the model cannot accept. Save either or both fields under:

```
stage_overrides[runtime][stage] = { model?, effort? }
```

Removing both fields removes the stage entry. A saved stage override affects only that runtime and
stage.

## 5. Configure advanced defaults

Use a submenu with at most four choices: **Agent compatibility**, **Review defaults**,
**Proof policy**, **Back**.

### Agent compatibility

Existing broad overrides remain available for projects that need one setting across several
stages. Choose one shipped agent and store exact values under
`model_overrides[runtime][agent]` / `effort_overrides[runtime][agent]`. Explain that a stage override
wins and is preferred when a shared agent performs different roles.

Shipped groups:

- FC: `fvs-researcher`, `fvs-executor`, `fvs-lean-refactorer`, `fvs-explainer`.
- Crypto: `fvs-crypto-thinker`, `fvs-crypto-executor`.
- Extraction: `fvs-extract-classifier`, `fvs-extract-applier`, `fvs-extract-bisector`,
  `fvs-equivalence-assessor`, `fvs-draft-investigator`, `fvs-doc-syncer`.
- Audit: `fvs-axiom-auditor`.

### Proof policy

Choose the project-scoped top-level `native_decide` value:

- `avoid` — fail before use;
- `ask` — require explicit approval when a run proposes use;
- `allow` — permit use while recording it in manifests and trust evidence.

Default to `ask`. Explain that a command may confirm a one-run override, but a one-run choice never
persists; only this configuration menu changes the stored policy.

### Review defaults

Choose `spec_review`, `crypto_review`, or both. Null reviewer/model/effort values keep role-aware
profile routing and the per-command confirmation active. For each explicit saved review setting:

1. choose reviewer runtime `codex`, `claude`, `pi`, or `other` (`pi` only when the active host is Pi and the selected provider is authenticated);
2. choose an exact model from that reviewer's catalog;
3. choose a supported effort;
4. keep `automatic` unchanged unless explicitly edited.

Quality recommends the authenticated opposite provider/runtime and its authority-tier model+effort.
On Pi, OpenAI review of Claude-authored work prefers a fresh provider-qualified Pi seat only when
the child facility can honor and report the exact per-child model/effort, then Codex CLI. Review of
OpenAI-authored work uses authenticated Claude Code CLI when available. If the opposite runner is
unavailable, do not silently save a same-runtime fallback.

## 6. Preview and save

Show all changed keys and a selection preview. Ask for confirmation with `Save`, `Continue editing`,
`Discard`, and `Cancel`. Notes rebuild the preview and require another confirmation.

Create `.formalising/` if needed, serialize with two-space indentation and a trailing newline,
validate the complete JSON in a temporary file, then atomically replace
`.formalising/fvs-config.json`. On validation or write failure, leave the old file untouched.

Report runtime/provider, profile, stored `native_decide` policy, changed stage/agent/review
settings, and precedence:

1. explicit one-run selection;
2. saved review value for review stages;
3. runtime+stage override;
4. runtime+agent compatibility override;
5. profile/catalog resolution.

Also report that missing preferred models, ordinary-Pi provider mismatches, unsupported efforts,
and unavailable per-child controls prompt interactively, while noninteractive unresolved choices
fail before dispatch with exact remediation.

</process>

<success_criteria>
- [ ] Runtime/provider identified explicitly; every concrete model came from its current catalog.
- [ ] Ordinary Pi stage overrides use the active provider; review overrides follow review routing.
- [ ] Quality recommendations use the canonical authority/work/scout matrices.
- [ ] Stage overrides are stored under the exact runtime+stage key and win over agent overrides.
- [ ] Choice menus expose notes and reconfirm after notes change the preview.
- [ ] Review defaults may remain null so opposite-runtime profile routing stays active.
- [ ] `native_decide` is one of `avoid | ask | allow`, defaults to `ask`, and one-run overrides never persist.
- [ ] Unknown config keys were preserved and malformed JSON was never overwritten.
</success_criteria>
