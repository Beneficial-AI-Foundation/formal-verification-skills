<overview>

FVS resolves subagent models and reasoning effort at dispatch time from
`.formalising/fvs-config.json`. Model IDs are runtime- and provider-owned. A model valid in Claude
Code may be nonsense in Codex, and a short name in Pi may be ambiguous across providers.

`inherit` remains the only universal model fallback, but the `quality` profile is role-aware: it
selects a preferred model only after that runtime/provider reports a matching model in its current
catalog. FVS never sends a foreign, guessed, or unavailable model slug.

Use `/fvs:configure` (Pi: `/skill:fvs-configure`) for menu-driven editing, or edit the JSON directly.

</overview>

<profiles>

## Built-in profiles

| Profile | Model policy | Effort policy |
|---------|--------------|---------------|
| quality | detected runtime-native model by stage tier | authority `max` (review stages `xhigh`); work `xhigh`; scout `high` |
| balanced | `inherit` | `high` |
| budget | `inherit` | `medium` |

Balanced and budget stay runtime-neutral. Only quality automatically selects a concrete model.

## Canonical quality stage map

Each dispatch declares one exact stage key. Shared agents do not determine the tier.

| Tier | Stage keys | Intent |
|------|------------|--------|
| authority | `fc_plan`, `fc_spec`, `fc_proof_plan`, `crypto_plan`, `crypto_followup`, `spec_review`, `crypto_review` | Author or adversarially review specifications and plans |
| work | `fc_proof_execution`, `lean_refactor`, `crypto_execute`, `extract_apply`, `extract_bisect` | Execute plans, fill proofs, verify, refactor, or apply extraction changes |
| scout | `research`, `map_code`, `crypto_eval`, `trust_audit`, `extract_classify`, `extract_assess`, `extract_investigate`, `doc_sync`, `explain` | Retrieve, summarize, classify, evaluate, audit, or explain |

This table is the sole stage/tier authority. Commands reference stage keys instead of copying the
table.

## Canonical quality runtime preferences

These family names are matching preferences, not dispatch slugs. Resolve them to an exact ID or
stable alias present in the selected runtime/provider catalog.

| Runtime/provider | Authority | Work | Scout |
|------------------|-----------|------|-------|
| Claude Code | detected Fable + `max` | detected Opus + `xhigh` | detected Sonnet + `high` |
| Codex / OpenAI | detected Astra + `max` | detected Sol + `xhigh` | detected Terra + `high` |
| Antigravity (agy) | detected Argon 4 (e.g. `gemini-4-argon-high`) + `high` | ask or exact stage override | ask or exact stage override |

