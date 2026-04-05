<purpose>
Orchestrate paper-to-Lean formalisation using two-phase subagent dispatch
(research -> execute).

Takes a mathematical task description, resource paths, optional KB selection, and
a Lean module path. Dispatches fvs-researcher in formalise mode to extract
mathematical structure from papers/resources and KB, then dispatches fvs-executor
to write Lean definition and specification files.

This is the "paper track" parallel to the existing code track (lean-specify).
Both tracks share lean-verify for proof attempts.

Key difference from code track: paper track creates BOTH definition files
(structures, types, interpretation functions) AND spec files (theorems with sorry),
since there is no Aeneas extraction providing types.

Output: Lean definition and spec files at user-specified module path, with sorry
placeholders ready for /fvs:lean-verify.
</purpose>

<process>

<step name="collect_parameters">
Collect all parameters via interactive prompts (AskUserQuestion). No flags --
the command asks for everything it needs.

**4 interactive prompts:**

1. **Task description:** Free text describing what to formalise.
   Store as TASK_DESCRIPTION.

2. **Resources path:** Where the source material is.
   - List .formalising/resources/ subfolders if they exist
   - Accept specific file paths
   - Accept "none" (working from KB or general knowledge)
   ```bash
   if [ -d ".formalising/resources" ]; then
     ls -d .formalising/resources/*/ 2>/dev/null
     ls .formalising/resources/*.* 2>/dev/null | head -10
   fi
   ```
   Store as RESOURCES_PATH.

3. **Knowledge base selection:** Which KB to query (if any configured).
   - Read knowledge_bases from .formalising/fvs-config.json
   - If no KBs configured: skip this prompt entirely (not an error)
   - If KBs exist: display options with name, domain, description
   - Include "None" option for every invocation
   ```bash
   KB_CONFIG=$(cat .formalising/fvs-config.json 2>/dev/null | \
     python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(d.get('knowledge_bases',[])))" \
     2>/dev/null || echo "[]")
   ```
   Store as KB_CONFIG (full KB entry JSON, or "none").

4. **Lean module path:** Where output files go.
   - e.g., MyProject.CKA.KeyAgreement
   - Derive file path from module path (dots -> directory separators)
   Store as MODULE_PATH.
</step>

<step name="validate_resources">
Validate resource availability and tool support.

**Path validation:**
```bash
# Check resource paths exist
[ -d "$RESOURCES_PATH" ] || [ -f "$RESOURCES_PATH" ] && echo "Found" || echo "WARNING: Not found"
```

**File type support:**

| Type | Tool | Check | Fallback |
|------|------|-------|----------|
| PDF | pdftotext | `command -v pdftotext` | Warn, skip PDF text extraction |
| Images (PNG/JPG) | Claude vision (Read tool) | Always available | -- |
| Markdown/Text | Read directly | Always available | -- |
| LaTeX | Read as text | Always available | Extract \begin{definition}, \begin{theorem}, \begin{lemma} |

**PDF tool check:**
```bash
command -v pdftotext >/dev/null 2>&1 && echo "pdftotext available" || \
  echo "WARNING: pdftotext not found. Install poppler-utils for PDF support."
```

**Edge cases:**
- No resources AND no KB: warn "Limited context -- researcher will use general knowledge." Continue.
- Resources path does not exist: re-prompt user.
- PDF without pdftotext: warn and skip PDF files. Non-blocking.
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

Read and inline reference files before dispatch:
- fv-skills/references/lean-spec-conventions.md (applies to paper track too)
- fv-skills/templates/spec-file.lean (spec template)
- If Aeneas project (Funs.lean exists): fv-skills/references/aeneas-patterns.md
- If no Aeneas markers: skip aeneas-patterns (paper track may be pure math)
</step>

<step name="dispatch_research">
Dispatch **fvs-researcher** subagent in formalise mode to extract mathematical
structure from resources and KB.

Inline into researcher prompt:
- Task description, resources path, KB config, module path
- Spec conventions (lean-spec-conventions.md)
- Aeneas patterns (if in Aeneas project)

Researcher tasks:
1. Read all resource files:
   - PDF: `pdftotext <file> -` (pipe to stdout for text extraction)
   - Images (PNG/JPG): Read tool (Claude vision) to describe mathematical content
   - Markdown/Text: Read directly
   - LaTeX: Read as text, extract \begin{definition}, \begin{theorem}, \begin{lemma} environments
