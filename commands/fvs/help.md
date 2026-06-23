---
name: fvs:help
description: Show available FVS commands and usage guide
---

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

1. `/fvs:map-code` - Analyze project, build dependency graph
2. `/fvs:fc-plan` - Select verification targets
3. `/fvs:lean-specify <function>` - Generate spec with sorry
4. `/fvs:lean-verify <spec_path>` - Attempt proof interactively
5. `/fvs:lean-refactor <spec_path>` - Golf and clean up verified proofs
6. `/fvs:lean-formalise` - Formalise paper/math content into Lean specs

## Core Workflow

```
/fvs:map-code → /fvs:fc-plan → /fvs:lean-specify → /fvs:lean-verify → /fvs:lean-refactor → repeat
Paper track:    /fvs:lean-formalise → /fvs:lean-verify → /fvs:lean-refactor
```

## Bundles

Five router commands group the skills. Invoke a router bare to print its routing table, or with a request to forward to the matched skill.

- `/fvs:aeneas` — Aeneas/Charon extraction maintenance (aeneas-extract, sync-aeneas-verif)
- `/fvs:context` — Codebase context (map-code)
- `/fvs:fc` — Formal-correctness core (fc-plan, lean-specify, lean-verify, natural-language, lean-refactor)
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
- Parses Funs.lean for function inventory and dependency edges
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
- Generates spec with correct imports, namespace, @[step] theorem, sorry
- Validates spec structure and optional build check

Usage: `/fvs:lean-specify scalar_mul_inner`
Result: `Specs/{path}/{FunctionName}.lean` with sorry placeholder

**`/fvs:lean-verify <spec_file_path>`**
Attempt proof using domain tactics with interactive feedback.

- Interactive proof loop: agent proposes ONE tactic step at a time
- User provides feedback (goal state, errors, hints) between iterations
- Configurable max attempts (default 10, hard cap 25)
- Routes on proof status: TACTIC PROPOSED, VERIFIED, STUCK
- Updates CODEMAP.md verification status on completion

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

Usage: `/fvs:lean-formalise`
Result: Lean definition and spec files with sorry placeholders

**`/fvs:lean-refactor <spec_file_path>`** (also in Formal-Core)
Refactor, simplify, and decompose verified Lean proofs while preserving compilation. See the Formal-Core bundle above for full details.

Usage: `/fvs:lean-refactor Specs/Backend/Field/Sub.lean`

### Manage (`/fvs:manage`)

Session, maintenance, and setup commands.

**`/fvs:update`**
Update FVS to latest version.

- Checks npm registry for newer version
- Shows changelog
- Runs `npx fv-skills-baif` to update

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
- Run after `/fvs:update` if local patches were detected

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
└── fv-plans/                # Per-function planning docs

~/.claude/                   # Installed FVS content (global)
├── agents/
│   ├── fvs-researcher.md
│   ├── fvs-executor.md
│   ├── fvs-explainer.md
│   └── fvs-lean-refactorer.md
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

- Run `/fvs:map-code` to analyze your project
- Check `.formalising/CODEMAP.md` for verification status
- Inspect `~/.claude/fv-skills/references/` for domain knowledge
</reference>