Review stages (`spec_review`, `crypto_review`, and model-external's independent reviewers) use the
authority model at `xhigh` effort. `max` stays available as an explicit opt-in from the review menu
or a saved review effort; authoring stages keep `max`.

Pi uses the row belonging to its active provider with exact provider-qualified IDs. Ordinary Pi
work never switches providers automatically. An Anthropic-backed Pi provider uses the Claude-family
row only when Pi reports a valid authenticated Anthropic model; an OpenAI/Codex-backed provider uses
the OpenAI row. OpenCode receives no guessed family mapping, and neither do Antigravity work and
scout stages: ask interactively or require an exact stage override. Argon 4 IDs carry their effort
level as a suffix (`-low`, `-medium`, `-high`), so the Antigravity authority choice is the `-high`
variant reported by `agy models`.

If the preferred quality model is absent, do not choose a lower family silently. Interactive runs
ask the user to select a detected model for this run, save an exact runtime+stage override, or
cancel. Noninteractive runs stop before dispatch and print the exact override key required.

Valid effort values are the exact values the selected runtime/model reports; common normalized
values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. If the selected model does
not support the requested effort, interactive runs show its supported values and offer one-run or
saved stage-scoped choices. Noninteractive runs stop with exact remediation. Never silently claim
the profile effort was applied.

</profiles>

<config>

## Config file

**Location:** `.formalising/fvs-config.json`

```json
{
  "model_profile": "quality",
  "stage_overrides": {
    "claude": {},
    "codex": {},
    "pi": {},
    "opencode": {},
    "antigravity": {}
  },
  "model_overrides": {
    "claude": {},
    "codex": {},
    "pi": {},
    "opencode": {},
    "antigravity": {}
  },
  "effort_overrides": {
    "claude": {},
    "codex": {},
    "pi": {},
    "opencode": {},
    "antigravity": {}
  },
  "spec_review": {
    "automatic": true,
    "reviewer": null,
    "model": null,
    "effort": null
  },
  "crypto_review": {
    "automatic": true,
    "reviewer": null,
    "model": null,
    "effort": null
  }
}
```

A stage override is an object containing either or both fields:

```json
{
  "stage_overrides": {
    "codex": {
      "crypto_review": {
        "model": "<exact reviewer catalog ID>",
        "effort": "<supported effort>"
      },
      "crypto_plan": {
        "model": "<exact Codex catalog ID>",
        "effort": "<supported effort>"
      }
    },
    "pi": {
      "fc_proof_execution": {
        "model": "<active-provider>/<exact-model-id>",
        "effort": "<supported effort>"
      }
    }
  }
}
```

Concrete IDs must belong to the containing runtime; Pi IDs are provider-qualified. Existing
`model_overrides[runtime][agent]` and `effort_overrides[runtime][agent]` remain supported as broader
compatibility overrides. Review values are scoped by their adjacent `reviewer` runtime. Explicit
one-run selections always win.

Legacy flat overrides are safe only when their value is `inherit`. Ignore any other flat model value
with a migration warning; never guess which runtime it targeted.

### Project `native_decide` policy

Read top-level `native_decide` from `.formalising/fvs-config.json`. Valid values are `avoid`, `ask`,
and `allow`; missing values default to `ask`, and unknown values fail before dispatch.

- `avoid`: fail before any proposed `native_decide` use and offer a proved alternative or an
  explicitly confirmed one-run policy override.
- `ask`: pause at the first proposed use and ask whether to permit it for this run.
- `allow`: permit use, while still recording the trust/resource choice.

A confirmed one-run override may select any valid value but does not persist and never rewrites the
project config. Pass the effective value to every child that may edit or assess Lean. If a child
proposes `native_decide` contrary to the effective policy, stop at the parent boundary rather than
silently accepting the edit.

</config>

<resolution>

## Dispatch resolution

For every distinct stage used by a command:

1. Identify the active runtime and provider from host/adapter identity. If unknown, ask.
2. Read the complete config; malformed JSON is an error.
3. Resolve `model_profile`, defaulting to `quality`; unknown profiles warn and use `quality`.
4. Apply an explicit one-run flag or confirmed manifest adjustment.
5. For `spec_review` or `crypto_review`, apply non-null saved review values.
6. Apply `stage_overrides[runtime][stage]`.
7. Apply compatibility `model_overrides[runtime][agent]` and
   `effort_overrides[runtime][agent]` for still-unset fields.
8. Apply the profile: quality resolves the stage tier and an exact detected model from the runtime
   matrix; balanced/budget use `inherit`. Apply the tier/profile effort.
9. Validate model and effort against the selected runtime/model. For ordinary Pi stages, also
   validate that the candidate model's catalog provider equals Pi's active provider.
10. Inspect the actual dispatch schema/capabilities. A requested model or effort is unresolved when
    the runtime cannot apply it, even if the catalog advertises it.
11. Resolve the stored and effective `native_decide` policy, applying only an explicitly confirmed
    one-run override.
12. Build the command-level selection manifest from settings the dispatch can actually honor and
    obtain the required confirmation before the first dispatch.

Pseudo-code:

```
runtime, provider = detect_runtime_provider_or_ask()
profile = valid_profile(config.model_profile) ? config.model_profile : "quality"
stage = required_stage_key(dispatch)

model, effort = explicit_one_run_selection(stage)
model, effort ??= saved_review_values(stage)
model, effort ??= config.stage_overrides[runtime][stage]
model ??= config.model_overrides[runtime][agent]
effort ??= config.effort_overrides[runtime][agent]

if profile == "quality":
  tier = QUALITY_STAGE_TIER[stage]
  model ??= exact_detected_match(runtime, provider, QUALITY_MODEL[runtime][tier])
  effort ??= is_review_stage(stage) ? "xhigh" : QUALITY_EFFORT[tier]
else:
  model ??= "inherit"
  effort ??= PROFILE_EFFORT[profile]

validate_runtime_model_effort_and_pi_provider(model, effort, stage)
validate_dispatch_capability_or_request_decision(model, effort, stage)
```

Missing fields are resolved independently. A model override does not erase the tier effort, and an
effort override does not erase the tier model.

For ordinary Pi work (all stages except `spec_review` and `crypto_review`), compare the candidate's
provider metadata from Pi's live catalog with the active Pi provider. A persisted stage or agent
override from another provider is a capability exception, not permission to switch: ask for an
active-provider one-run/save choice interactively, and fail before dispatch noninteractively.
Provider-qualified string prefixes may be used only when the catalog exposes no separate provider
field. Reviews follow the explicit opposite-provider routing policy instead.

After catalog validation, inspect the real child-dispatch schema. Pass every resolved effort through
the runtime's supported effort field. If a runtime cannot set a per-child model (for example, a
Codex `spawn_agent` schema with no model field), the only directly runnable model selection is its
reported active/inherited model. Rebuild the manifest around that actual setting and ask explicitly,
or choose a capable external runner; fail before dispatch in noninteractive mode. Apply the same
rule when the dispatch cannot set the selected effort and its installed/runtime default differs.
Never confirm a requested value and then omit it or replace it with a warning.

