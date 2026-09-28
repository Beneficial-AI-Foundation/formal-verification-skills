---
name: help
description: Show available FVS commands and usage guide
---

<plugin_runtime>
- FVS is installed at `${CLAUDE_PLUGIN_ROOT}`; hosts expand this placeholder in plugin skill content.
- Resolve every bundled workflow, reference, template, script, and agent beneath that root.
- When executing a shell snippet, quote the resolved plugin-root path even if an inherited example omits quotes.
- Never write state into the plugin cache. Project state belongs under the user's current project (normally `.formalising/`).
</plugin_runtime>

<codex_skill_adapter>
This block applies only when this shared skill runs in Codex. Claude Code must ignore it and use the
shared workflow body with its native slash-command, question, and subagent semantics.

## A. Skill Invocation
- This skill is invoked by mentioning `$fvs:help`.
- Treat all user text after `$fvs:help` as `{{FVS_ARGS}}`.
- If no arguments are present, treat `{{FVS_ARGS}}` as empty.

## B. AskUserQuestion -> request_user_input Mapping
FVS workflows use `AskUserQuestion` (Claude Code syntax). Translate to Codex `request_user_input`:

Parameter mapping:
- `header` -> `header`
- `question` -> `question`
- Options formatted as `"Label" -- description` -> `{label: "Label", description: "description"}`
- Generate `id` from header: lowercase, replace spaces with underscores

Batched calls:
- `AskUserQuestion([q1, q2])` -> single `request_user_input` with multiple entries in `questions[]`

Multi-select workaround:
- Codex has no `multiSelect`. When a question allows multiple selections, do NOT collapse it to a single choice. Use sequential single-selects, or present a numbered freeform list asking the user to enter comma-separated numbers, then collect every selection before proceeding.

Execute mode fallback:
- When `request_user_input` is rejected or unavailable (Execute mode), present every `AskUserQuestion` call as a plain-text numbered list, then stop and wait for the user's reply. Do NOT pick a default and continue.
- You may proceed without a user answer only when one of these is true:
  (a) the invocation included an explicit non-interactive flag (`--auto` or `--all`),
  (b) the user has explicitly approved a specific default for this question, or
  (c) the workflow's documented contract says defaults are safe (e.g. autonomous lifecycle paths).
- Do NOT write workflow artifacts (handoff files, spec files, plan files, checkpoint files) until the user has answered the plain-text questions or one of (a)-(c) above applies. Surfacing the questions and waiting is the correct response — silently defaulting and writing artifacts is the failure mode this header exists to prevent.

## C. Task() -> spawn_agent Mapping
FVS workflows use `Task(...)` (Claude Code syntax). Translate to Codex collaboration tools:

**Schema detection (required first step):** Inspect the visible `spawn_agent` schema. It may have `agent_type` or be generic (no `agent_type`); inspect `model` and `reasoning_effort` fields independently rather than assuming either exists. An available `agent_type` field does not establish that a particular FVS role is registered.

Before spawning, inspect the `spawn_agent` tool's visible parameter schema to determine which form is active.
**Requested specialist gate (at dispatch only):** When a workflow requests a named FVS specialist, check BOTH the visible `spawn_agent` schema and whether the exact requested `agent_type` is advertised there or in a confirmed runtime registry. An `agent_type` field alone is not evidence that this role is registered; bundled `agents/*.md` are instructions, not registered Codex specialists. If the exact role is registered and `agent_type` is available, use typed mapping below WITHOUT a missing-role warning. Otherwise, even if `agent_type` is present, warn the user in plain language: Requested FVS specialist <agent-name> is not registered in this Codex session; the bundled Markdown cannot supply typed identity. Do not warn merely for opening help, installing, or mentioning a skill without requesting specialist dispatch. Apply the settings gate below before considering the generic-agent workaround. Never run an installer on the user's behalf.


