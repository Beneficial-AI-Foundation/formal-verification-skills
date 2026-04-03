<purpose>
Orchestrate specification porting from another formal verification language to Lean
using two-phase subagent dispatch (research -> execute).

Takes a source language, source project path, and function name. Dispatches
fvs-researcher to analyze both projects cross-referentially, then dispatches
fvs-executor to write an idiomatic Lean spec grounded in the source spec's
mathematical content.

The source spec is treated as a SEMANTIC BLUEPRINT -- the mathematical meaning
guides the Lean spec, not the source syntax.

Output: Specs/{path}/{FunctionName}.lean with @[step] theorem and sorry placeholder,
ported from the source language spec.
</purpose>

<concept_mapping>
## Source Language to Lean Concept Mapping

When porting from any source language to Lean, the researcher and executor must
translate concepts rather than syntax. The following table covers the most common
mappings (Verus is the primary concrete example; other languages follow similar patterns).

| Source Concept | Source Syntax (Verus) | Lean Equivalent | Notes |
|----------------|----------------------|-----------------|-------|
| Spec function | `pub open spec fn f(x) -> T` | `def f (x : X) : T := ...` in Defs.lean | Mathematical definitions |
| Precondition | `requires P` | Hypothesis `(h : P)` in theorem signature | Same semantics |
| Postcondition | `ensures Q` | `exists result, f x = ok result /\ Q` | Different surface form |
| Named spec predicate | `u64_5_bounded(limbs, 54)` | Inline: `forall i < 5, limbs[i]!.val < 2 ^ 54` | Lean favors inline hypotheses |
| Interpretation fn | `u64_5_as_nat(fe.limbs)` | `Field51_as_Nat limbs` | Same mathematical concept |
| vstd arithmetic | `vstd::arithmetic::div_mod::*` | `Mathlib.Algebra.*`, `omega`, `ring` | Different standard libs |
| SMT assertion | `assert by (compute)`, Z3-backed | `grind` (primary), `omega`, `simp`, `decide` | `grind` is Lean's SMT analog: E-matching and case splitting |
| Bitwise assertion | `assert(...) by (bit_vector)` | `bvify N; bv_decide` | `bvify` lifts to bitvectors, `bv_decide` decides |
| Extensional equality | `assert(a =~= b)` | `ext`, `funext`, or `grind [Subtype.ext]` | Similar concept |
| Loop invariant | `invariant I` | Not directly used (Aeneas extracts loops differently) | May need manual handling |
| Trigger annotation | `#[trigger]` | Not needed in Lean | No SMT triggers |

**Key insight for proof porting:** Do NOT map Verus SMT reasoning to `omega`/`simp`/`decide`
alone. The primary analog is `grind`, which handles the same class of reasoning (arithmetic,
equality, case analysis) that Z3 handles for Verus. Use `bvify N; bv_decide` for bitwise
operations (AND, OR, shift, masking).
</concept_mapping>

<process>

<step name="collect_parameters">
Collect all parameters via interactive prompts. No flags to remember -- the command
asks for everything it needs.

**Parse --scan flag from $ARGUMENTS:**
```bash
SCAN_MODE=false
if echo "$ARGUMENTS" | grep -q "\-\-scan"; then
  SCAN_MODE=true
fi
```

**Interactive prompts (using AskUserQuestion):**

1. Source language: numbered options (Verus, F*, Coq, Dafny, Other)
2. Source project path: free text, validated with `[ -d "$PATH" ]`
3. Function name: free text (skip if --scan mode -- scan shows all functions)

**Detect target Lean project:**
```bash
[ -f "lakefile.toml" ] || [ -f "lakefile.lean" ] && echo "Lean project" || echo "Not Lean"
```

If not a Lean project: ask user for target project path via AskUserQuestion.
Default: current directory.

**Validation:**
- Source project path must exist
- Target project must contain Lean markers (lakefile.toml or lakefile.lean)
- If either fails: re-prompt user
</step>

<step name="resolve_models">
Read config and resolve models for subagent dispatch.

```bash
CONFIG=$(cat .formalising/fvs-config.json 2>/dev/null || echo '{"model_profile":"quality","model_overrides":{}}')
```

Resolution sequence:
1. Parse `model_profile` from config (default: `"quality"`)
2. Check `model_overrides` for `"fvs-researcher"` and `"fvs-executor"`
3. If no override, look up profile table for the agent and profile
4. Store resolved models as `RESEARCH_MODEL` and `EXECUTOR_MODEL`

Reference: fv-skills/references/model-profiles.md (profile table and dispatch pattern)
</step>

<step name="research_phase">
Dispatch **fvs-researcher** subagent in spec-port mode to gather cross-project context.

Read and inline reference files before dispatch:
- fv-skills/references/aeneas-patterns.md (type translation patterns)
- fv-skills/references/lean-spec-conventions.md (postcondition patterns)

