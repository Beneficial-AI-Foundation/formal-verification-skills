---
id: pe-YYYYMMDD-HHMMSS-short-slug
track: fc | crypto | shared
kind: proof-pattern | modeling-decision | failed-approach | preference
scope: project | topic/module/function/theorem/primitive
status: provisional | validated | superseded
source_command: fvs:command-name
created: YYYY-MM-DD
updated: YYYY-MM-DD
superseded_by: ""
---

# Short, specific lesson title

Keep this record at or below 800 words. If it contains multiple reusable insights, split them into
separate lesson files and index rows instead of extending this file indefinitely.

## Lesson

State one reusable insight. Do not combine unrelated lessons in this file.

## Applicability

Name the exact track, topic, module, function, theorem, primitive, or proof shape where this helps.

## Evidence

Record concise, reproducible evidence:

- FC proof pattern: green Lean build, source-derived fact, or observed Lean diagnostic.
- Crypto proof pattern: green Lean build or observed Lean diagnostic.
- Crypto modeling decision: paper/standard section citation plus accepted adversarial eval or an
  explicit human ruling. A source-cited but not-yet-reviewed choice remains `provisional`.
- Preference: the user's direct statement; never infer preferences from behavior.

Do not store secrets, raw transcripts, full error dumps, unsupported guesses, or uncited claims.

## Boundaries and Failure Modes

Describe when the lesson does not apply, known counterexamples, and assumptions that must hold.

## Reuse Checklist

- [ ] Target and assumptions match.
- [ ] Evidence is still current.
- [ ] Primary source or Lean result has not changed.

## Related Lessons

Link related or superseded records using paths relative to `proof-engineering/index.md`.