Selection-capability gate (before manifest confirmation, child dispatch, or artifact writes):
- Check required specialist identity and sandbox against the exact registered role and effective child settings. A generic role preamble cannot meet a mandatory typed identity or sandbox requirement; stop and explain the unavailable guarantee before dispatch or artifact writes.
- If `model` is exposed for this child, pass the requested model. Otherwise compare it with the exact active/inherited Codex model; a different or unconfirmed model is unresolved. Rebuild the manifest around confirmed settings and ask explicitly, choose a capable external runner, or fail before dispatch in noninteractive mode.
- If `reasoning_effort` is exposed for this child, pass the requested effort. Otherwise compare it with the confirmed effective installed/runtime default; a different or unconfirmed effort is unresolved and follows the same rebuild/ask-or-fail rule.
- Model and effort are separate values: pass an exact catalog model id and an effort that model lists. A registered role that pins `model` or `reasoning_effort` (its role description says the setting is locked, or its TOML sets it) overrides the per-call value, so the pinned value is the effective one; if it differs from the confirmed selection it is unresolved.
- Never confirm a requested specialist setting and then omit it with a warning. The marketplace plugin does not install Codex agent TOML; use typed mapping only for an independently registered exact role.

Typed mapping (only when the exact requested FVS role is registered AND agent_type is exposed):
- `Task(subagent_type="X", prompt="Y")` -> `spawn_agent(agent_type="X", message="Y")`
- `Task(model="...")` -> pass `model` if available for this child; otherwise omit only after the selection-capability gate proves it equals the active/inherited model.
- `Task(reasoning_effort="...")` -> pass `reasoning_effort` if available for this child and the role does not pin it; otherwise omit only after the gate proves the effective (pinned or default) effort equals the confirmed effort.
- `fork_context: false` by default -- FVS agents load their own context via `<files_to_read>` blocks.

Generic-agent workaround (missing exact registered role OR no agent_type field):
If the requested FVS type (`fvs-researcher`, `fvs-executor`, etc.) is not registered, typed dispatch is NOT possible even with an `agent_type` field. If the field is absent, typed dispatch is also unavailable. Fallback:
1. Read `${CLAUDE_PLUGIN_ROOT}/agents/<agent-name>.md` and extract its instructions. If the token is still literal, resolve the path from this SKILL.md as described above.
2. Only when the settings gate permits generic execution, spawn a generic/default child with those instructions as a role preamble before the task prompt. Do not pass an unregistered `agent_type`.
3. Label output "generic-agent workaround". This is NOT equivalent to a registered specialist: the preamble does not assure typed identity, sandbox, model, or reasoning effort.
4. If required guarantees cannot be honored, stop before dispatch or artifact writes; explain which guarantee is missing. Typed FVS roles currently require the direct Codex installation, a separate complete FVS install: point the user to "Codex specialist roles" in the FVS README and never suggest keeping both channels. Even after switching, confirm exact registration and settings in the runtime.

