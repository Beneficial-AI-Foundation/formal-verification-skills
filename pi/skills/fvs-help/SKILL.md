---
name: fvs-help
description: Show available FVS commands and usage guide
---

<pi_package_runtime>
- This skill lives under `pi/skills/<name>/SKILL.md`; the FVS package root is `../../..` relative to its directory.
- Resolve every bundled relative path against the skill directory and pass absolute paths to tool calls and shell commands.
- Agent role instructions live under `../../../agents/`. When a workflow requests Task/subagent dispatch, use an available Pi subagent facility with the matching role instructions. If none is installed, perform the role inline and state that fresh-context separation was unavailable. Exception: a review workflow that requires a fresh reviewer must remain pending or offer its documented fallback; never perform that review inline.
- Use Pi's structured question tool when available; otherwise ask the same question in plain text.
- Never write state into the managed package. Project state belongs under the user's current project (normally `.formalising/`).
</pi_package_runtime>

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

Commands are grouped into five bundles. Each bundle has a router command (e.g. `/skill:fvs-fc`) that lists its members and forwards to the matched skill; the member commands are also directly typeable.

## Quick Start

**From a Rust crate — functional-correctness track:**
1. `/skill:fvs-aeneas-extract <path>` - Extract Rust → Lean 4 via the bounded Aeneas repair loop
2. `/skill:fvs-map-code` - Analyze project, build dependency graph
3. `/skill:fvs-fc-plan` - Select verification targets
4. `/skill:fvs-lean-specify <function>` - Generate spec with sorry, then choose an adversarial reviewer
5. `/skill:fvs-lean-verify <spec_path>` - Attempt proof interactively
6. `/skill:fvs-lean-refactor <spec_path>` - Golf and clean up verified proofs
7. `/skill:fvs-trust-audit <target>` - Audit the sorry/axiom trust surface

**From a paper — paper track:**
- `/skill:fvs-lean-formalise` - One-shot formalisation of paper/math content, or
- `/skill:fvs-crypto-plan <topic>` - Start the multi-iteration crypto loop (see Formalise below)

## Core Workflow

```
Code track:  /skill:fvs-aeneas-extract → /skill:fvs-map-code → /skill:fvs-fc-plan → /skill:fvs-lean-specify → /skill:fvs-lean-spec-review → /skill:fvs-lean-verify → /skill:fvs-lean-refactor → /skill:fvs-trust-audit
Paper track: /skill:fvs-lean-formalise → /skill:fvs-lean-verify → /skill:fvs-lean-refactor
Crypto loop: /skill:fvs-crypto-plan → /skill:fvs-crypto-review → /skill:fvs-crypto-execute → /skill:fvs-crypto-eval → /skill:fvs-crypto-followup → /skill:fvs-crypto-review → repeat
```

## Bundles

Five router commands group the skills. Invoke a router bare to print its routing table, or with a request to forward to the matched skill.

- `/skill:fvs-aeneas` — Aeneas/Charon extraction maintenance (aeneas-extract, sync-aeneas-verif)
- `/skill:fvs-context` — Codebase context (map-code)
- `/skill:fvs-fc` — Formal-correctness core (fc-plan, lean-specify, lean-spec-review, lean-verify, natural-language, lean-refactor, trust-audit)
- `/skill:fvs-formalise` — Paper formalisation (lean-formalise, lean-refactor)
- `/skill:fvs-manage` — Management (help, update, checkpoint, pause-work, resume-work, reapply-patches, kb-setup)

### Aeneas (`/skill:fvs-aeneas`)

Aeneas/Charon extraction maintenance.

**`/skill:fvs-aeneas-extract <path>`**
Drive a Rust crate/folder/file through the bounded Aeneas extraction repair loop.

- Auto-detects target shape (crate via `Cargo.toml`, folder, or single file)
- Pre-flight pin audit: warn-and-confirm on Charon/Aeneas pin drift, records `pin_context`
- Loop: extract → classify → dispatch (auto-apply / bisect / gate / escalate) → document → re-extract
- Fires a synchronous Category-B equivalence gate with an independent assessor; refuses completion without the human ratification token
- Reversible source records at the crate root; generated Lean is never written
- Bounded (attempt-cap 3, no-progress rule); escalation is a human decision point and a valid outcome