Researcher tasks (expanded from lean-specify for cross-project analysis):
1. **If --scan mode:** scan both projects for verified/unverified functions, build
   comparison table showing status in both source and target projects
2. **Find Rust source function in BOTH projects.** Compare signatures and bodies.
   If differences found: report the diff and flag for user confirmation.
3. **Read the source spec** and extract mathematical content:
   - Verus: look in `verus! { }` blocks for `spec fn` with `ensures`/`requires`
   - F*: look for `val`/`let` with refinement types
   - Coq: look for `Theorem`/`Lemma`
   - Dafny: look for `ensures`/`requires`
   Extract: pre/postconditions, bounds, interpretation functions, mathematical meaning.
   The source spec is a semantic blueprint -- understand WHAT is proven, not how.
4. **Read 2-3 existing verified Lean specs** in target project's Specs/ directory
   (no sorry remaining). Identify style conventions: naming, import patterns, comment
   style, theorem structure, whether hypotheses are inline or named.
5. **Check for CONTRIBUTING.md or style guide** in the target project.
6. **Check for mathematical bridges** in the target project: Defs.lean, Math/ directory,
   interpretation functions (e.g., Field51_as_Nat, Scalar52_as_Nat), constants (p, L).
7. **Determine output path:** Specs/{module_path}/{FunctionName}.lean

**Handling Rust source differences:**
If researcher reports that the Rust function body or signature differs between the
two projects: present the diff to user via AskUserQuestion. User may accept negligible
differences or abort the port.

**If --scan mode:** researcher returns comparison table. Display to user using FVS
status symbols ([OK], [??], [--]). User selects a function. Re-dispatch researcher
for that function in non-scan mode.

Expected output: Structured findings with semantic blueprint of what the source spec
proves, target project conventions, mathematical bridges, and recommended output path.
Ends with `## RESEARCH COMPLETE`.

**If researcher returns ## ERROR:** Display the error and stop.
</step>

<step name="execute_phase">
Dispatch **fvs-executor** subagent in spec-port mode to write the Lean spec file.

Inline into executor prompt:
- Research findings from previous step
- Spec file template (fv-skills/templates/spec-file.lean)
- Target output path

**Spec generation requirements (idiomatic Lean, NOT source syntax):**
- Use `@[step]` theorem pattern (NOT source language's theorem form)
- Use Aeneas types: `(Array U64 5#usize)` notation
- Use target project's interpretation functions (e.g., `Field51_as_Nat`)
- Inline hypotheses where the target project does so (NOT named predicates from source)
- Cross-reference mathematical content with Rust source -- source spec might be wrong
- Include `sorry` as proof placeholder
- Match the style of existing verified specs in the target project
- Include natural language description block before the theorem

**CRITICAL:** The source spec is a SEMANTIC BLUEPRINT. Extract the mathematical meaning
and translate it to Lean conventions. Do NOT syntactically mirror the source.

Executor writes the spec file using the Write tool (VS Code diff).
User approves the diff inline.

Expected output: Ends with `## EXECUTION COMPLETE`.

**If executor returns ## ERROR:** Display the error and stop.
</step>

<step name="validate_and_report">
Validate the generated spec meets structural requirements.

**Checklist:**
- [ ] File exists at expected path
- [ ] Has correct Lean imports (project Types, Funs, Defs modules)
- [ ] Has `@[step]` attribute on main theorem
- [ ] Theorem uses existential form with `sorry`
- [ ] Module path matches project namespace
- [ ] Natural language description block present
- [ ] No references to source language constructs (no verus!, no vstd, no SMT)

**Optional build check:**
```bash
nice -n 19 lake build 2>&1 | tail -20
```

If build fails on import errors: fix imports and re-validate.
If build fails on type errors: review generated spec against actual signatures.
Build warnings about `sorry` are expected and correct at this stage.

**Report result:**
```
FVS >> SPEC PORT

Source:    {source_lang} ({source_path})
Function:  {function_name}
Spec file: Specs/{path}/{FunctionName}.lean
Ported:    [summary of postconditions from source spec]
Status:    [??] Ready for verification (contains sorry)

---

Next: /fvs:lean-verify Specs/{path}/{FunctionName}.lean
  or: /fvs:lean-proof-port (to port proof from source language too)
```
</step>

</process>

<success_criteria>
- Source language, project path, and function name collected via interactive prompts
- Config read and models resolved for fvs-researcher and fvs-executor
- Research subagent gathered cross-project context: Rust source comparison, source spec semantic analysis, target project conventions, mathematical bridges
- Executor subagent wrote idiomatic Lean spec using @[step] pattern and target conventions
- Spec file written to Specs/ directory via VS Code diff
- --scan mode shows comparison table with [OK]/[??]/[--] status symbols
- Source spec treated as semantic blueprint (not syntactic template)
- Optional build check: nice -n 19 lake build
- Clear next step offered: /fvs:lean-verify or /fvs:lean-proof-port
</success_criteria>
