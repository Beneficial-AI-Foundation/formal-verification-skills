# Changelog

All notable changes to FVS (Formal Verification Skills) will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added
- `/fvs:crypto-review` sends an initial or follow-up crypto plan to authenticated Codex for an
  independent pre-execution adversarial review. Codex runs xhigh, effort-only, ephemeral, and
  read-only; the FVS wrapper persists one validated review artifact and the primary planning seat
  records its evidence-backed response. Codex-authored/unknown-provenance plans and non-APPROVE
  verdicts fail closed before execution.

### Changed
- `/fvs:lean-specify` and `/fvs:lean-verify` now discover and fully load the target repository's
  style guide (configurable with `project.style_guide_path`) into both research and execution
  prompts. A shipped post-write checker enforces the repository line limit (100-column fallback)
  and rejects new ordinary identifiers with three or more namespace dots; verification preserves
  legacy debt only through an explicit baseline and requires full compliance for statement edits.

### Fixed
- FVS installs now verify the shipped Aeneas `_sync-meta.json` mapping and the sync command reports
  real update/reinstall recovery instead of a nonexistent Aeneas installer option.
- The config template now uses the top-level model schema consumed by commands and defaults
  `fvs-crypto-thinker` to `inherit`.

## [2.0.3] - 2026-07-04

### Changed
- The crypto formalisation loop now drives a dedicated crypto executor with an `implement -> check -> complete -> escalate -> BLOCKED` discipline, replacing the borrowed functional-correctness one-sorry-at-a-time proof-attempt grind that did not fit crypto work.
- `/fvs:crypto-execute` gained a runtime-agnostic executor model/effort knob resolved at dispatch time (explicit flag, then a config `model_overrides` entry, then an interactive ask, then inherit the default) so the executor is never hard-pinned to one model.
- The crypto thinker's plan mode is fenced to producing statements rather than proofs, with an added escalate-to-user tier when a step exceeds its remit.
- Guidance now treats `lake build` as the style authority for crypto work, and isolation checks skip the package's own style linters to avoid contradictory signals.
- `/fvs:lean-verify` received a minimal refresh keeping proof-attempt behavior functional-correctness-scoped, decoupling it from the crypto executor without a rewrite.

### Fixed
- Codex `hooks.json` is now written in the nested `{ hooks: { ... } }` shape that current Codex expects; pre-existing flat hook files are migrated on reinstall while foreign entries are preserved.
- Corrected the crypto-plan knowledge-base invocation path so KB querying resolves the intended interpreter and script location.

## [2.0.2] - 2026-07-02

### Fixed
- Codex installs now enable hooks with `[features].hooks = true` instead of an invalid root-level `hooks = true`, which current Codex parses as the hooks config table and rejects at startup.

## [2.0.1] - 2026-07-01

Documentation polish. No code or behavior changes.

### Changed
- README "How It Works" now documents the Aeneas extraction repair loop, the trust audit, and the paper track's crypto loop -- previously only the v1.x five-stage functional-correctness flow was described; the tagline and Prerequisites now cover both the code and paper tracks
- `/fvs:help` documents the crypto loop's `--codex` single- vs dual-runtime flag (which stages accept it, what it swaps, and the no-silent-fallback behavior), and Quick Start / Core Workflow now surface the extraction and crypto-loop entry points
- Install screenshot (`assets/terminal.svg`) version label updated to the v2.0 line

## [2.0.0] - 2026-06-30

Structural cleanup and bundle architecture. Updating from v1.3 applies all renames, moves, and removals automatically (deleted and renamed commands/agents self-heal on install); the installer prints a one-time summary of the changes below.

