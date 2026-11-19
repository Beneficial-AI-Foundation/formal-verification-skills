# Who runs each auto-track operation

<overview>
Three seats take part in an auto-track run. The **owner** is the person. The **orchestrator** is the Agent Orchestrator session that coordinates the run and holds the project's primary checkout; the engine pages call that session the controller. A **worker** is an Agent Orchestrator session started for one assigned node, in its own worktree. This page says which seat runs each engine operation, so nobody has to guess whose session a command belongs in.

The engine does not authenticate who typed a command. It checks recorded evidence and state. A seat is therefore a rule about trust and workflow, not a lock. If the host refuses a command in the seat that should run it, do not move the command to a seat that does not own it. Hand the same command to the owner to run in a terminal; see "When a seat cannot run its command" below and the permission guidance in `auto-setup.md`.
</overview>

## The seats

| Seat | Who it is | Decides | Never does |
|------|-----------|---------|------------|
| Owner | The person who owns the project | The scope agreement and the final pull request | Nothing is hidden from the owner |
| Orchestrator | The coordinating Agent Orchestrator session, called the controller in the engine pages | Which authorized step runs next | Writes the owner's reply, or decides the final pull request |
| Worker | One Agent Orchestrator session in its own worktree | How to prove its assigned node | Records an agreement, accepts a proof, or writes the primary checkout's recorded state |

## Engine operations: `fvs-auto.mjs`

| Operation | Seat | Notes |
|-----------|------|-------|
| `profile` | any | Reads the host and project, changes nothing. |
| `read-state` | any | Reads the recorded state, changes nothing. |
| `init-state` | orchestrator | Records the owner's choices, answered in the owner's own words; a later overwrite needs the owner's confirmation. |
| `record-agreement` | owner | The record step carries the owner's real reply. The helper `fvs-auto-agreement.mjs` drafts the fence and prints the exact command; the owner runs it. |
| `record-roadmap` | orchestrator | Records the owner's accepted or declined answer about the roadmap offer. |
| `record-extraction` | orchestrator | Run by the session that ran `/fvs:auto-extract`; it derives the extraction status itself. |
| `record-externals` | orchestrator | Records one entry per boundary; it refuses to drop one. |
| `record-spec` | orchestrator | Records one review round for one spec file, in the project checkout; authors and reviewers never run it. |
| `spec-status` | any | Reads the recorded spec files and whether the pull request can open; changes nothing. |
| `record-pr` | orchestrator | Records the draft spec or proof pull request after it is opened, and the owner's merge of the spec pull request after the owner merges it. It never calls GitHub. |
| `list-items` | any | Lists the Rust functions Aeneas translated, narrowed by a scope you give; reads `translation.json` and changes nothing. It records no visibility, so the list holds candidates for the public API. |
| `record-override` | orchestrator | Records a run decision made after the agreement, such as a changed pull request base, so a resumed run keeps it. It is append-only and does not amend the agreement. |
| `record-memory` | orchestrator | Registers the project memory once. |
| `refresh-memory` | orchestrator | The coordinator route; it is the only route that may write memory. |
| `prime-memory` | worker | The read-only route a worker runs at start and on resume. The orchestrator runs it too before dispatch, with the coordinator request. |
| `checkpoint` | orchestrator | Records a paired checkpoint transition. |
| `state` | orchestrator | Reconciles the recorded run state. |
| `next-transition` | orchestrator | Reads scheduling facts; it is not permission to dispatch. |
| `execute-transition` | orchestrator | Applies one authorized transition. |
| `verify-transition` | orchestrator | Checks a transition's result. |
| `verify-startup` | orchestrator | Checks the worker's startup acknowledgement. |
| `ack-work` | worker | The worker's own acknowledgement; it starts only when this returns `mayStart:true`. |
| `run-owned` | worker | Compiler and checker commands inside the assigned worktree. |
| `record-progress` | orchestrator | Records periodic progress observed from the session. |
| `observe-progress` | orchestrator | A fresh observation of the assigned session and worktree. |
| `read-progress` | any | Reads retained progress facts. |
| `freeze` | orchestrator | Freezes the checker context. |
| `check` | orchestrator | The independent checker's provisional check. |
| `accept` | orchestrator | Serial checker acceptance. A worker's VERIFIED result is candidate evidence only. |

## Driver operations: `fvs-auto-driver.mjs`

The driver runs in the orchestrator's context, from the one fixed trusted engine. A worker never runs it.

