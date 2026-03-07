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
5. `/fvs:lean-simplify <spec_path>` - Golf and clean up verified proofs

## Core Workflow

```
/fvs:map-code → /fvs:plan → /fvs:lean-specify → /fvs:lean-verify → /fvs:lean-simplify → repeat
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
Generate Lean spec skeleton following @[progress] theorem pattern.

- Resolves function in CODEMAP.md or Funs.lean directly
- Deep analysis of function body, types, and control flow
- Checks dependency spec status
- Generates spec with correct imports, namespace, @[progress] theorem, sorry
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

### Simplification

**`/fvs:lean-simplify <spec_file_path>`**
Simplify and golf verified Lean proofs while preserving compilation.

- Requires fully verified spec (zero sorry) -- run `/fvs:lean-verify` first
- Three modes: safe (zero-risk cleanup), balanced (default), aggressive (smart automation)
- Applies tiered heuristics: dead code removal, simp sharpening, tactic golf, automation replacement
- Verifies compilation after every change
- Optional --report-only flag for analysis without modification

Usage: `/fvs:lean-simplify Specs/Backend/Field/Sub.lean`
Usage: `/fvs:lean-simplify Specs/Backend/Field/Sub.lean --mode aggressive --max-passes 10`
Usage: `/fvs:lean-simplify Specs/Backend/Field/Sub.lean --theorem sub_spec --report-only`

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
│   └── fvs-lean-simplifier.md
├── commands/fvs/
│   ├── map-code.md
│   ├── plan.md
│   ├── lean-specify.md
│   ├── lean-verify.md
│   └── help.md
└── fv-skills/
    ├── references/          # Domain knowledge
    ├── templates/           # Spec, config, stub templates
    └── workflows/           # Command orchestration logic
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
- Core tactics: progress, unfold, simp, ring, field_simp, omega

## Getting Help

- Run `/fvs:map-code` to analyze your project
- Check `.formalising/CODEMAP.md` for verification status
- Inspect `~/.claude/fv-skills/references/` for domain knowledge
</reference>
