# Changelog

All notable changes to FVS (Formal Verification Skills) will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [1.3.1] - 2026-04-07

### Fixed
- Statusline not showing FVS state in GSD delegation mode -- now detects `.formalising/` as FVS project indicator
- Update/staleness indicators never shown when GSD statusline active -- `readFvsCache()` shared across both modes
- Local install skipping FVS statusline when GSD globally present -- now wraps GSD locally via project-level settings

## [1.3.0] - 2026-04-05

### Added
- `/fvs:lean-formalise` command -- paper track for formalising mathematical papers into Lean 4 specs, 4 interactive prompts, two-phase researcher→executor dispatch, KB integration
- `/fvs:kb-setup` command -- interactive NotebookLM knowledge base setup (venv, auth, KB registration)
- `fvs-kb-query.py` composable CLI tool -- ask/list/health subcommands for querying NotebookLM KBs with structured JSON output
- `fvs-researcher` formalise mode (6th mode) -- reads resources (PDF, images, LaTeX, text), queries KB with domain gating, extracts mathematical structure, proposes Lean file layout
- `/fvs:sync-aeneas` command and workflow for continuous Aeneas upstream integration
- Aeneas upstream documentation snapshot (`fv-skills/upstream/aeneas/`) with sync mapping (`_sync-meta.json`)
- Aeneas staleness detection in session start hook -- queries GitHub API, shows warning in statusline
- Protocol verification domain pattern (Spec_pro/Spec_sec/Spec_pro|=Spec_sec) in lean-formalise
- `knowledge_bases` array in config template for domain-gated KB entries
- Installer copies `scripts/` directory to target with manifest tracking and uninstall cleanup
- Acknowledgements section in README

### Changed
- `/fvs:lean-simplify` renamed to `/fvs:lean-refactor` with expanded refactoring corpus
- `fvs-lean-simplifier` agent renamed to `fvs-lean-refactorer`
- All tactic names migrated to current Aeneas conventions: `progress`→`step`, `@[progress]`→`@[step]`, `omega` BANNED, `agrind` as default
- References enriched from upstream: aeneas-patterns (+400 lines), tactic-usage (+260 lines), proof-strategies (+300 lines), lean-refactoring (+400 lines)
- Test suite expanded from 154 to 167 tests (scripts, new commands, updated counts)

## [1.2.0] - 2026-03-16

### Added
- `/fvs:lean-spec-port` command for porting formal verification specs from other languages (Verus, F*, Coq, Dafny) to Lean -- interactive prompts, cross-project Rust source comparison, semantic blueprint translation, `--scan` flag
- `/fvs:lean-proof-port` command for porting proofs from other languages to Lean -- source proof as strategy blueprint, iterative one-sorry-at-a-time dispatch, tactic mapping (grind, bvify+bv_decide)
- `/fvs:reapply-patches` command for merging backed-up local modifications after updates
- Local patches persistence in installer -- file manifest with SHA256 hashing, automatic backup of modified files before update, runtime-specific restore suggestions
- SVG terminal logo replacing static PNG screenshot

### Changed
- Update command and workflow now include `check_local_patches` step

## [1.1.5] - 2026-03-09

### Fixed
- Codex install uses `skills/fvs-*/SKILL.md` only (removed incorrect `commands/fvs/`), matching GSD pattern
- Codex launch message shows `$fvs-help` (skill invocation syntax)

## [1.1.3] - 2026-03-09

### Fixed
- Codex install now creates `commands/fvs/` for `/fvs:*` slash commands (previously only installed skills)
- Installer shows info when both global and local installs exist (local takes priority)
- Update version detection uses path canonicalization to handle CWD=$HOME edge case

## [1.1.2] - 2026-03-09

### Fixed
- Installer now shows interactive runtime menu when `--local` or `--global` is passed without a runtime flag (previously defaulted to Claude silently)

## [1.1.1] - 2026-03-09

### Fixed
- `/fvs:update` now fetches and displays changelog entries before updating (previously showed no changelog)
- Update workflow uses local-first version detection instead of hardcoded paths
- Update cache clearing covers all runtime directories

## [1.1.0] - 2026-03-09

### Added
- `/fvs:lean-refactor` command for post-verification proof cleanup (#17) -- three modes (safe/balanced/aggressive), tiered heuristics, one change per invocation with build verification
- `fvs-lean-refactorer` agent for iterative proof refactoring
- `lean-refactoring.md` reference with proof-fuel rule, refactoring ordering, layering strategy, target selection heuristics, and repo-specific lessons
- Codex runtime support in installer (#18) -- `npx fv-skills-baif --codex`
- `/fvs:pause-work` command for session context handoff (#10)
- `/fvs:resume-work` command for session context restoration (#10)
- `/fvs:checkpoint` command for structured verification commits (#12)
- `fvs-researcher` generic research subagent for two-phase command dispatch
- `fvs-executor` generic executor subagent with VS Code diff file writing
- Model profile system (quality/balanced/budget) in `fv-skills/references/model-profiles.md`
- `npm test` regression suite -- 132 tests covering frontmatter integrity, installer round-trip, help/README parity, and cross-reference validation

### Fixed
- NL stubs now written to `.formalising/stubs/` instead of project root `stubs/` (#6)
- Statusline delegates to GSD when installed, uses correct 16.5% autocompact buffer in standalone mode (#11)

### Changed
- `/fvs:map-code` refactored to agentic two-phase dispatch (research -> execute)
- `/fvs:plan` refactored to agentic two-phase dispatch (research -> execute)
- `/fvs:lean-specify` refactored to agentic two-phase dispatch (research -> execute)
- `/fvs:lean-verify` refactored to agentic two-phase dispatch with iterative one-sorry-at-a-time executor
- Installer description updated to include Codex

## [0.1.0] - 2026-02-07

### Added
- Initial release: 7 commands, 5 agents, 5 references, 6 workflows, 3 templates
- Multi-runtime installer (Claude Code, OpenCode, Gemini)
- Session hooks (update checker, statusline)
