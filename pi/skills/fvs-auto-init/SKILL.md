---
name: fvs-auto-init
description: Single entry for the auto track: show every stage's readiness, then reuse or record the agreement
---

<pi_package_runtime>
- This skill lives under `pi/skills/<name>/SKILL.md`; the FVS package root is `../../..` relative to its directory.
- Resolve every bundled relative path against the skill directory and pass absolute paths to tool calls and shell commands.
- Agent role instructions live under `../../../agents/`. When a workflow requests Task/subagent dispatch, use an available Pi subagent facility with the matching role instructions. If none is installed, perform the role inline and state that fresh-context separation was unavailable. Exception: a review workflow that requires a fresh reviewer must remain pending or offer its documented fallback; never perform that review inline.
- Use Pi's structured question tool when available; otherwise ask the same question in plain text.
- Never write state into the managed package. Project state belongs under the user's current project (normally `.formalising/`).
</pi_package_runtime>

<objective>
Start or resume the auto track through the AO orchestrator, the single entry. Show the compatibility
profile with every stage's readiness up front, then reuse a current applicable agreement without
Keep/Change or repeated interviewing. Use a short `/fvs:roadmap` light/deep/reuse conversation only
for what is missing: the source revision, the agreed scope (crates, modules and features), boundaries,
conventions, single-crate/monorepo layout, execution choices and the repository the draft pull
requests go to. A helper drafts the agreement and the owner only confirms it.

Persist choices and the exact declared agreement through `scripts/fvs-auto.mjs`. A missing or outdated
agreement is a warning, never a stop, and the owner records it in their own terminal. A roadmap-offer
decision alone is not agreement or authorization. Material changes need explicit confirmation; routine
progress does not reopen setup. The stored-context gate, the memory routes and the strict graph lane
are an optional section of the workflow that this entry never calls.

Output: recorded setup and agreement, and the next stage or the exact refusal. Agreement storage alone
launches no workers or proofs. The pipeline after it is fixed and the agents choose how: extract, a
draft spec pull request the owner merges, proofs, FVS's build check in a fresh clean copy, a draft proof
pull request. Later provisional cycles stay autonomous within the agreement and final PR acceptance
stays human.

Before the hand-off, init checks which steps of the run stop for an approval prompt, by running one
low-risk instance of each while the owner is present (low-risk is not inert: Lake evaluates the project's
lakefile and git can run configured hooks), and asks the owner which prompted. Only after the owner's yes
does it write a minimal project allowlist for those steps through `scripts/fvs-auto-permissions.mjs`. It also
records, after a separate yes, where pushes go. Workers push with one FVS command, `scripts/fvs-auto-push.mjs`,
which pushes one branch under the run's namespace to that recorded destination; the one push rule names that
command. It is a cooperative guard with hardening and not a security boundary, and `auto-permissions.md` says what
it checks, what it hardens and what it trusts. It never writes a rule that
allows GitHub comments, reviews, merges or a `git push`, and it stops while a project settings file already has a
`git push` allow rule. The owner can ask it to recheck permissions later, which repeats the probes of the steps
that last prompted.
</objective>

<execution_context>
@../../../fv-skills/workflows/auto-init.md
@../../../fv-skills/references/auto-setup.md
@../../../fv-skills/references/auto-permissions.md
@../../../fv-skills/references/auto-memory.md
@../../../fv-skills/references/ui-brand.md
</execution_context>

<context>
Run from the project root (the Lean project that holds `lakefile.toml` and `lean-toolchain`).
State lives under `.formalising/auto-fv/`; `auto-setup.md` explains how to keep `.formalising/`
out of git. Fresh rc2 setup requires the declared Aeneas/Charon executables locally even for an
externally prepared, validated extraction. A retained witness does not bypass `profile-blocked`;
see the prerequisite and exact-source installation steps in `auto-setup.md`.
</context>

<process>

Follow the auto-init workflow end to end. Every state change goes through `fvs-auto.mjs`; never
write or edit `state.json` by hand, and never pass `--confirm-overwrite` without the owner's
explicit confirmation of the listed changes.

The permission check is the one place init writes a settings or rules file, and only through
`fvs-auto-permissions.mjs write-allowlist` after the owner has seen the exact rules and said yes. Run it
once: a project with a permission record is not checked again.

Agents may open draft pull requests and edit a pull request body. They never post comments or reviews
on GitHub, never mark a pull request ready and never merge: only the owner comments, marks ready and
merges.

Finish with the workflow's report block, which always carries the `State:`, `Next action:` and
`Pending decision:` lines.
</process>

<codex_skill_adapter>
On Codex, every owner question in this command (the choices, a confirmation of changed choices,
the initial roadmap agreement, the permission check's answers and the allowlist confirmation) degrades
to a plain-text question and WAITS for the answer. It is fail-closed:
it never picks a default for the owner, never runs `init-state` before the owner has answered,
and never passes `--confirm-overwrite`, or `--confirm` for an allowlist, or records owner agreement/authority on the owner's behalf.
Applicable existing explicit responses are reused without another question; computing a hash is not approval.
</codex_skill_adapter>

<success_criteria>
- [ ] Stops with an actionable message when `ao` is not on PATH.
- [ ] Malformed state stops with the script's message and next step; it is never overwritten.
- [ ] The profile is shown with its stage lines before any question; a `profile-blocked` result stops with every blocking item's next step.
- [ ] Owner choices are recorded only through `init-state`; an unchanged rerun writes nothing.
- [ ] A changed choice is shown to the owner and written only after explicit confirmation.
- [ ] A current applicable agreement bypasses Keep/Change and repeated interviews; actual evidence is read.
- [ ] A missing or outdated agreement is reported as a warning and does not stop the stages; legacy offer/extraction records keep their meaning.
- [ ] Actual retained payload and current roadmap fence bind approval; status-only logs do not re-grill.
- [ ] The agreement keeps its `nonpublic-intent` mode and records the public API scope in its boundaries and claims.
- [ ] The relaxed path reads state plainly and never calls the stored-context gate, the memory routes, owned work, the driver or the re-specification command.
- [ ] No implicit grant or per-round human approval is introduced.
- [ ] Agreement storage alone launches no workers; a recorded draft pull request destination is the project's own repository.
- [ ] The permission check runs once, after telling the owner that some steps may prompt, and asks the owner which prompted; it never infers a prompt.
- [ ] A rules or settings file is written only after the owner's explicit yes on the exact preview, keeps every other key, and never writes a rule that allows a GitHub comment, review or merge, or a `git push`; the one push rule names the FVS push command, which pushes one branch under the namespace to the recorded destination and is a cooperative guard with hardening, not a security boundary (the owner is shown what it checks, hardens and trusts), and the destination is recorded after a separate yes. A write stops while a `git push` allow rule is in a project settings file, and a confirmation is bound to the project root, the real file path and the file's content.
- [ ] A Codex write never replaces or merges an existing rules file, and its recheck waits for a new session.
- [ ] The report carries the State, Next action, Permissions and Pending decision lines.
</success_criteria>