Usage: `/skill:fvs-aeneas-extract path/to/crate`
Usage: `/skill:fvs-aeneas-extract src/field.rs`

**`/skill:fvs-sync-aeneas-verif`**
Sync Aeneas/Charon upstream docs and reconcile the extraction blocker catalog via two specialised agents.

- Mines the config-driven local Charon + Aeneas clones (no hardcoded paths); reports clone staleness gracefully
- Mode (a) tactics/Lean-syntax: reads `_sync-meta.json` mapping, diffs upstream docs section-by-section, detects and propagates tactic renames
- Mode (b) extraction-docs: syncs Charon/Aeneas extraction documentation and reconciles the blocker catalog in place (retire / update-signature / still-open)
- Reconcile-not-append: existing entries/sections updated in place, never blind-appended or silently overwritten
- Interactive: user approves each proposed change
- Read-only on-demand GitHub fetch as a fallback; never opens or creates an upstream artifact

Usage: `/skill:fvs-sync-aeneas-verif`

### Context (`/skill:fvs-context`)

Codebase context and dependency mapping.

**`/skill:fvs-map-code`**
Build function dependency graph from extracted Lean code and Rust source.

- Detects Aeneas project via `lakefile.toml` + `lean-toolchain`
- Creates `.formalising/` state directory
- Uses probe-aeneas >= 0.19.0 for an exact, reproducible function inventory and count
- Reads Funs.lean only to annotate the probe-supplied functions
- Maps Lean names back to Rust source (if available)
- Auto-detects project definitions (Defs.lean or equivalent)
- Scans existing specs for sorry status
- Writes `.formalising/CODEMAP.md`

Usage: `/skill:fvs-map-code` or `/skill:fvs-map-code /path/to/project`

### Formal-Core (`/skill:fvs-fc`)

The functional-correctness track: plan, specify, verify, explain, refactor.

**`/skill:fvs-fc-plan`**
Pick next verification targets via dependency graph analysis.

- Reads `.formalising/CODEMAP.md` (run `/skill:fvs-map-code` first)
- Computes bottom-up verification order from dependency graph
- Evaluates candidates for complexity, leverage, and risk
- Presents interactive ranked selection
- Identifies "ready now" vs "blocked" functions

Usage: `/skill:fvs-fc-plan` or `/skill:fvs-fc-plan <function_name>`

**`/skill:fvs-lean-specify <function_name>`**
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

Usage: `/skill:fvs-lean-specify scalar_mul_inner`
Result: `Specs/{path}/{FunctionName}.lean` with sorry placeholder

**`/skill:fvs-lean-spec-review <spec.lean> [--reviewer codex|claude|pi|other] [--model ID] [--effort LEVEL]`**
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

Usage: `/skill:fvs-lean-spec-review Specs/Scalar/Mul.lean --reviewer codex --model <exact-catalog-id> --effort <supported-effort>`

**`/skill:fvs-lean-verify <spec_file_path>`**
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

Usage: `/skill:fvs-lean-verify Specs/Backend/Field/Sub.lean`
Usage: `/skill:fvs-lean-verify Specs/Backend/Field/Sub.lean --max-attempts 15`

**`/skill:fvs-natural-language <function_name>`**
Generate detailed natural-language explanation of a function.

- Creates stubs/ markdown file with pre/post conditions
- Explains algorithmic meaning and mathematical properties
- Useful for understanding complex functions before verification

Usage: `/skill:fvs-natural-language scalar_mul`

**`/skill:fvs-lean-refactor <spec_file_path>`** (also in Formalise)
Refactor, simplify, and decompose verified Lean proofs while preserving compilation.

- Requires fully verified spec (zero sorry) -- run `/skill:fvs-lean-verify` first
- Three modes: safe (zero-risk cleanup), balanced (default), aggressive (smart automation)
- Applies tiered heuristics: dead code removal, simp sharpening, tactic golf, automation replacement
- Verifies compilation after every change
- Optional --report-only flag for analysis without modification

