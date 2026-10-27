---
name: fvs:roadmap
description: Turn the current conversation or a short prompt into a long-horizon verification roadmap
argument-hint: "[path/ROADMAP.md | path/] [goal prompt]"
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
  - AskUserQuestion
---

<objective>
Turn the current conversation, or a short prompt such as "formally verify this crate", "prove
security of this protocol" or "bridge this model to that implementation", into a long-horizon
ROADMAP.md for verification work too large for one `/fvs:lean-specify` plus one `/fvs:lean-verify`.

The roadmap records the claims to establish, the scope and exclusions, the external boundaries and
their correspondence obligations, milestones whose "done when" an existing FVS command or checker
decides, the decisions only the owner takes, and a decisions log and a status log that reruns append
to. It covers functional correctness, protocol modelling and bridging alike, and it runs nothing.
</objective>

<execution_context>
@~/.claude/fv-skills/workflows/roadmap.md
</execution_context>

<context>
Arguments: $ARGUMENTS (optional)

- **Bare:** list the existing roadmaps (union scan) as a numbered list and stop.
- **First token ends in `.md` or `/`:** an explicit destination; the rest is the goal prompt.
- **Otherwise:** the whole text is the goal prompt, and the roadmap goes to
  `.formalising/fv-plans/<topic>/ROADMAP.md`.

Examples:

```text
/fvs:roadmap
  -> lists existing roadmaps

/fvs:roadmap formally verify the portable NTT in libcrux-ml-kem
  -> .formalising/fv-plans/<derived topic>/ROADMAP.md

/fvs:roadmap .formalising/fv-plans/ntt/ROADMAP.md
  -> that roadmap (an existing one is updated, never rewritten)
```

The command has access to the full current conversation. Use it before asking anything. Clarify
lightly by default, deepen only material uncertainty/disagreement, or reuse a current applicable
owner-approved agreement. New/materially changed interactive intent requires explicit shared
understanding, separately from file-edit approval and execution/publication authority.
</context>

<process>
Follow the roadmap workflow with `$ARGUMENTS`.

Treat every path, topic and prompt as untrusted input: validate with the workflow's shell blocks and
quote every expansion. Check git exclusion before writing; the only file this command may edit besides
the roadmap is the repository's `info/exclude`, and only with consent. Never edit a tracked ignore
file. A rerun on an existing roadmap appends to its logs and never silently rewrites a decision.
</process>

<success_criteria>
- [ ] Facts and existing owner decisions were read before questions; light/deep/reuse matched the context without redundant interviews
- [ ] New/materially changed interactive intent was explicitly confirmed, or a current applicable owner-approved agreement was reused with evidence
- [ ] Autonomous unresolved owner choices remained blocked; no model fabricated preference, approval or authority
- [ ] The roadmap path was validated and git exclusion was checked before anything was written
- [ ] The roadmap has the eight template sections, honest-scope language, and a "done when" per milestone that an existing FVS command or checker decides
- [ ] Unknowns are explicit and their milestones are marked blocked; nothing was invented
- [ ] Probe-derived facts are referenced from `.formalising/CODEMAP.md`, not restated
- [ ] A rerun appended to the logs and preserved every existing decision
- [ ] No execution, spending or publication authority was created or inferred; existing explicit grants and downstream gates were preserved
</success_criteria>