2. If KB configured and domain-relevant: query KB for definitions and key concepts
   ```bash
   .formalising/.kb-venv/bin/python ~/.claude/scripts/fvs-kb-query.py ask \
     "<question about mathematical structure>" --notebook "$KB_ID" --json
   ```
   - If KB domain does not match task: skip (log "KB skipped: domain mismatch")
   - If KB query fails (auth expired, not installed): continue without KB
3. Extract mathematical structure: definitions, properties, lemmas, main theorems
4. Map to Lean types: structures, function signatures, theorem statements
5. Determine dependency order (leaf definitions first, main theorem last)
6. Check existing project definitions for reusable types
7. Propose output file structure with dependency order

**Domain pattern — Protocol Verification:**
When the task involves formalising a security protocol, the researcher should structure
output around the protocol verification triad:

- **Spec_pro**: Lean specifications of protocol descriptions (message flows, state
  transitions, cryptographic operations) → definition files
- **Spec_sec**: Lean specifications of expected security properties (confidentiality,
  authentication, forward secrecy) → spec files with theorem statements and sorry
- **Spec_pro |= Spec_sec**: Lean proofs that the protocol specifications satisfy the
  expected properties → deferred to /fvs:lean-verify

The researcher proposes Spec_pro definitions and Spec_sec theorem statements; the
executor writes them. Proofs are always deferred (sorry placeholders).

**KB domain gating logic:**
```
1. Read knowledge_bases from fvs-config.json
2. For selected KB: check if domain/description is relevant to task description
3. If relevant: query using fvs-kb-query with the KB's id
4. If not relevant: skip entirely (log "KB 'X' skipped: domain mismatch")
5. If no KBs configured: skip KB step entirely (not an error)
```

Expected output: Structured findings with proposed file layout. Ends with
`## RESEARCH COMPLETE`.
</step>

<step name="review_proposal">
Present the researcher's proposed structure to the user for confirmation.

Display:
- Definitions to create (structures, types, interpretation functions)
- Theorems to state (lemmas, main theorem)
- File layout with dependency order
- Any reusable types found in existing project

Use AskUserQuestion:
```
Proceed with this structure? (y/adjust/abort)
```

If user adjusts: incorporate feedback and re-dispatch researcher if structural
changes are significant, or pass adjustments directly to executor for minor tweaks.
If user aborts: stop and report.
</step>

<step name="dispatch_executor">
Dispatch **fvs-executor** subagent to create Lean files following the approved structure.

Inline into executor prompt:
- Research findings from previous step
- Spec file template (fv-skills/templates/spec-file.lean)
- Module path
- User adjustments (if any)

Executor creates:
1. **Definition files:** structures, basic types, interpretation functions
2. **Spec files:** theorem statements with sorry placeholders
3. **Correct import paths** between definition and spec files
4. **Natural language description blocks** before each theorem
5. If Aeneas project: use `@[step]` attribute; otherwise: plain `theorem`

Executor writes files using Write tool (VS Code diff). User approves each diff inline.

Expected output: Ends with `## EXECUTION COMPLETE`.
</step>

<step name="validate_output">
Validate generated files meet structural requirements.

**Checklist:**
- [ ] All proposed files created
- [ ] Theorem statements have sorry (expected at this stage)
- [ ] Imports consistent between definition and spec files
- [ ] If Aeneas project: @[step] attribute present
- [ ] If pure math: plain theorem statements
- [ ] Natural language description blocks present
- [ ] Module path matches project namespace

**Optional build check:**
```bash
nice -n 19 lake build 2>&1 | tail -20
```

sorry warnings expected. Import/type errors noted for user.
NEVER run plain `lake build`.
</step>

<step name="display_summary">
Report results and suggest next steps.

```
FVS >> FORMALISE

Task:      {task_description}
Resources: {resource_count} files from {resources_path}
KB:        {kb_name} or "none"
Files:     {N} created
  - {file_path} -- {brief description}
  - ...
Status:    [??] Ready for verification (contains sorry)

>> Next Up

/fvs:lean-verify {first_spec_path}
```
</step>

</process>

<success_criteria>
- Task description, resources, KB, and module path collected via interactive prompts
- Resources validated (paths exist, file types handled)
- Config read and models resolved for fvs-researcher and fvs-executor
- Research subagent dispatched in formalise mode with KB domain gating
- Researcher's proposed structure reviewed by user before execution
- Executor created both definition files AND spec files
- Generated files validated (sorry present, imports consistent)
- Build check uses nice -n 19 lake build (never plain lake build)
- Summary uses FVS >> FORMALISE banner with file list
- KB is optional -- command works without any KB configured
- Clear next step offered: /fvs:lean-verify
</success_criteria>