## Command-level confirmation manifest

Interactive commands show one manifest before their first dispatch, grouping repeated uses of the
same stage. Each row records:

- stage key and tier;
- agent/reviewer and runtime/provider;
- exact model or `inherit`, plus whether it came from one-run input, review settings, stage override,
  agent override, or profile/catalog matching;
- effort and its source;
- review runner/provenance when applicable;
- stored and effective `native_decide` policy, its source (`config`, default, or one-run), and whether
  this run has approved native execution.

Offer `Continue once`, `Adjust once`, `Save override`, and `Cancel`, while retaining the question
UI's notes/custom-answer path. `Save override` defaults to
`stage_overrides[runtime][stage]`; review stages save into their matching review object. Notes are
interpreted as requested selection/stage adjustments, then the manifest is rebuilt and must be
confirmed again. Notes never become unchecked model IDs or silently alter unrelated stages.

One confirmation covers the command, not every child. If later evidence introduces a new stage,
provider, model, unsupported effort, or a previously unapproved `native_decide` use, rebuild and
reconfirm the manifest. A one-run native policy change does not persist.

In noninteractive/autonomous mode, a complete valid explicit selection or persisted override may
run without a prompt and must be logged only when dispatch capability can honor it. Any unresolved
confirmation, absent preferred model, provider mismatch, unsupported effort, or unavailable
per-child control fails before dispatch with exact flags/config keys. Do not fall back silently.

</resolution>

<review_routing>

## Adversarial review routing

Quality uses the authority model for `spec_review` and `crypto_review` at `xhigh` effort. Detect
the authoring runtime and recommend an authenticated opposite provider/runtime, then confirm
reviewer, model, effort (`max` only as an explicit opt-in), and one-run skip:

- OpenAI/Codex-authored artifact: prefer Claude Code CLI with detected Fable + `xhigh`; also offer Antigravity CLI (`agy`) with a detected Argon ID (`gemini-4-argon-*` from `agy models`).
- Claude-authored artifact: from Pi prefer a fresh provider-qualified OpenAI Pi seat with detected
  Astra + `xhigh`, then Codex CLI; outside Pi prefer Codex CLI. Antigravity CLI (`agy`) with a detected Argon ID is also offered.
- Unknown/Other author: show the explicit reviewer menu without claiming independence.