Usage: `/skill:fvs-lean-refactor Specs/Backend/Field/Sub.lean`
Usage: `/skill:fvs-lean-refactor Specs/Backend/Field/Sub.lean --mode aggressive --max-passes 10`
Usage: `/skill:fvs-lean-refactor Specs/Backend/Field/Sub.lean --theorem sub_spec --report-only`

**`/skill:fvs-trust-audit <target spec file | module subtree>`**
Build-backed trust audit of an Aeneas-extracted Lean target.

- Runs `LEAN_NUM_THREADS="${LEAN_NUM_THREADS:-4}" nice -n 19 lake build` as a green-build-guarded precondition; HALTs if the target layer does not compile
- Dispatches the read-only `fvs-axiom-auditor` to introspect every in-scope declaration via `#print axioms`
- Classifies each: `sorryAx` ⇒ sorry, classical trio (propext / Classical.choice / Quot.sound) auto-noted, project-custom axioms require justification
- Strictly-scoped inventory (Rust path convention); cone members surfaced as prerequisites, never inventory rows
- Fail-if-unjustified gate (NOT-CLEAN while any project-custom in-scope axiom lacks a justification)
- Writes a re-runnable, strictly dependency-ordered table to `.formalising/audits/<target>.md`

Usage: `/skill:fvs-trust-audit Specs/Backend/Field/Sub.lean`

### Formalise (`/skill:fvs-formalise`)

The paper track: formalise maths/crypto papers, then refactor.

**`/skill:fvs-lean-formalise`**
Formalise mathematical paper content into Lean 4 specifications (paper track).

- Interactive prompts: describe task, point to resources, select KB, set module path
- Reads PDFs (via pdftotext), images (vision), markdown, LaTeX from .formalising/resources/
- Optional NotebookLM knowledge base integration (set up with /skill:fvs-kb-setup)
- Creates both definition files and spec files (unlike lean-specify which only creates specs)
- Two-phase dispatch: researcher extracts math structure, executor writes Lean files
- Shared with code track: use /skill:fvs-lean-verify for proof attempts
- Uses the indexed proof-engineering store and records source-backed paper/modeling lessons

Usage: `/skill:fvs-lean-formalise`
Result: Lean definition and spec files with sorry placeholders

**`/skill:fvs-lean-refactor <spec_file_path>`** (also in Formal-Core)
Refactor, simplify, and decompose verified Lean proofs while preserving compilation. See the Formal-Core bundle above for full details.

Usage: `/skill:fvs-lean-refactor Specs/Backend/Field/Sub.lean`

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

**`/skill:fvs-crypto-plan <topic> [nN] [--codex]`**
Author the next bounded, runtime-neutral executor plan for a topic, grounded in the paper via the NotebookLM knowledge base (answers cached under `sources/`).

Usage: `/skill:fvs-crypto-plan "CKA from KEM"`
Usage: `/skill:fvs-crypto-plan "CKA from KEM" --codex`   # hand the planning think-step to Codex

**`/skill:fvs-crypto-review <topic> [nN] [--target plan|followup] [--reviewer codex|claude|pi|other] [--model ID] [--effort LEVEL]`**
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

Usage: `/skill:fvs-crypto-review "CKA from KEM" n1 --target plan`
Usage: `/skill:fvs-crypto-review "CKA from KEM" n1 --target followup --reviewer claude --model <exact-catalog-id> --effort <supported-effort>`

Crypto plan and follow-up enter the interactive review handoff by default. To disable only that
automatic handoff, merge `"crypto_review": {"automatic": false}` into
`.formalising/fvs-config.json`. Standalone review remains available, and a trusted user may
explicitly invoke crypto execution from an unreviewed plan.

**`/skill:fvs-crypto-execute <topic> nN`**
Run the current iteration's bounded plan under the green-build guard; a failed proof triggers a short interactive redirect early. (Executor stage — takes no `--codex`.)

Usage: `/skill:fvs-crypto-execute "CKA from KEM" n1`

