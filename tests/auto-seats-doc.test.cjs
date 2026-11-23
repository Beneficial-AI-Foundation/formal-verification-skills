'use strict';

// The seat reference says which seat runs each auto-track operation. It is a
// claim about the engine and the driver, so it is checked against their own
// usage text: every operation they accept needs exactly one row, and a row
// for an operation that no longer exists is a stale claim.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const REFERENCE = path.join(ROOT, 'fv-skills', 'references', 'auto-seats.md');
const AUTO_SCRIPT = path.join(ROOT, 'scripts', 'fvs-auto.mjs');
const DRIVER_SCRIPT = path.join(ROOT, 'scripts', 'fvs-auto-driver.mjs');
const SEATS = new Set(['owner', 'orchestrator', 'worker', 'any']);

function run(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  return `${result.stdout}${result.stderr}`;
}

// The operations the engine usage lists: `node fvs-auto.mjs a|b|c --flag ...`.
function engineOperations() {
  const operations = [];
  for (const line of run(AUTO_SCRIPT, ['--help']).split('\n')) {
    const match = /fvs-auto\.mjs ([a-z-]+(?:\|[a-z-]+)*)(?: |$)/.exec(line);
    if (match) operations.push(...match[1].split('|'));
  }
  // An operation with two usage forms (record-pr) is listed on two lines but has one row.
  return [...new Set(operations)];
}

// The driver prints its operations in the one-line usage of a refusal.
function driverOperations() {
  const match = /fvs-auto-driver\.mjs ([a-z-]+(?:\|[a-z-]+)+) /.exec(run(DRIVER_SCRIPT, ['--help']));
  assert.ok(match, 'the driver usage line is readable');
  return match[1].split('|');
}

// Table rows under a heading: operation name (first backticked cell) to seat cell.
function rowsUnder(text, heading) {
  const start = text.indexOf(`\n## ${heading}`);
  assert.notEqual(start, -1, `section ${heading} exists`);
  const end = text.indexOf('\n## ', start + 1);
  const body = text.slice(start, end === -1 ? undefined : end);
  const rows = new Map();
  for (const line of body.split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim());
    const name = /^`([a-z-]+)`$/.exec(cells[1] || '');
    if (name) rows.set(name[1], cells[2]);
  }
  return rows;
}

