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

**FVS** (Formal Verification Skills) encodes expert verification workflow for Rust code formally verified in Lean 4 via Aeneas.

## Quick Start

1. `/fvs:map-code` - Analyze project, build dependency graph
2. `/fvs:plan` - Select verification targets
3. `/fvs:lean-specify <function>` - Generate spec with sorry
4. `/fvs:lean-verify <spec_path>` - Attempt proof interactively
5. `/fvs:lean-refactor <spec_path>` - Golf and clean up verified proofs
6. `/fvs:lean-spec-port` - Port specs from other FV languages
7. `/fvs:lean-proof-port` - Port proofs from other FV languages

## Core Workflow

```
/fvs:map-code → /fvs:plan → /fvs:lean-specify → /fvs:lean-verify → /fvs:lean-refactor → repeat
Cross-language: /fvs:lean-spec-port → /fvs:lean-proof-port → /fvs:lean-refactor
```

### Analysis

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

**`/fvs:plan`**
Pick next verification targets via dependency graph analysis.

- Reads `.formalising/CODEMAP.md` (run `/fvs:map-code` first)
- Computes bottom-up verification order from dependency graph
- Evaluates candidates for complexity, leverage, and risk
- Presents interactive ranked selection
- Identifies "ready now" vs "blocked" functions

Usage: `/fvs:plan` or `/fvs:plan <function_name>`

### Specification

**`/fvs:lean-specify <function_name>`**
Generate Lean spec skeleton following @[step] theorem pattern.

- Resolves function in CODEMAP.md or Funs.lean directly
- Deep analysis of function body, types, and control flow
- Checks dependency spec status
- Generates spec with correct imports, namespace, @[step] theorem, sorry
- Validates spec structure and optional build check

Usage: `/fvs:lean-specify scalar_mul_inner`
Result: `Specs/{path}/{FunctionName}.lean` with sorry placeholder

### Verification

**`/fvs:lean-verify <spec_file_path>`**
Attempt proof using domain tactics with interactive feedback.

- Interactive proof loop: agent proposes ONE tactic step at a time
- User provides feedback (goal state, errors, hints) between iterations
- Configurable max attempts (default 10, hard cap 25)
- Routes on proof status: TACTIC PROPOSED, VERIFIED, STUCK
- Updates CODEMAP.md verification status on completion

Usage: `/fvs:lean-verify Specs/Backend/Field/Sub.lean`
Usage: `/fvs:lean-verify Specs/Backend/Field/Sub.lean --max-attempts 15`

### Refactoring

**`/fvs:lean-refactor <spec_file_path>`**
Refactor, simplify, and decompose verified Lean proofs while preserving compilation.

- Requires fully verified spec (zero sorry) -- run `/fvs:lean-verify` first
- Three modes: safe (zero-risk cleanup), balanced (default), aggressive (smart automation)
- Applies tiered heuristics: dead code removal, simp sharpening, tactic golf, automation replacement
- Verifies compilation after every change
- Optional --report-only flag for analysis without modification

Usage: `/fvs:lean-refactor Specs/Backend/Field/Sub.lean`
Usage: `/fvs:lean-refactor Specs/Backend/Field/Sub.lean --mode aggressive --max-passes 10`
Usage: `/fvs:lean-refactor Specs/Backend/Field/Sub.lean --theorem sub_spec --report-only`

### Porting

**`/fvs:lean-spec-port`**
Port formal verification spec from another language to Lean.

- Interactive prompts: source language, project path, function name
- Language-agnostic: supports Verus, F*, Coq, Dafny
- Compares Rust source between both projects to prevent spec mismatch
- Generates idiomatic Lean spec using source as semantic blueprint
- Reads existing verified specs in target project for style matching
- Optional `--scan` flag: compare verified functions across both projects

Usage: `/fvs:lean-spec-port`
Usage: `/fvs:lean-spec-port --scan`

**`/fvs:lean-proof-port`**
Port formal verification proof from another language to Lean.

- Same interactive prompts as lean-spec-port
- Requires existing Lean spec file (run `/fvs:lean-spec-port` first)
- Uses source proof as strategy blueprint (not structural mirror)
- Maps source tactics to Lean equivalents (e.g., Verus SMT -> `grind`)
- Iterative proof loop: one sorry at a time, user verifies each step
- Configurable max attempts (default 10, hard cap 25)

Usage: `/fvs:lean-proof-port`
Usage: `/fvs:lean-proof-port --scan --max-attempts 15`

### Support

**`/fvs:natural-language <function_name>`**
Generate detailed natural-language explanation of a function.

- Creates stubs/ markdown file with pre/post conditions
- Explains algorithmic meaning and mathematical properties
- Useful for understanding complex functions before verification

Usage: `/fvs:natural-language scalar_mul`

**`/fvs:update`**
Update FVS to latest version.

- Checks npm registry for newer version
- Shows changelog
- Runs `npx fv-skills-baif` to update

Usage: `/fvs:update`

**`/fvs:reapply-patches`**
Reapply local modifications after an FVS update.

- Detects backed-up patches from `fvs-local-patches/` directory
- Merges user modifications into newly installed version
- Handles conflicts with user input
- Run after `/fvs:update` if local patches were detected

Usage: `/fvs:reapply-patches`

**`/fvs:sync-aeneas`**
Sync Aeneas upstream documentation and update FVS references.

- Reads `_sync-meta.json` mapping table for upstream-to-FVS section mapping
- Fetches latest Aeneas docs from GitHub, diffs against stored snapshot
- Maps changes to affected FVS reference files
- Interactive: user approves each proposed change
- Detects tactic renames and propagates across FVS content
- Updates snapshot files and metadata

Usage: `/fvs:sync-aeneas`

**`/fvs:help`**
Show this command reference.

## Files & Structure

```
.formalising/                # FVS state directory (per-project)
├── CODEMAP.md               # Function inventory, deps, verification status
└── fv-plans/                # Per-function planning docs

~/.claude/                   # Installed FVS content (global)
├── agents/
│   ├── fvs-dependency-analyzer.md
│   ├── fvs-code-reader.md
│   ├── fvs-lean-spec-generator.md
│   ├── fvs-lean-prover.md
│   └── fvs-lean-refactorer.md
├── commands/fvs/
│   ├── map-code.md
│   ├── plan.md
│   ├── lean-specify.md
│   ├── lean-verify.md
│   ├── lean-refactor.md
│   ├── lean-spec-port.md
│   ├── lean-proof-port.md
│   ├── reapply-patches.md
│   ├── sync-aeneas.md
│   └── help.md
└── fv-skills/
    ├── references/          # Domain knowledge
    ├── templates/           # Spec, config, stub templates
    ├── upstream/aeneas/     # Pinned upstream documentation snapshot
    │   └── _sync-meta.json  # Mapping table for sync-aeneas
    └── workflows/           # Command orchestration logic
        ├── lean-spec-port.md
        ├── lean-proof-port.md
        └── sync-aeneas.md
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
