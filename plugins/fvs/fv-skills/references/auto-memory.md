# Project memory/bootstrap (configured M2 adapter)

<purpose>
One permanent primary store belongs to one verification project. The local Beads store used to develop
FVS is not the target project's memory. This adapter supports an explicitly registered local embedded
Beads1.3.1 store; it is not an installation requirement for other FVS commands or legacy M1 state reads.
Missing/unsupported tools or stores stop the bootstrap with the actual reason, without installation,
migration, ancestor/global fallback or automatic `bd init`.

The canonical roadmap, state, contracts and checker evidence remain authoritative. Memory holds context,
not receipts, worker verdicts, a task queue or instructions overriding those records. No memory result
authenticates an owner/session, grants publication or proves a theorem. Initial scope agreement is still
the setup human gate; later provisional cycles are autonomous within it and final PR acceptance human.

</purpose>

## Register the existing primary location

Use the canonical control root in the **primary** checkout, also for every linked worker. A Lean control
subdirectory of a monorepo is supported. Inspect actual metadata/tool paths; do not guess a database path
from its name. The adapter checks Git common identity, canonical store/database paths, embedded/direct
mode, backend project_id, logical database name/existing .dolt directory and registered executable/version/bytes. Worker-local stores and redirects
refuse. Beads may check metadata files into Git, so a linked checkout can contain those files; that does
not permit initialization of a second backing database. All actual calls still select the primary.

Keep this closed registration JSON in a temporary caller-owned file, with actual inspected values:

```json
{
  "backend": "beads",
  "canonicalRoot": "<absolute primary control root>",
  "storeDir": "<that root>/.beads",
  "bdPath": "<resolved existing absolute Beads executable>"
}
```

```bash
node "$AUTO" record-memory --project-root "$PRIMARY" --input "$REGISTRATION"
```

This registers an existing store and appends a versioned binding to state. It creates no store, changes
no limits/generation and launches no worker. Identical registration is a no-write replay. Replacement
requires actual confirmation and `--confirm-overwrite`; preserve old bindings. Never replace a wrong
project/database merely to pass the gate. Missing metadata/database/tool or unknown mode is actionable
blocked/partial, not consent to repair or initialize it. Read-only backend operations can still need a
local database lock; use the normal tool permission gate and report an actual denial without bypass.

## Fresh caller request for each start/resume

The caller owns the current invocation and intended AO project/session/resume identity. Read these from
its actual selected context; never invent them or obtain expectations from a worker result. Generate a
fresh UUID even when the context/content is unchanged. `start` requires resumeId null; `resume` requires
a nonempty current resume identity. A new attempt always has a new attemptId. These are workflow-bound
identities, not OS/provider authentication and not a persistent nonce database.

For example, caller code prepares and retains the current request BEFORE invoking the backend:

```javascript
import fs from 'node:fs';
import crypto from 'node:crypto';
import { prepareMemoryRequest } from '<installed scripts>/fvs-auto.mjs';
const request = prepareMemoryRequest({
  projectRoot: primary,
  attemptId: crypto.randomUUID(),
  operation: 'coordinator-refresh',
  phase: callerPhase,
  target: { projectId: callerProjectId, sessionId: intendedSessionId, resumeId: currentResumeId },
});
fs.writeFileSync(requestFile, JSON.stringify(request, null, 2) + '\n', { flag: 'wx' });
// Keep this request object/file as the independent current expectation.
```

The helper derives the expected binding revision/hash, choices generation, agreement context hash and
canonical memory-context hash. It computes no caller nonce and grants no readiness. Both the registered
binding and12's current agreement plus its mandatory canonical/owner semantic check remain required.

## Coordinator refresh and worker read-only prime

The coordinator route may seed a missing owned key or refresh recognized stale context in the existing
registered store, then read it back and prime. Unknown/malformed/foreign content refuses without erasure:

```bash
node "$AUTO" refresh-memory --project-root "$PRIMARY" --request "$REQUEST" --out "$MEMORY_OUT"
```

On worker start/resume, prepare a separate fresh request with operation `worker-readonly` and use:

```bash
node "$AUTO" prime-memory --project-root "$PRIMARY" --request "$REQUEST" --out "$MEMORY_OUT"
```

Every output directory is exclusive. The worker command/API rejects refresh selectors or a coordinator
operation before any backend write. Only the coordinator route can call remember. This is trusted
workflow routing, not a Boolean authority check: someone with the credentials can misuse the other
command. The implementation invokes only local version/location/info/memory commands with explicit
primary/database selection, a credential-free environment and --sandbox; queries and prime use
--readonly. No task/sync/push/setup/config command or new AO runtime is part of this path.

## Consume actual bytes against the caller's current expectation

The narrow result is `memory-primed`. Keep request/argv/tool/output evidence and actual prime bytes bound
to that request; an earlier ready flag or identical content hash is not a fresh observation. The caller
must verify from its independently held request/output, then read/inject the returned text:

```javascript
import { verifyMemoryBootstrap } from '<installed scripts>/fvs-auto.mjs';
const current = verifyMemoryBootstrap({ projectRoot: primary, request, out: memoryOut });
const actualWorkerContext = current.primeText; // Consume this actual text, not only its hash/status.
```

Verification compares the entire current request/operation/phase/target/expectations, actual successful
request-bound invocation evidence, and complete prime bytes. Wrong attempt/session/resume, stale
binding/context, missing prime, nonzero/timeout/oversize/partial output or post-prime canonical drift
never enables readiness. A write followed by a failed read/prime remains partial; preserve that outcome
without resetting or pretending it primed. Do not overwrite earlier evidence or silently raise caps.

Runtime prime observations stay in their exclusive evidence directory, not auto-state or memory content;
only explicit registration changes state. Refresh does not reset budgets or gratuitously alter proof-
bound state bytes.16 must reconcile its canonical checkpoints/sessions/receipts and refresh this context;
22 must invoke the fresh gate before dispatch, and workers prime again before verification actions.
Those transition/consumer integrations and live stock-AO qualification are not implemented by this adapter.