The `antigravity` reviewer runs `agy` headless in a disposable review copy: a fresh temporary
directory outside the project holding the project files except symlinks, `.git`, `.lake`, `.agents`,
`node_modules`, `target`, proof-engineering memory, and `proof-engineering-context.md` snapshots.
Its model must be an exact `gemini-4-argon-*` ID because agy also serves Claude and OpenAI models.
The helper passes `--sandbox` and `--mode accept-edits`, and refuses agy older than 1.4.3 or an agy
settings.json that widens file or sandbox access. Project Lake builds are unavailable to this
reviewer. Effort goes to `agy --effort` verbatim; confirm a value agy accepts for that model.
An Argon review sends the review packet (the user's sources and plans) to Google under the user's own agy account terms; on consumer accounts Google may use that content.

Do not route a Claude Code subscription through Pi. Use Claude Code's own authenticated CLI unless
Pi independently reports a valid Anthropic provider credential. OpenAI review may use a fresh Pi
OpenAI seat or Codex CLI as described above.

Preflight the selected runner and authentication. A Pi reviewer additionally requires a fresh-child
facility that accepts the selected provider-qualified model and per-child effort and reports the
completed child's run ID, actual model, and actual effort for its hash-bound dispatch receipt. If
that capability is absent, Pi is unavailable; never infer receipt values from the request. If no
opposite runner is ready, ask among setup/retry, fresh same-runtime review, Other packet handoff,
one-run skip, or cancel. Never switch silently. Label same-runtime and unverified provenance
honestly.

A one-run skip records exactly `Unreviewed (user skipped)` and stops at the review boundary. It never
auto-starts proof or crypto execution; the user may invoke execution explicitly afterward.

Saved `spec_review` / `crypto_review` values and explicit flags override profile recommendations.
Null values keep profile routing and the confirmation menu active.

</review_routing>

<stable_rules>

## Stable fallback rules

- Missing config: profile `quality`; resolve detected stage defaults and require the interactive
  command manifest confirmation. Do not create a file.
- Unknown stage: stop and fix the command; do not guess a tier.
- Empty/null override: ignore it.
- Foreign-runtime override: ignore it completely.
- Pi ordinary-stage override from a non-active provider: ask one-run/save/cancel interactively; fail
  with remediation noninteractively. Never activate that provider implicitly.
- Unavailable model: ask one-run/save/cancel interactively; fail with remediation noninteractively.
- Unsupported effort: ask one-run/save/cancel interactively; fail with remediation noninteractively.
- Never guess a replacement slug, switch providers silently, or mutate config during a one-run
  choice.
- Missing `native_decide` policy means `ask`; unknown values fail. `avoid` and an unapproved `ask`
  stop before use; `allow` remains visible in the manifest and trust evidence.

</stable_rules>

<stage_settings_evidence>

## Stage settings evidence

At each EXISTING persistence boundary, write one `Stage settings:` JSON record. This is metadata,
not a receipt/policy engine or a new approval gate. Keep the existing artifact names and owners:
`PLAN_nN.md`, `EXEC_PLAN_nN.md`, `FOLLOWUP_PLAN_nN.md`, `EVAL_nN.md`, execution `build.log`, and
review/separate author triage. An EXEC_PLAN carries its authoring tuple; the executor resolves
`crypto_execute` independently and never rewrites the approved plan to record execution settings.

The record contains `stage`, `route`, and three tuples, each with runtime/provider/model/effort:
- `requested`: original explicit or policy input, retaining its selection source (per field where
  sources differ: one-run, stage override, agent override, profile/catalog, confirmed adjustment).
- `resolved`: the confirmed inputs actually supplied through the selected route controls, with
  launch/definition/manifest evidence source. `inherit` is an input, not an observed model.
- `observed`: field-wise independently returned child/runtime evidence. Each field is
  `{ "value": "...", "source": "..." }`, or `{ "value": "unknown", "reason": "...", "source": "..." }`.

Compact example for a valid completed external stage with unavailable telemetry:

```json
{
  "stage": "crypto_plan",
  "route": "external-codex-read-only",
  "requested": {"runtime":"codex","provider":"unknown","model":"<selected exact ID>","effort":"low","source":"explicit one-run choice"},
  "resolved": {"runtime":"codex","provider":"unknown","model":"<selected exact ID>","effort":"low","source":"launch.json"},
  "observed": {
    "runtime":{"value":"unknown","reason":"not independently reported","source":"final-response.md"},
    "provider":{"value":"unknown","reason":"not independently reported","source":"final-response.md"},
    "model":{"value":"unknown","reason":"not reported","source":"final-response.md"},
    "effort":{"value":"unknown","reason":"not reported","source":"final-response.md"}
  }
}
```

CLI arguments, definitions, and launch-derived Pi thinking belong only in `resolved`; never copy
these into `observed`. Preserve relevant available role/definition digest, child ID/status,
tools/sandbox/owner/attempt bounds, and packet/response hashes where already available. No extra
session discovery, unrelated chat inspection, backfill, or new mandatory receipt is required.
Legacy missing metadata reads as unknown; do not alter historical or immutable reviewer artifacts.

A valid completed response/review with unknown observations succeeds. Unknown telemetry does not
establish honored effective settings, provider independence, unsupported capability, or a new
failure status. A known different author/runtime is `cross-runtime`, not automatically opposite-
provider independent: that claim needs known provider/seat and fresh completion evidence. Keep
existing Pi receipt, input integrity, approval/triage and bounded revision requirements unchanged.

Surface a REAL reported exact-ID/model/effort/runtime mismatch at that selection/claim, preserve raw
evidence, and offer concrete supported choices or explicit informed reconfirmation before changing
it. A versioned model observation for a catalog-confirmed CLI alias is not proof of substitution;
retain both and report unknown equivalence. Mark `model_is_alias: true` in the existing reviewer
request only when the confirmed catalog identifies an alias (`--model-is-alias` for crypto review).
Never guess alias status from a name's spelling or silently waive an exact-ID mismatch. Missing
catalog observations alone do not veto valid existing dispatch. Harmless bounded implementation or
diagnostic adjustments within approved task/ownership/safety limits need no additional consent.

External OpenCode diagnostic reviewer selections reach only their named capability branch: OpenCode
lacks native shell isolation. Its model/variant or effort settings do not themselves provide
confinement. Antigravity reaches its CLI route only with an exact Argon ID, inside the review copy described in review routing. Offer explicit Codex/Claude CLI, active-
host fresh Pi, or acknowledged Other export/import alternatives; never implicitly launch Claude or
relabel the selection. These limitations affect only that operation, not ordinary five-runtime
commands. Source/schema evidence and simulated fixtures are not completed native acceptance.

</stage_settings_evidence>

<runtime_notes>

## Runtime detection and adapters

Prefer identity supplied by the host or adapter. Pi exposes `PI_CODING_AGENT=true` and
`AI_AGENT=pi`. Other adapters may expose `AI_AGENT`. If identity is unknown, ask instead of
inferring it from `.claude`, `.codex`, or `.pi` directories.

Claude Code accepts only confirmed Claude aliases/IDs. Never send Astra, Sol, Terra, or Luna to it.
Codex accepts only exact IDs reported by its catalog. Never send Fable, Opus, Sonnet, or Haiku to
it. Codex agent TOMLs provide installation-time fallbacks, not proof that a stage selection was
applied. When `spawn_agent` lacks a per-child model or effort field, compare the selection with the
reported active model and installed/runtime effort; rebuild and reconfirm a truthful manifest or
fail before dispatch. Never omit a requested value and continue with only a warning.

Pi uses exact provider/model IDs. When its subagent facility supports a thinking suffix, use
`provider/model:<effort>`; otherwise use its separate effort field. `inherit` omits model override.
OpenCode and Antigravity use only exact IDs returned by their own catalogs (`agy models` for
Antigravity).

</runtime_notes>

<anti_patterns>

- A dispatch without an exact stage key.
- Choosing a tier from an agent name when that agent serves several stages.
- Sending a Claude alias to Codex or a Codex family name to Claude.
- Using a bare Pi nickname without its provider/model identity.
- Automatically dropping from Astra to Sol, Fable to Opus, or another family when the preferred
  model is absent.
- Switching Pi providers without confirmation.
- Claiming unsupported effort was honored.
- Rewriting persisted config for a one-run adjustment.
- Launching before notes have produced a rebuilt, reconfirmed manifest.

</anti_patterns>