describe('seat reference', () => {
  const text = fs.readFileSync(REFERENCE, 'utf8');

  it('has a row for every engine operation and for nothing else', () => {
    const operations = engineOperations();
    assert.ok(operations.length > 20, 'the engine usage was parsed');
    const rows = rowsUnder(text, 'Engine operations: `fvs-auto.mjs`');
    assert.deepEqual([...rows.keys()].sort(), [...operations].sort());
    for (const [name, seat] of rows) assert.ok(SEATS.has(seat), `${name} names a known seat: ${seat}`);
  });

  it('has a row for every driver operation and keeps the driver with the orchestrator', () => {
    const operations = driverOperations();
    const rows = rowsUnder(text, 'Driver operations: `fvs-auto-driver.mjs`');
    assert.deepEqual([...rows.keys()].sort(), [...operations].sort());
    for (const [name, seat] of rows) assert.equal(seat, 'orchestrator', `${name} is an orchestrator operation`);
  });

  it('keeps the trust-bearing operations with the seat that must run them', () => {
    const rows = rowsUnder(text, 'Engine operations: `fvs-auto.mjs`');
    assert.equal(rows.get('record-agreement'), 'owner');
    assert.equal(rows.get('ack-work'), 'worker');
    assert.equal(rows.get('run-owned'), 'worker');
    assert.equal(rows.get('prime-memory'), 'worker');
    assert.equal(rows.get('accept'), 'orchestrator');
    assert.equal(rows.get('init-state'), 'orchestrator');
  });

  it('names the scripts beside the engine and the helper that drafts the agreement', () => {
    for (const script of ['fvs-auto-agreement.mjs', 'fvs-contract-registry.mjs', 'fvs-auto-bundle.mjs', 'fvs-auto-actor-permissions.py']) {
      assert.ok(fs.existsSync(path.join(ROOT, 'scripts', script)), `${script} exists`);
      assert.ok(text.includes(`\`${script}\``), `${script} is listed`);
    }
  });

  it('states what the agreement helper path checks cover and keeps the same-user race boundary visible', () => {
    const flat = text.replace(/\s+/g, ' ');
    assert.match(flat, /resolves the destination and the protected places through every link and compares real paths/);
    assert.match(flat, /each protected where it really lives, also when it is a link/);
    assert.match(flat, /A new file elsewhere, even inside the project, is allowed/);
    assert.match(flat, /These checks are static\. A process of the same user that changes a directory or a link between a check and the write/);
    assert.match(flat, /outside the threat boundary of this release/);
    assert.match(flat, /does not claim to be safe against such a race/);
    assert.ok(!/race-proof|safe from races|cannot race/i.test(flat), 'the helper is never described as race-proof');
    const init = fs.readFileSync(path.join(ROOT, 'fv-skills', 'workflows', 'auto-init.md'), 'utf8').replace(/\s+/g, ' ');
    assert.match(init, /This dry run writes nothing in the project/);
    assert.match(init, /A new file elsewhere, even inside the project, is allowed\. These checks are static; `auto-seats\.md` says what they do not cover/);
    assert.ok(!/and nothing in the project is written/.test(init), 'the dry-run claim is no longer an unqualified statement about the helper');
  });

  it('says a seat is a workflow rule, and what to do when a seat cannot run its command', () => {
    const flat = text.replace(/\s+/g, ' ');
    assert.match(flat, /does not authenticate who typed a command/);
    assert.match(flat, /called the controller in the engine pages/);
    assert.match(flat, /do not move the command to a seat that does not own it/);
    assert.match(flat, /Send the owner the exact command in words/);
    assert.match(flat, /starts an ordinary Claude Code or Codex session in the primary checkout/);
    assert.match(flat, /waiting for the owner to run the record step/);
  });

  it('lists what the orchestrator needs from the environment, marks the Orca examples as untested and requires no environment', () => {
    const flat = text.replace(/\s+/g, ' ');
    const start = flat.indexOf('## What the orchestrator needs from your environment');
    assert.notEqual(start, -1);
    const section = flat.slice(start, flat.indexOf('## Engine operations'));
    assert.match(flat, /FVS names no particular development environment and checks for none/);
    assert.match(section, /\| Capability \| Agent Orchestrator \(example\) \| Orca \(example, not tested\) \|/);
    for (const capability of ['Start a worker in its own worktree', 'Message a worker', 'Interrupt a busy worker', 'Read a worker\'s report', 'Find a worker\'s worktree', 'Stop a worker', 'Set the base of new worktrees']) {
      assert.ok(section.includes(`| ${capability}`), capability);
    }
    assert.match(flat, /Redirect a busy worker at once/);
    assert.match(flat, /Keep your environment's automatic reviewer off the pull requests/);
    assert.match(flat, /Beads \(`bd`\) is optional/);
    assert.doesNotMatch(flat.slice(0, flat.indexOf('## What the orchestrator needs')), /Agent Orchestrator session/, 'the seats are defined without naming an environment');
  });

  it('keeps the shared filesystem as the normal case and says what a worker returns where it does not hold', () => {
    const flat = text.replace(/\s+/g, ' ');
    assert.match(flat, /A report is a pointer, not evidence/);
    assert.match(flat, /Acceptance never depends on a report: it comes from the build-check receipt on the published head/);
    assert.match(flat, /The orchestrator and its workers normally share a filesystem, so the orchestrator reads the evidence in a worker's worktree directly/);
    assert.match(flat, /Where they do not, the worker returns the text the orchestrator needs in its final reply/);
    assert.match(flat, /if the orchestrator cannot write into a worker's worktree, the worker fetches its own Lake packages/);
  });

  it('is honest that the strict lane needs the Agent Orchestrator CLI in 3.0.0-rc3', () => {
    for (const name of ['auto-top-specs', 'auto-execute']) {
      const workflow = fs.readFileSync(path.join(ROOT, 'fv-skills', 'workflows', `${name}.md`), 'utf8').replace(/\s+/g, ' ');
      assert.match(workflow, /in 3\.0\.0-rc3 it drives an Agent Orchestrator controller and needs its `ao` CLI/, name);
    }
  });

  describe('execution reference route boundary', () => {
    const readDoc = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
    const execution = readDoc('fv-skills', 'references', 'auto-execution.md');
    const DEFAULT_SECTION = 'Cancel or replace a worker on the default route';
    const STRICT_SECTIONS = ['Work and cancellation', 'Periodic progress', 'Stop, reconcile and hand off'];
    // Commands and records of the strict lane's packets, assignments and `ao` observations.
    const STRICT_OPERATIONS = /ao session|ao send|run-owned|record-progress|observe-progress|read-progress|terminate-session|resolve-terminated-reservation|mayStart|lifecycle controls/;
    const sectionBody = (heading) => {
      const start = execution.indexOf(`\n## ${heading}`);
      assert.notEqual(start, -1, `section ${heading} exists`);
      const end = execution.indexOf('\n## ', start + 1);
      return execution.slice(start, end === -1 ? undefined : end);
    };

    it('limits the controller procedures to the strict lane and says so on the page and in each heading', () => {
      const flat = execution.replace(/\s+/g, ' ');
      assert.match(flat, /Two routes read this page\. The default route, which the init workflow calls the relaxed path, needs/);
      assert.match(flat, /operations of the optional strict lane only, which needs Agent Orchestrator in 3\.0\.0-rc3/);
      assert.match(flat, /Do not follow them to cancel or replace a worker of a default run/);
      for (const heading of STRICT_SECTIONS) {
        assert.match(execution, new RegExp(`\\n## ${heading} \\(strict lane only\\)\\n`), `${heading} says it is strict-lane only`);
      }
    });

    it('keeps every strict operation after the default route instruction and out of the default sections', () => {
      const strictStart = execution.indexOf('\n## Work and cancellation (strict lane only)');
      assert.notEqual(strictStart, -1);
      assert.ok(execution.indexOf(`\n## ${DEFAULT_SECTION}`) < strictStart, 'the default instruction comes first');
      // The overview, the run-policy section and the default instruction come before the strict sections.
      assert.doesNotMatch(execution.slice(0, strictStart).replace(/\s+/g, ' '), STRICT_OPERATIONS);
      for (const heading of ['Worker brief rules', 'Network and runner support']) {
        assert.doesNotMatch(sectionBody(heading).replace(/\s+/g, ' '), STRICT_OPERATIONS, `${heading} uses no strict-lane operation`);
      }
      // The strict operations are still described, in the sections that are marked strict-only.
      const strictText = STRICT_SECTIONS.map(sectionBody).join('\n').replace(/\s+/g, ' ');
      for (const operation of ['ao session kill', 'run-owned', 'record-progress', 'terminate-session']) {
        assert.ok(strictText.includes(operation), `${operation} stays in a strict-only section`);
      }
    });

    it('gives the default route a cancellation and replacement instruction that needs only the environment', () => {
      const body = sectionBody(DEFAULT_SECTION).replace(/\s+/g, ' ');
      assert.match(body, /needs no work packet, start marker, assignment or `ao` command/);
      assert.match(body, /Preserve the work and the evidence first/);
      assert.match(body, /Do not delete or reset the worktree/);
      assert.match(body, /Stop the worker, and the commands it launched, through your environment \(the "Stop a worker" row of the capability table\)/);
      assert.match(body, /Establish that it has stopped before you start a replacement/);
      // Only the environment's own successful completion is stop evidence; no read of the worktree stands in for it.
      assert.match(body, /Only your environment's documented, successful completion of stopping the worker and the work it launched counts/);
      assert.match(body, /A request that was acknowledged, or a session status that is ambiguous, is not enough/);
      assert.match(body, /Reads of the worktree \(`git status`, the head\) may help you keep the handoff, but they are not evidence of a stop/);
      assert.doesNotMatch(body, /worktree twice|short time apart|expect no change/, 'no read of the worktree is a required stop check');
      assert.match(body, /treat the worker as still running: start no replacement and tell the owner which capability is missing/);
      assert.match(body, /same worker limit and the same selected budget/);
      assert.match(body, /does not reset the original task start, the budget or the history/);
      assert.match(body, /Never signal a process id copied from output or evidence/);
      assert.match(body, /roughly one hour unresolved prompts a look, not a kill/);
      assert.ok(text.includes('| Stop a worker'), 'the row that the instruction names exists in the capability table');
    });

    it('sends the default route to the default instruction, never to the strict procedures, for cancellation', () => {
      const initFull = readDoc('fv-skills', 'workflows', 'auto-init.md');
      const defaultInit = initFull.slice(0, initFull.indexOf('\n## Optional strict lane'));
      const surfaces = {
        'auto-init.md (default part)': defaultInit,
        'auto-setup.md': readDoc('fv-skills', 'references', 'auto-setup.md'),
        'auto-extract.md': readDoc('fv-skills', 'workflows', 'auto-extract.md'),
        'auto-top-specs.md': readDoc('fv-skills', 'workflows', 'auto-top-specs.md'),
        'auto-execute.md': readDoc('fv-skills', 'workflows', 'auto-execute.md'),
        'auto-seats.md': text,
        'README.md': readDoc('README.md'),
      };
      for (const [name, source] of Object.entries(surfaces)) {
        const sentences = source.replace(/`/g, '').replace(/\s+/g, ' ').split(/(?<=[.;:])\s/);
        for (const sentence of sentences) {
          if (!sentence.includes('auto-execution.md') || !/cancel|replacement|hand ?off/i.test(sentence)) continue;
          assert.ok(sentence.includes(DEFAULT_SECTION) || /strict/i.test(sentence), `${name} sends cancellation to the default instruction or marks it strict: ${sentence}`);
        }
      }
      for (const name of ['auto-init.md (default part)', 'auto-setup.md']) {
        assert.ok(surfaces[name].replace(/\s+/g, ' ').includes(DEFAULT_SECTION), `${name} names the default instruction`);
      }
      assert.doesNotMatch(defaultInit.replace(/\s+/g, ' '), /Follow `auto-execution\.md` for cancellation/);
    });
  });

  it('is linked from the setup guide and the init workflow', () => {
    for (const file of [
      path.join(ROOT, 'fv-skills', 'references', 'auto-setup.md'),
      path.join(ROOT, 'fv-skills', 'workflows', 'auto-init.md'),
    ]) {
      assert.ok(fs.readFileSync(file, 'utf8').includes('`auto-seats.md`'), `${path.basename(file)} links the seat reference`);
    }
  });
});