**`/skill:fvs-crypto-eval <topic> nN [--codex]`**
Adversarially evaluate the iteration; ends in exactly one decision (ACCEPT / FOLLOWUP / HUMAN_RULING / BLOCKED).

Usage: `/skill:fvs-crypto-eval "CKA from KEM" n1`
Usage: `/skill:fvs-crypto-eval "CKA from KEM" n1 --codex`

**`/skill:fvs-crypto-followup <topic> nN [--codex]`**
Convert eval findings into the next bounded follow-up plan; HALTs for a human ruling on a modeling decision.

Usage: `/skill:fvs-crypto-followup "CKA from KEM" n1`

### Manage (`/skill:fvs-manage`)

Session, maintenance, and setup commands.

**`/skill:fvs-configure`**
Configure the role-aware quality profile, exact runtime+stage overrides, compatibility agent
overrides, and FC/crypto review defaults through choice menus. Quality uses strongest+max for
authority artifacts, executor+xhigh for plan execution/proof filling, and smaller+high for scout
work, but only after matching an exact current runtime/provider catalog entry. Every command shows
one confirmable selection manifest; notes rebuild it before launch.

Usage: `/skill:fvs-configure`

**`/skill:fvs-update`**
Update FVS to latest version.

- Checks npm registry for newer version
- Shows changelog
- Runs `pi update npm:fv-skills-baif` to update

Usage: `/skill:fvs-update`

**`/skill:fvs-checkpoint <description>`**
Create a structured verification checkpoint commit.

- Captures current verification progress as a commit
- Records what was verified in the message

Usage: `/skill:fvs-checkpoint "verified field_add and field_sub"`

**`/skill:fvs-pause-work`**
Save verification context for a session handoff.

- Writes a handoff doc capturing current state
- Lets you resume later with `/skill:fvs-resume-work`

Usage: `/skill:fvs-pause-work` or `/skill:fvs-pause-work "mid-proof on scalar_mul"`

**`/skill:fvs-resume-work`**
Resume verification from saved handoff context.

- Restores context from a prior `/skill:fvs-pause-work` handoff
- Suggests `/skill:fvs-fc-plan` if no handoff is found

Usage: `/skill:fvs-resume-work`

**`/skill:fvs-reapply-patches`**
Reapply local modifications after an FVS update.

- Explains fork or project-local overrides for managed Pi packages
- Keeps package-managed files immutable
- Avoids update-time merge conflicts
- Use before creating a persistent customization

Usage: `/skill:fvs-reapply-patches`

**`/skill:fvs-kb-setup`**
Set up NotebookLM knowledge base integration.

- Creates Python venv in .formalising/.kb-venv/
- Installs notebooklm-py library and browser auth
- Interactive login to NotebookLM
- Registers knowledge base with domain tags in fvs-config.json
- Use --add to register additional KBs without recreating venv

Usage: `/skill:fvs-kb-setup`
Usage: `/skill:fvs-kb-setup --add`

**`/skill:fvs-help`**
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
└── fv-plans/                # Per-function/topic planning docs

Pi package root              # Managed FVS content
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
│   └── fvs-doc-syncer.md
├── commands/fvs/          # flat siblings: 5 routers + 16 commands
│   ├── aeneas.md          # router
│   ├── context.md         # router
│   ├── fc.md              # router
│   ├── formalise.md       # router
│   ├── manage.md          # router
│   ├── aeneas-extract.md
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
│   └── fvs-kb-query.py           # NotebookLM query tool (Python)
└── fv-skills/
    ├── references/          # Domain knowledge
    ├── templates/           # Spec, config, stub templates
    ├── upstream/aeneas/     # Pinned upstream documentation snapshot
    │   └── _sync-meta.json  # Mapping table for sync-aeneas-verif
    └── workflows/           # Command orchestration logic
        ├── aeneas-extract.md
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

- Run `/skill:fvs-map-code` to analyze your project
- Check `.formalising/CODEMAP.md` for verification status
- Inspect the package's `fv-skills/references/` for domain knowledge
</reference>
