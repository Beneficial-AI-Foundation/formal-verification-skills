# Changelog

All notable changes to FVS (Formal Verification Skills) will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

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
- `/fvs:lean-simplify` command for post-verification proof cleanup (#17) -- three modes (safe/balanced/aggressive), tiered heuristics, one change per invocation with build verification
- `fvs-lean-simplifier` agent for iterative proof simplification
- `lean-simplification.md` reference with proof-fuel rule, simplification ordering, layering strategy, target selection heuristics, and repo-specific lessons
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