### Added
- Five bundle router commands grouping the command surface by track: `/fvs:aeneas`, `/fvs:fc`, `/fvs:formalise`, `/fvs:context`, `/fvs:manage` -- each carries a `requires:` frontmatter list and a "User wants -> Invoke" routing table; invoked bare they print the table, invoked with a prompt they route to the matched member skill
- Aeneas extraction repair loop -- `/fvs:aeneas-extract` drives an extract -> classify -> fix -> document -> re-extract loop over a Rust crate, reached via the `/fvs:aeneas` router; six dedicated agents back it: `fvs-extract-classifier` (categorises each extraction blocker), `fvs-extract-applier` (applies the chosen fix), `fvs-extract-bisector` (isolates the failing construct), `fvs-equivalence-assessor` (independent semantic-equivalence review), `fvs-draft-investigator` (drafts upstream issues/PRs), and `fvs-doc-syncer` (reconciles docs)
- Reversible source-modification records for extraction -- every source change is captured as `src-modifications.diff` + a derived `src-modifications.json` and `src-assumptions.md` at the crate root; annotations are preferred over edits and generated files are never written into the source tree, so an extraction run is always reversible and auditable
- Orchestrator-fired Category-B equivalence gate -- an ungated source rewrite halts the loop with a reviewable 7-field gate packet rendered to disk; an independent assessor produces the review, and the loop does not re-extract until the `equivalence-ratified:` oracle token is stamped by hand (self-ratification is impossible)
- Extraction pin audit -- the Charon / Aeneas / Lean / Rust toolchain pins plus lakefile rev drift are checked with a warn-and-confirm prompt before extraction starts; the acknowledgment is stamped into the reversible records as `pin_context`
- Per-blocker attempt caps + no-progress escalation for the extraction loop -- a same-signature recurrence escalates after the attempt cap rather than looping indefinitely; minimal working/failing examples (MWE/MFE) and drafted Charon/Aeneas issues and PRs are written to disk as HTML+MD and never auto-opened
- `/fvs:sync-aeneas-verif` config-driven clone mining -- mines local Charon and Aeneas clones at configured paths and reports clone staleness gracefully when a clone lags upstream
- Crypto formalisation loop -- `/fvs:crypto-plan` / `/fvs:crypto-execute` / `/fvs:crypto-eval` / `/fvs:crypto-followup` drive a topic-based iteration loop laid out under `fv-plans/<topic>/{plans,reviews,sources,merge}`, reached via the new `/fvs:formalise` router; the executor plans are bounded and runtime-neutral, and the eval writes exactly one of ACCEPT / FOLLOWUP / HUMAN_RULING / BLOCKED per round
- `fvs-crypto-thinker` agent + dual-runtime Codex-thinker mode -- single-runtime mode pairs a high-effort `fvs-crypto-thinker` with `fvs-executor`; dual-runtime mode delegates the thinking step to an FVS-owned minimal Codex CLI invocation via `scripts/fvs-codex-think.mjs`, artifact-mediated with no live bridge; NotebookLM KB querying is intensive with a loud-fail-once contract, a labeled degraded mode when the KB is unconfigured, and on-disk answer caching
- `/fvs:trust-audit` + `fvs-axiom-auditor` agent -- a build-backed `#print axioms` audit of a Lean target that inventories only the target's own declarations in fully-qualified strict scope, classifies each as verified / sorry / axiom (treating any `sorryAx` dependence as a `sorry`), notes the classical trio (`propext` / `Classical.choice` / `Quot.sound`) as Lean/Mathlib-standard, and reports NOT-CLEAN while any project-custom axiom lacks a justification, in a dependency-ordered table
- `/fvs:pause-work [path] [note]` destination argument -- write a handoff to a chosen file (path ending `.md`) or directory (`<path>/.continue-here.md`), enabling per-topic handoffs without clobbering the default; every handoff carries an `fvs_handoff: true` frontmatter marker
- `/fvs:resume-work` discovers custom-named handoffs via the `fvs_handoff` marker scan in addition to the `.continue-here.md` glob, and presents a recency-sorted picker

### Changed
- Renamed `/fvs:plan` to `/fvs:fc-plan` (clean break, no alias stub); all cross-references, the underlying workflow, and tests updated in lockstep
- Superseded `/fvs:sync-aeneas` with `/fvs:sync-aeneas-verif` (clean break, no alias stub) -- the doc sync now fans out to two specialised agents: tactics/Lean-syntax sync (the existing `_sync-meta.json` mapping + tactic-rename machinery) and extraction-docs sync, which also reconciles the Aeneas extraction blocker catalog against live upstream (retire / update-signature / still-open, reconcile-not-append); mines the config-driven local Charon + Aeneas clones and reports clone staleness gracefully
- `help.md` and README regrouped by bundle (`lean-refactor` is dual-listed in both `fc` and `formalise`; `map-code` in `context`; `sync-aeneas` in `aeneas`); Quick Start and Core Workflow narrative kept up top
- Codex re-sync from upstream GSD -- the Codex install now follows an effort-only model policy (each agent carries a `model_reasoning_effort`, the `model` is inherited from Codex with no `model` line emitted); the Codex skill-adapter header was re-derived from GSD with a fail-closed execute mode and multi-select handling, dropping the old blanket `Task(` / `AskUserQuestion` word-replace
- Codex config strip is now TOML-section-aware -- it handles legacy `[[agents]]` tables and prunes orphaned per-agent `.toml` files; GSD and FVS coexist across both surfaces (`config.toml` `[agents.*]` / `[model]` tables and the `hooks.json` SessionStart entries), with full Codex hooks parity (the `fvs-check-update` SessionStart hook)

### Removed
- Cross-language port commands `lean-spec-port` and `lean-proof-port` and their workflows (Verus / F* / Coq / Dafny porting); v2.0 is Lean-focused
- The Verus framework-detection branch in `checkpoint` (no more `checkpoint(verus):` commit prefix)
- The four legacy v1.0 agents `fvs-dependency-analyzer`, `fvs-code-reader`, `fvs-lean-spec-generator`, `fvs-lean-prover`
- "Extensible to Verus" positioning from README and help

### Migration
- Updating from v1.3 applies all renames and removals automatically -- no orphaned commands, agents, or manifest entries
- If you locally edited `plan.md`, it is backed up under its old name in `fvs-local-patches/` and must be merged into `fc-plan.md` manually (there is no automatic rename-alias map)
- The Codex per-agent `.toml` cleanup for removed agents lands in a future release

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
