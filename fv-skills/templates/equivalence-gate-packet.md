# Equivalence-Gate Packet Template

Template for `equivalence-gate/{change-id}.md` (one packet per Category-B change)

<template>
# Equivalence-Gate Packet -- {change-id}

## 1. The change
{The minimized before/after diff -- the smallest edit that clears the blocker.
Show the exact lines removed and added. Do not paste the whole function; show
only what changed, with a line or two of context.}

```diff
- {removed line(s)}
+ {added line(s)}
```

**Site:** `{file}:{line-range}` -- `{function or item name}`
**Blocker cleared:** `{catalog id or NOVEL}` -- {one line on what was failing}

## 2. Obligation
The specific equivalence this change relies on. Tick exactly one:

- [ ] **extraction === production** (cfg-gated alternative body -- the shipped
      production body is byte-identical; only the body seen under the extraction
      feature differs)
- [ ] **fork === upstream** (ungated source rewrite -- the production source
      itself changed; the rewritten body must behave identically to the original)

"Observable" = return values, errors as callers distinguish them, external
effects. Differences invisible to every caller (a log string, an internal
variable name) are not observable; differences a caller can branch on are.

**Instantiated obligation:** {state the equivalence concretely for THIS change,
e.g. "on a non-canonical input, the rewritten function's observable behaviour
equals the original's".}

## 3. Drafted equivalence argument
{The case that the obligation in section 2 actually holds, written by an
independent assessor (NOT the agent that proposed the change). Be honest about
every assumption it rests on -- name the inputs, the callers, and the error
paths it depends on. State what would make the argument false.}

## 4. Blast radius
{What a caller could distinguish between before and after. List the observers:
direct callers, error matchers, any external interface. For each, say whether it
can branch on the difference. The classic miss: "this error variant is
equivalent" when some caller pattern-matches the specific variant.}

## 5. Alternatives considered
{Could this have been a lower-cost, non-meaning-bearing change?}

- Could this be an annotation instead of an edit (`charon::opaque` /
  `charon::exclude` / fill an `*External*_Template`)? {Why / why not.}
- Could the production body stay pristine by gating the change
  (extraction === production) rather than rewriting the source
  (fork === upstream)? {Why the chosen obligation was necessary.}
- {Any other route, and why it was rejected.}

## 6. Coverage rationale
{What verified coverage this change PRESERVES -- the reason source work is done
here instead of just trusting (axiomatizing) the item. If the cheap escape would
have been to make the item opaque, say what that would have erased from the
verified deliverable.}

## 7. Independent checklist
The reviewer's OWN checks. Do NOT simply accept the drafted argument in
section 3 -- that would re-collapse the independent judgment the gate exists to
provide. Tick each only after checking it yourself:

- [ ] **Is the obligation the right one?** Does section 2 name the correct
      equivalence for this kind of change?
- [ ] **Is the argument sound?** Not just plausible -- does it actually hold,
      including edge cases and error paths?
- [ ] **Are there observers the assessor missed?** Any caller, error matcher, or
      external interface that *can* distinguish before/after?
- [ ] **Is there a cheaper alternative overlooked?** A config-only route, a
      tighter opacity that keeps coverage?
- [ ] **Is the divergence acceptable and reversible?** For a fork === upstream
      change, is drifting from upstream here worth it, and can it be reverted
      when the tool is fixed?

If any box fails: **reject**, with the reason recorded below. The change is not
ratified; the loop must propose a smaller/different change rather than re-submit
the identical one.

---

## Ratification token
Stamped by the human reviewer once every box in section 7 passes. The success
oracle refuses to mark the run "complete" while this token is absent -- a packet
with no token is not a ratified change.

```
Reviewed-by: {name}
equivalence-ratified: {YYYY-MM-DD}
```

(Rejection, if any: record the reason here so the loop does not re-propose the
identical change.)
</template>

<guidelines>
## How to Fill Each Section

### Who fills what -- the independence rule
The gate works only because no single party both proposes a meaning-bearing
change and clears it. Three distinct roles:

- **The proposing agent** drafts section 1 (the minimized diff) -- it found the
  blocker and the smallest edit that clears it.
- **A separate, high-effort assessor agent** drafts sections 2-6 (the obligation,
  the equivalence argument, blast radius, alternatives, coverage rationale). It
  is NOT the proposing agent: a party that authored a change cannot be the
  independent judge of whether the change preserves meaning.
- **The human reviewer** works section 7 (their own independent checks) and, only
  if every box passes, stamps the ratification token.

Reviewer competence required = **Rust expertise** (the obligation is observable
Rust-behaviour equivalence). It is NOT a crypto or Lean review. The packet is
optimised for a Rust-literate reviewer to ratify quickly and confidently.

### 1. The change
Minimize first. A reviewer should see the smallest edit that clears the blocker,
not a refactor bundled with it. If clearing the blocker truly needs several
lines, show them all -- but nothing extra.

### 2. Obligation
Pick the obligation from the *kind* of change, not from how risky it feels. A
cfg-gated alternative body owes **extraction === production** (the ship path is
untouched, so you owe that the extraction-only body matches it). An ungated
rewrite of the real source owes **fork === upstream** (you changed what ships, so
you owe that it matches the original upstream). Prefer the gated form when
otherwise equal -- it keeps production pristine -- but either way someone must
defend an equivalence.

### 3. Drafted equivalence argument
Name the assumptions explicitly. "Both error variants are treated by every caller
as the same failure class" is an assumption the reviewer can check; "obviously
equivalent" is not. State what input or caller would break the argument.

### 4. Blast radius
Enumerate observers, do not hand-wave "no one cares". A single caller that
pattern-matches a discarded error variant is enough to falsify the obligation.

### 5. Alternatives considered
This is where the assessor must justify NOT taking a cheap opacity escape when
the item is a verification target. If the function could have been made opaque,
say why that was unacceptable (usually: it would shrink required coverage).

### 6. Coverage rationale
Tie the change back to the deliverable. The reason to do meaning-bearing source
work at all is to keep a target function transparent and verified rather than
axiomatized.

### 7. Independent checklist + token
The reviewer must re-derive, not rubber-stamp. The token is a mechanically
checkable field: a downstream success oracle greps for `equivalence-ratified:`
and fails the run if it is missing. No token, no completion.
</guidelines>

<evolution>
## Packet Lifecycle

A gate packet is not a throwaway review form -- it is the permanent reversible
record for the change it gates. Audit trail and gate are one artifact.

1. **Proposed.** The proposing agent isolates the blocker, minimizes the edit,
   and fills section 1. At this point the packet is incomplete and the
   orchestrator must NOT present it as ready for review.

2. **Independently assessed.** A separate high-effort assessor fills sections 2-6
   -- the obligation, the equivalence argument, blast radius, alternatives, and
   coverage rationale. The proposer does not write these.

3. **Ratified (or rejected).** The human reviewer works section 7's checklist
   independently. If every box passes, they stamp the ratification token; the
   change is now a ratified Category-B change. If any box fails, they record the
   rejection reason; the loop must propose a different/smaller change and never
   re-submit the identical one.

4. **Becomes the reversible record.** The ratified packet -- its minimized diff
   plus the stamped token -- IS the reversible record for this B-change. The diff
   is machine-reversible (revert the exact lines); the token proves a human judged
   the meaning preserved. There is no second audit document: the gate artifact and
   the audit trail are the same file.

5. **Reconciled on re-extraction / pin bump.** When the toolchain pin advances or
   the source is re-extracted, the change is revisited: if the upstream defect that
   forced it is now fixed in the *pinned* toolchain, the diff can be reverted and
   the packet retired. Until the pin actually carries the fix, the change stands
   and the packet remains the record.

Packets are living records of a meaning-bearing decision -- they persist for the
life of the verification, not just the review.
</evolution>

<example>
## Worked Example: an error-variant rewrite

The recipient-side entry function crashed the symbolic interpreter with the
diagnostic "There should be no bottoms in the value". Bisection isolated the
trigger to an early-return `Err` carrying a `&'static str` literal payload. The
proposed fix replaced that one statement with a payload-free error variant.

---

# Equivalence-Gate Packet -- accept-entry-err-variant

## 1. The change

```diff
- return Err(InvalidMessage(PreKeyKind, "incoming base key is invalid"))
+ return Err(InvalidKeyAgreement)
```

**Site:** the recipient-side accept entry function -- the early-return error path.
**Blocker cleared:** `NO-BOTTOMS` -- the symbolic interpreter aborts on the
early-return `Err` whose variant carries a `&'static str` literal payload.

## 2. Obligation
- [ ] **extraction === production**
- [x] **fork === upstream** (ungated source rewrite -- the shared source itself
      changed; production now uses the rewritten error path)

"Observable" = return values, errors as callers distinguish them, external
effects.

**Instantiated obligation:** on the exact non-canonical input that reaches this
early return, the rewritten function's observable behaviour (the error a caller
receives and can branch on) equals what the original function would have
produced.

## 3. Drafted equivalence argument
The discarded string `"incoming base key is invalid"` was a log/diagnostic
message, not a value any caller inspects -- so dropping it changes nothing
observable. Every caller treats both `InvalidMessage(PreKeyKind, _)` and
`InvalidKeyAgreement` as the same failure class ("key agreement failed") and
none pattern-matches the specific discarded variant within scope. Moreover, on
this exact input the immediately-following key-agreement step would itself have
returned `InvalidKeyAgreement` one statement later -- so the rewritten variant is
precisely what the original would have produced anyway, one step earlier.
**Assumption it rests on:** no in-scope caller branches on the specific
`InvalidMessage(PreKeyKind, _)` variant; if one did, the argument is false.

## 4. Blast radius
Observers: the callers of the accept entry function and their error matchers. All
treat both variants as the same "key agreement failed" class. No caller in scope
pattern-matches the discarded `InvalidMessage(PreKeyKind, _)` variant distinctly.
No external interface serializes the discarded string.

## 5. Alternatives considered
- Make the function opaque (`charon::opaque`)? Rejected: this is the single most
  important function in the extraction; axiomatizing it would destroy the
  deliverable (see section 6).
- Keep production pristine via a cfg-gated body (extraction === production)?
  Considered as the lower-divergence route; the team chose the ungated rewrite to
  keep a single shared source and accepted the upstream divergence, which is
  small (a discarded log string on an error path).

## 6. Coverage rationale
Leaving the function opaque would axiomatize the most important function in the
extraction, erasing it from the verified deliverable. The rewrite keeps the body
transparent and fully verified -- that preserved coverage is the entire reason
for doing source work here instead of trusting the function.

## 7. Independent checklist
- [x] **Is the obligation the right one?** Yes -- an ungated source rewrite owes
      fork === upstream.
- [x] **Is the argument sound?** Checked: confirmed no in-scope caller
      distinguishes the two variants, and the downstream agreement step would
      itself yield `InvalidKeyAgreement`.
- [x] **Are there observers the assessor missed?** No caller, matcher, or external
      interface distinguishes before/after within scope.
- [x] **Is there a cheaper alternative overlooked?** The only cheaper route was
      opacity, which would destroy required coverage -- correctly rejected.
- [x] **Is the divergence acceptable and reversible?** Yes -- a discarded log
      string on an error path; revertible if the interpreter defect is fixed.

---

## Ratification token

```
Reviewed-by: reviewer (Rust)
equivalence-ratified: 2026-05-08
```

The interim opacity that had been used to get past the blocker was then removed,
and the function is verified transparently. This packet -- the one-line diff plus
the stamped token -- is the reversible record for the change.
</example>