Parallel fan-out:
- Spawn multiple agents -> collect agent IDs -> call `wait_agent(timeout_ms=...)` (or the runtime's visible wait equivalent) until each completes

Result parsing:
- Look for structured markers in agent output: `CHECKPOINT`, `PLAN COMPLETE`, `SUMMARY`, etc.
- If the runtime exposes an agent cleanup or close tool, use it after collecting each result

## D. Shared Plugin Syntax
- This file is shared with Claude Code. On Codex, interpret `/fvs:<name>` references as `$fvs:<name>`.
- Treat `$ARGUMENTS` in the shared body as `{{FVS_ARGS}}`.
- `${CLAUDE_PLUGIN_ROOT}` is the installed plugin root. If a host leaves that token unexpanded, resolve the plugin root as two directories above this SKILL.md.

</codex_skill_adapter>

<objective>
Display the complete FVS command reference.

Output ONLY the reference content below. Do NOT add:

- Project-specific analysis
- Git status or file context
- Next-step suggestions
- Any commentary beyond the reference
</objective>

<reference>
# FVS Command Reference

**FVS** (Formal Verification Skills) encodes the expert verification workflow for Lean 4 across two tracks: the **functional-correctness track** verifies Rust code via Aeneas (Rust → Charon → LLBC → Aeneas → Lean 4), and the **paper track** formalises maths/crypto papers directly into Lean.

Commands are grouped into five bundles. Each bundle has a router command (e.g. `/fvs:fc`) that lists its members and forwards to the matched skill; the member commands are also directly typeable.

## Quick Start

**From a Rust crate — functional-correctness track:**
1. `/fvs:aeneas-extract <path>` - Extract Rust → Lean 4 via the bounded Aeneas repair loop
2. `/fvs:model-external <stub>` - Model a locked external Rust function when the extracted unit depends on one
3. `/fvs:map-code` - Analyze project, build dependency graph
4. `/fvs:fc-plan` - Select verification targets
5. `/fvs:lean-specify <function>` - Generate spec with sorry, then choose an adversarial reviewer
6. `/fvs:lean-verify <spec_path>` - Attempt proof interactively
7. `/fvs:lean-refactor <spec_path>` - Golf and clean up verified proofs
8. `/fvs:trust-audit <target>` - Audit the sorry/axiom trust surface

**From a paper — paper track:**
- `/fvs:lean-formalise` - One-shot formalisation of paper/math content, or
- `/fvs:crypto-plan <topic>` - Start the multi-iteration crypto loop (see Formalise below)

## Core Workflow

```
Code track:  /fvs:aeneas-extract → [/fvs:model-external when required] → /fvs:map-code → /fvs:fc-plan → /fvs:lean-specify → /fvs:lean-spec-review → /fvs:lean-verify → /fvs:lean-refactor → /fvs:trust-audit
Paper track: /fvs:lean-formalise → /fvs:lean-verify → /fvs:lean-refactor
Crypto loop: /fvs:crypto-plan → /fvs:crypto-review → /fvs:crypto-execute → /fvs:crypto-eval → /fvs:crypto-followup → /fvs:crypto-review → repeat
```

## Bundles

Five router commands group the skills. Invoke a router bare to print its routing table, or with a request to forward to the matched skill.

- `/fvs:aeneas` — Aeneas/Charon extraction maintenance (aeneas-extract, model-external, sync-aeneas-verif)
- `/fvs:context` — Codebase context (map-code)
- `/fvs:fc` — Formal-correctness core (fc-plan, model-external, lean-specify, lean-spec-review, lean-verify, natural-language, lean-refactor, trust-audit)
- `/fvs:formalise` — Paper formalisation (lean-formalise, lean-refactor)
- `/fvs:manage` — Management (help, update, checkpoint, pause-work, resume-work, reapply-patches, kb-setup)

### Aeneas (`/fvs:aeneas`)

Aeneas/Charon extraction maintenance.

**`/fvs:aeneas-extract <path>`**
Drive a Rust crate/folder/file through the bounded Aeneas extraction repair loop.

- Auto-detects target shape (crate via `Cargo.toml`, folder, or single file)
- Pre-flight pin audit: warn-and-confirm on Charon/Aeneas pin drift, records `pin_context`
- Loop: extract → classify → dispatch (auto-apply / bisect / gate / escalate) → document → re-extract
- Fires a synchronous Category-B equivalence gate with an independent assessor; refuses completion without the human ratification token
- Reversible source records at the crate root; generated Lean is never written
- Bounded (attempt-cap 3, no-progress rule); escalation is a human decision point and a valid outcome

Usage: `/fvs:aeneas-extract path/to/crate`
Usage: `/fvs:aeneas-extract src/field.rs`

**`/fvs:model-external <external-stub> [--iteration nN] [--resume ARTIFACT_DIR]`**
Model one external Rust stub and only its required external-stub dependency closure.

- Resolves immutable source from Cargo.lock registry/git entries, configured vendor trees, or a pinned rustc sysroot
- Records exact source file/range/version-or-commit and SHA-256 evidence
- Stops on unsafe Rust; observable effects and nondeterministic/platform abstractions require `HUMAN_RULING`
- Writes only exact hand-written external model/specification targets; generated Lean remains immutable
- Keeps candidate writes reversible and restores canonical Lean on every non-success outcome
- Runs separate model-fidelity and specification reviews, each capped at three rounds
- Completes proofs, guarded build, and CLEAN trust audit before finalization
- Preserves failed candidate patches and evidence under `.formalising/model-external/`

Usage: `/fvs:model-external external_crate.function`

**`/fvs:sync-aeneas-verif`**
Sync Aeneas/Charon upstream docs and reconcile the extraction blocker catalog via two specialised agents.

- Mines the config-driven local Charon + Aeneas clones (no hardcoded paths); reports clone staleness gracefully
- Mode (a) tactics/Lean-syntax: reads `_sync-meta.json` mapping, diffs upstream docs section-by-section, detects and propagates tactic renames
- Mode (b) extraction-docs: syncs Charon/Aeneas extraction documentation and reconciles the blocker catalog in place (retire / update-signature / still-open)
- Reconcile-not-append: existing entries/sections updated in place, never blind-appended or silently overwritten
- Interactive: user approves each proposed change
- Read-only on-demand GitHub fetch as a fallback; never opens or creates an upstream artifact

Usage: `/fvs:sync-aeneas-verif`

### Context (`/fvs:context`)

Codebase context and dependency mapping.

**`/fvs:map-code`**
Build function dependency graph from extracted Lean code and Rust source.

- Detects Aeneas project via `lakefile.toml` + `lean-toolchain`
- Creates `.formalising/` state directory
- Uses probe-aeneas >= 0.19.0 for an exact, reproducible function inventory and count
- Reads Funs.lean only to annotate the probe-supplied functions
- Maps Lean names back to Rust source (if available)
- Auto-detects project definitions (Defs.lean or equivalent)
- Scans existing specs for sorry status
- Writes `.formalising/CODEMAP.md`

Usage: `/fvs:map-code` or `/fvs:map-code /path/to/project`

### Formal-Core (`/fvs:fc`)

The functional-correctness track: plan, specify, verify, explain, refactor.

**`/fvs:fc-plan`**
Pick next verification targets via dependency graph analysis.

- Reads `.formalising/CODEMAP.md` (run `/fvs:map-code` first)
- Computes bottom-up verification order from dependency graph
- Evaluates candidates for complexity, leverage, and risk
- Presents interactive ranked selection
- Identifies "ready now" vs "blocked" functions

Usage: `/fvs:fc-plan` or `/fvs:fc-plan <function_name>`

**`/fvs:lean-specify <function_name>`**
Generate Lean spec skeleton following @[step] theorem pattern.

- Resolves function in CODEMAP.md or Funs.lean directly
- Deep analysis of function body, types, and control flow
- Checks dependency spec status
- Loads the target repo style guide (`project.style_guide_path` or `doc/STYLE_GUIDE` discovery)
- Generates spec with correct imports, namespace, @[step] theorem, sorry
- Mechanically rejects over-limit lines and ordinary identifiers with 3+ namespace dots
- Validates spec structure and optional build check
- Reads `.formalising/proof-engineering/index.md` first, loads at most eight relevant lessons, and
  reviewably reconciles at most three evidence-backed specification insights as separate files

Usage: `/fvs:lean-specify scalar_mul_inner`
Result: `Specs/{path}/{FunctionName}.lean` with sorry placeholder

**`/fvs:lean-spec-review <spec.lean> [--reviewer codex|claude|pi|other] [--model ID] [--effort LEVEL]`**
Adversarially review an FC specification against Rust, extracted Lean, and interpretation definitions.

- Quality recommends the authenticated opposite provider/runtime at authority-tier effort
- Shows one reviewer/model/effort selection manifest before launch; notes rebuild and reconfirm it
- Supports one-run adjustments or saved `spec_review` overrides without changing sibling stages
- Uses fresh reviewers and labels cross-runtime versus same-runtime review
- Missing opposite CLIs ask among setup, same-runtime, Other packet, one-run skip, or cancel
- Preserves immutable `review.md` plus separate author-owned `triage.md` and input hashes
- Unresolved noninteractive selections fail before launch with exact remediation
- One-run `Skip review` records `Unreviewed (user skipped)`, stops, and never starts proof work
- PASS proceeds; APPROVE-WITH-EDITS proceeds after author edits and gates, without another review
- REVISE/BLOCKED create a fresh review with prior history; each invocation stops after three rounds

Runs automatically after `lean-specify` by default, even on projects without config. To disable
only automation, merge `"spec_review": {"automatic": false}` into `.formalising/fvs-config.json`,
or create the file with `{"spec_review": {"automatic": false}}`. Manual invocation still works.

Usage: `/fvs:lean-spec-review Specs/Scalar/Mul.lean --reviewer codex --model <exact-catalog-id> --effort <supported-effort>`

**`/fvs:lean-verify <spec_file_path>`**
Attempt proof using domain tactics with interactive feedback.

- Interactive proof loop: agent proposes ONE tactic step at a time
- Inlines the target style guide and mechanically blocks new style violations before compile checks
- Keeps theorem names/statements immutable unless the user explicitly authorizes an edit
- User provides feedback (goal state, errors, hints) between iterations
- Configurable max attempts (default 10, hard cap 25)
- Routes on proof status: TACTIC PROPOSED, VERIFIED, STUCK
- Updates CODEMAP.md verification status on completion
- Loads a bounded selection from `.formalising/proof-engineering/` before research and reviewably
  captures only green-build proof patterns or observed-diagnostic lessons for future sessions

Usage: `/fvs:lean-verify Specs/Backend/Field/Sub.lean`
Usage: `/fvs:lean-verify Specs/Backend/Field/Sub.lean --max-attempts 15`

**`/fvs:natural-language <function_name>`**
Generate detailed natural-language explanation of a function.

- Creates stubs/ markdown file with pre/post conditions
- Explains algorithmic meaning and mathematical properties
- Useful for understanding complex functions before verification

Usage: `/fvs:natural-language scalar_mul`

**`/fvs:lean-refactor <spec_file_path>`** (also in Formalise)
Refactor, simplify, and decompose verified Lean proofs while preserving compilation.

- Requires fully verified spec (zero sorry) -- run `/fvs:lean-verify` first
- Three modes: safe (zero-risk cleanup), balanced (default), aggressive (smart automation)
- Applies tiered heuristics: dead code removal, simp sharpening, tactic golf, automation replacement
- Verifies compilation after every change
- Optional --report-only flag for analysis without modification

Usage: `/fvs:lean-refactor Specs/Backend/Field/Sub.lean`
Usage: `/fvs:lean-refactor Specs/Backend/Field/Sub.lean --mode aggressive --max-passes 10`
Usage: `/fvs:lean-refactor Specs/Backend/Field/Sub.lean --theorem sub_spec --report-only`

**`/fvs:trust-audit <target spec file | module subtree>`**
Build-backed trust audit of an Aeneas-extracted Lean target.

- Runs `LEAN_NUM_THREADS="${LEAN_NUM_THREADS:-4}" nice -n 19 lake build` as a green-build-guarded precondition; HALTs if the target layer does not compile
- Dispatches the read-only `fvs-axiom-auditor` to introspect every in-scope declaration via `#print axioms`
- Classifies each: `sorryAx` ⇒ sorry, classical trio (propext / Classical.choice / Quot.sound) auto-noted, project-custom axioms require justification
- Strictly-scoped inventory (Rust path convention); cone members surfaced as prerequisites, never inventory rows
- Fail-if-unjustified gate (NOT-CLEAN while any project-custom in-scope axiom lacks a justification)
- Writes a re-runnable, strictly dependency-ordered table to `.formalising/audits/<target>.md`

Usage: `/fvs:trust-audit Specs/Backend/Field/Sub.lean`

### Formalise (`/fvs:formalise`)

The paper track: formalise maths/crypto papers, then refactor.

**`/fvs:lean-formalise`**
Formalise mathematical paper content into Lean 4 specifications (paper track).

- Interactive prompts: describe task, point to resources, select KB, set module path
- Reads PDFs (via pdftotext), images (vision), markdown, LaTeX from .formalising/resources/
- Optional NotebookLM knowledge base integration (set up with /fvs:kb-setup)
- Creates both definition files and spec files (unlike lean-specify which only creates specs)
- Two-phase dispatch: researcher extracts math structure, executor writes Lean files
- Shared with code track: use /fvs:lean-verify for proof attempts
- Uses the indexed proof-engineering store and records source-backed paper/modeling lessons

Usage: `/fvs:lean-formalise`
Result: Lean definition and spec files with sorry placeholders

**`/fvs:lean-refactor <spec_file_path>`** (also in Formal-Core)
Refactor, simplify, and decompose verified Lean proofs while preserving compilation. See the Formal-Core bundle above for full details.

Usage: `/fvs:lean-refactor Specs/Backend/Field/Sub.lean`

The crypto formalisation loop
(plan -> independent review -> execute -> eval -> follow-up -> independent review) is a
topic-based, multi-iteration alternative to the one-shot `lean-formalise`. Its stages share the
artifact tree under `fv-plans/<topic>/` and the loop is restartable from those records.

The loop also has a lightweight proof-engineering overlay. Plan, execute, eval, and follow-up read
the index first, load at most eight relevant `crypto`/`shared` lessons, and reconcile at most three
evidence-gated candidates as separate files capped at 800 words each. Crypto modeling choices
require paper or standard
citations and remain provisional until adversarial acceptance or a human ruling. `crypto-review`
is deliberately memory-blind, preserving an independent critique.

**Single- vs dual-runtime (`--codex`).** By default the loop is *single-runtime*: the high-effort thinking (planning, adversarial eval, follow-up) is done by the in-runtime `fvs-crypto-thinker`. The three *thinking* stages — `crypto-plan`, `crypto-eval`, `crypto-followup` — also accept `--codex`, which hands that stage's thinking to an independent **Codex CLI** thinker instead. That makes the loop *dual-runtime*: the adversarial planner/evaluator runs on a different engine than the executor, reducing correlated blind spots. `crypto-execute` is the runtime-neutral executor and takes no `--codex`. Pass `--codex` without the Codex CLI installed and the stage stops with an install hint (never a silent fallback) — re-run without it to stay single-runtime.

**`/fvs:crypto-plan <topic> [nN] [--codex]`**
Author the next bounded, runtime-neutral executor plan for a topic, grounded in the paper via the NotebookLM knowledge base (answers cached under `sources/`).

Usage: `/fvs:crypto-plan "CKA from KEM"`
Usage: `/fvs:crypto-plan "CKA from KEM" --codex`   # hand the planning think-step to Codex

**`/fvs:crypto-review <topic> [nN] [--target plan|followup] [--reviewer codex|claude|pi|other] [--model ID] [--effort LEVEL]`**
Send a plan to a selected fresh adversarial reviewer.

- Quality recommends an authenticated opposite provider/runtime with its authority-tier model + max effort
- Shows one confirmed selection manifest; notes rebuild it, one-run edits stay ephemeral, and saves affect only `crypto_review`
- Labels cross-runtime, same-runtime fresh reviewer, and unverified provenance honestly
- Runs provider-qualified Pi, Codex CLI, or Claude Code CLI with bounded read-only source controls
- Attacks source fidelity, statement soundness, semantic closure, interfaces, gates, boundedness,
  security/data-loss risks, and roadmap coherence
- Wrapper preserves immutable review evidence; the authoring seat writes separate hash-bound triage
- Deliberately excludes canonical and snapshotted proof-engineering memory from reviewer context
- APPROVE-WITH-EDITS proceeds after accepted author edits and gates, with no second review
- REJECT creates a fresh reviewed revision; each invocation stops after three reviewer rounds
- Automatic handoff asks reviewer -> model -> effort and never auto-selects a choice
- One-run `Skip review` records `Unreviewed (user skipped)` and never starts execution

Usage: `/fvs:crypto-review "CKA from KEM" n1 --target plan`
Usage: `/fvs:crypto-review "CKA from KEM" n1 --target followup --reviewer claude --model <exact-catalog-id> --effort <supported-effort>`

Crypto plan and follow-up enter the interactive review handoff by default. To disable only that
automatic handoff, merge `"crypto_review": {"automatic": false}` into
`.formalising/fvs-config.json`. Standalone review remains available, and a trusted user may
explicitly invoke crypto execution from an unreviewed plan.

**`/fvs:crypto-execute <topic> nN`**
Run the current iteration's bounded plan under the green-build guard; a failed proof triggers a short interactive redirect early. (Executor stage — takes no `--codex`.)

Usage: `/fvs:crypto-execute "CKA from KEM" n1`

**`/fvs:crypto-eval <topic> nN [--codex]`**
Adversarially evaluate the iteration; ends in exactly one decision (ACCEPT / FOLLOWUP / HUMAN_RULING / BLOCKED).

Usage: `/fvs:crypto-eval "CKA from KEM" n1`
Usage: `/fvs:crypto-eval "CKA from KEM" n1 --codex`

**`/fvs:crypto-followup <topic> nN [--codex]`**
Convert eval findings into the next bounded follow-up plan; HALTs for a human ruling on a modeling decision.

Usage: `/fvs:crypto-followup "CKA from KEM" n1`

### Manage (`/fvs:manage`)

Session, maintenance, and setup commands.

**`/fvs:configure`**
Configure the role-aware quality profile, exact runtime+stage overrides, compatibility agent
overrides, and FC/crypto review defaults through choice menus. Quality uses strongest+max for
authority artifacts, executor+xhigh for plan execution/proof filling, and smaller+high for scout
work, but only after matching an exact current runtime/provider catalog entry. Every command shows
one confirmable selection manifest; notes rebuild it before launch.

Usage: `/fvs:configure`

**`/fvs:update`**
Update FVS to latest version.

- Checks npm registry for newer version
- Shows changelog
- Refreshes FVS from the configured plugin marketplace

Usage: `/fvs:update`

**`/fvs:checkpoint <description>`**
Create a structured verification checkpoint commit.

- Captures current verification progress as a commit
- Records what was verified in the message

Usage: `/fvs:checkpoint "verified field_add and field_sub"`

**`/fvs:pause-work`**
Save verification context for a session handoff.

- Writes a handoff doc capturing current state
- Lets you resume later with `/fvs:resume-work`

Usage: `/fvs:pause-work` or `/fvs:pause-work "mid-proof on scalar_mul"`

**`/fvs:resume-work`**
Resume verification from saved handoff context.

- Restores context from a prior `/fvs:pause-work` handoff
- Suggests `/fvs:fc-plan` if no handoff is found

Usage: `/fvs:resume-work`

**`/fvs:reapply-patches`**
Reapply local modifications after an FVS update.

- Detects backed-up patches from `fvs-local-patches/` directory
- Merges user modifications into newly installed version
- Handles conflicts with user input
- Explains fork or project-local customization for immutable plugin installs

Usage: `/fvs:reapply-patches`

**`/fvs:kb-setup`**
Set up NotebookLM knowledge base integration.

- Creates Python venv in .formalising/.kb-venv/
- Installs notebooklm-py library and browser auth
- Interactive login to NotebookLM
- Registers knowledge base with domain tags in fvs-config.json
- Use --add to register additional KBs without recreating venv

Usage: `/fvs:kb-setup`
Usage: `/fvs:kb-setup --add`

**`/fvs:help`**
Show this command reference.

## Files & Structure

```
.formalising/                # FVS state directory (per-project)
├── CODEMAP.md               # Function inventory, deps, verification status
├── proof-engineering/       # Indexed proof and modeling memory
│   ├── index.md             # Links + metadata; always read first
│   └── lessons/
│       ├── fc/              # Functional-correctness lessons
│       ├── crypto/          # Crypto lessons and modeling decisions
│       └── shared/          # Independently reused across tracks
├── fv-plans/                # Per-function/topic planning docs
└── model-external/          # Immutable source/review evidence and reversible candidates

${CLAUDE_PLUGIN_ROOT}/                   # Installed FVS content (global)
├── agents/
│   ├── fvs-researcher.md
│   ├── fvs-executor.md
│   ├── fvs-explainer.md
│   ├── fvs-lean-refactorer.md
│   ├── fvs-extract-classifier.md
│   ├── fvs-extract-applier.md
│   ├── fvs-extract-bisector.md
│   ├── fvs-equivalence-assessor.md
│   ├── fvs-draft-investigator.md
│   ├── fvs-doc-syncer.md
│   └── fvs-external-modeler.md
├── commands/fvs/          # flat router and command siblings
│   ├── aeneas.md          # router
│   ├── context.md         # router
│   ├── fc.md              # router
│   ├── formalise.md       # router
│   ├── manage.md          # router
│   ├── aeneas-extract.md
│   ├── model-external.md
│   ├── map-code.md
│   ├── fc-plan.md
│   ├── lean-specify.md
│   ├── lean-verify.md
│   ├── lean-refactor.md
│   ├── natural-language.md
│   ├── lean-formalise.md
│   ├── kb-setup.md
│   ├── checkpoint.md
│   ├── pause-work.md
│   ├── resume-work.md
│   ├── configure.md
│   ├── update.md
│   ├── reapply-patches.md
│   ├── sync-aeneas-verif.md
│   └── help.md
├── scripts/
│   ├── fvs-kb-query.py           # NotebookLM query tool (Python)
│   ├── fvs-model-external.mjs    # Locked source + candidate transaction helper
│   └── fvs-model-review.mjs      # Two-mode immutable review adapter
└── fv-skills/
    ├── references/          # Domain knowledge
    ├── templates/           # Spec, config, stub templates
    ├── upstream/aeneas/     # Pinned upstream documentation snapshot
    │   └── _sync-meta.json  # Mapping table for sync-aeneas-verif
    └── workflows/           # Command orchestration logic
        ├── aeneas-extract.md
        ├── model-external.md
        ├── lean-formalise.md
        └── sync-aeneas-verif.md
```

## Status Symbols

```
[OK]  Verified (zero sorry)
[??]  In progress (has sorry)
[--]  Unspecified (no spec)
[XX]  Error (does not compile)
```

## Verification Workflow

```
Rust → Charon → LLBC → Aeneas → Lean 4
                                  ↓
                           Types.lean (auto)
                           Funs.lean  (auto)
                                  ↓
                           Specs/*.lean (you write)
```

- Types.lean, Funs.lean are auto-generated — NEVER edit
- Specs are hand-written with FVS assistance
- Core tactics: step, unfold, simp, ring, field_simp, agrind, scalar_tac

## Getting Help

- Run `/fvs:map-code` to analyze your project
- Check `.formalising/CODEMAP.md` for verification status
- Inspect `${CLAUDE_PLUGIN_ROOT}/fv-skills/references/` for domain knowledge
</reference>
