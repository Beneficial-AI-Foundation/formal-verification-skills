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

  it('says what a worker returns when the orchestrator cannot read or write its worktree', () => {
    const flat = text.replace(/\s+/g, ' ');
    assert.match(flat, /A report is a pointer, not evidence/);
    assert.match(flat, /Acceptance never depends on a report: it comes from the build-check receipt on the published head/);
    assert.match(flat, /If the orchestrator cannot read a worker's worktree \(for example a worker in a container\), the worker returns the text the orchestrator needs in its final reply/);
    assert.match(flat, /If the orchestrator cannot write into a worker's worktree, the worker fetches its own Lake packages/);
  });

  it('is honest that the strict lane needs the Agent Orchestrator CLI in 3.0.0-rc3', () => {
    for (const name of ['auto-top-specs', 'auto-execute']) {
      const workflow = fs.readFileSync(path.join(ROOT, 'fv-skills', 'workflows', `${name}.md`), 'utf8').replace(/\s+/g, ' ');
      assert.match(workflow, /in 3\.0\.0-rc3 it drives an Agent Orchestrator controller and needs its `ao` CLI/, name);
    }
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