| Operation | Seat | Notes |
|-----------|------|-------|
| `prepare` | orchestrator | Builds the current request. |
| `advance` | orchestrator | Advances the run by one authorized step. |
| `effect` | orchestrator | Runs a paired effect with its before and after records. |
| `after` | orchestrator | Records the effect's after state. |
| `prepare-review` | orchestrator | Prepares a fresh review of the current contract. |
| `import-review` | orchestrator | Imports the reviewer's response; a review that is stale or not independent is refused. |

## Related scripts

| Script | Seat | Notes |
|--------|------|-------|
| `fvs-auto-agreement.mjs` | orchestrator drafts, owner records | Drafts the agreement fence and prints its digest. It never records. |
| `fvs-contract-registry.mjs` (`register`, `revise`, `status`) | orchestrator | Appends contract records for closure-plan nodes. |
| `fvs-auto-bundle.mjs` (`build`, `verify`, `trust`, `rulings`) | orchestrator | Collects and checks the human review bundle. `trust` and `rulings` read the run records and print the trust section of the proof pull request body and the ruling list of the spec pull request body; they write nothing. |
| `fvs-auto-actor-permissions.py` | orchestrator | Run once per actor for an explicitly granted Claude gate profile. |

What the agreement helper's path checks cover. `--out` must name a new file. The helper resolves the destination and the protected places through every link and compares real paths, so it refuses a destination inside the project's `.formalising` directory, inside its `auto-fv` area (each protected where it really lives, also when it is a link) or among the engine scripts. The dry run keeps its scratch copy in a temporary directory outside the project. A new file elsewhere, even inside the project, is allowed.

These checks are static. A process of the same user that changes a directory or a link between a check and the write that follows is outside what the helper defends against, and outside the threat boundary of this release. The exclusive creation of the output file still stops it replacing an existing file, and the helper checks its scratch directory again after creating it, but it does not claim to be safe against such a race.

## Orchestrator rules for workers and reviews

These are rules for the orchestrator's own commands and messages. The worker rules (build before
commit, test vectors, a standalone push, the ownership map) are in `auto-execution.md`, "Worker brief
rules". Put them in each worker brief.

- **Redirect a busy worker with `ao send --steer`.** A plain `ao send` to a worker that is in a turn
  queues behind that turn. When the scope or the plan changes, for example when work is split
  between two workers, steer at once: `ao send --session ID --steer --message TEXT`. A worker that
  keeps going on the old scope can finish work that another worker already owns.
- **Keep Agent Orchestrator's native reviewer off the pull requests.** Its review is posted on the
  pull request as comments, and the auto track lets no agent post a GitHub comment or review: only
  the owner does. The fresh review in the pipeline is the review of record. Switch the reviewer off
  before workers start:
  1. For the project, set `autoReview` to `false` in the project configuration. New workers copy
     this default. `ao project set-config PROJECT --config-json JSON` replaces the whole saved
     configuration, and it ignores a key it does not know, so a typo can leave it empty. Read the
     saved one first with `ao project get PROJECT --json`, and send back every setting with only
     `autoReview` changed. Check it again with `ao project get`.
  2. A session that already exists has its own switch for native auto-review in the session
     inspector. Turn it off there. The setting in step 1 does not change it.
  3. Never run `ao review trigger` on a proof or spec pull request of the run.
  A worker that only reviews someone else's pull request is claimed with
  `ao session claim-pr PR --no-takeover --review`. That claim already turns native auto-review off
  for that session.
- **Keep the ownership map and the three commits.** The orchestrator holds the map of items, owners
  and files, and the status line with the accepted, the published and the recorded commit
  (`auto-execution.md`, "Worker brief rules"). A worker never carries them across a handoff on its own.

## When a seat cannot run its command

A stock Agent Orchestrator orchestrator is set up to coordinate: it starts workers, sends messages and reads reports. Many orchestrator rows above are shell commands that change recorded state, and the host's permission checks may refuse some of them, for example a record step that replaces an agreement. This is a known friction, not a failure of the run.

1. Do not retry the same command in a loop, and do not ask a worker to run an orchestrator row.
2. Send the owner the exact command in words (the helper prints it for the agreement). The owner runs it in a terminal of their own.
3. Tell the orchestrator that it ran, so the orchestrator reads the recorded state again before it continues.

If your orchestrator cannot run shell commands at all, the orchestrator rows have no seat. The owner then starts an ordinary Claude Code or Codex session in the primary checkout and runs those rows there; the engine needs only the command and the project's recorded state.

Owner-run rows are named as such in the setup guide. A goal handed to the orchestrator should treat "waiting for the owner to run the record step" as a stopping point, not a failure.
