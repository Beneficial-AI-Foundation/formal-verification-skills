'use strict';

// The publication record (.fvs-publication.json) sits beside the published Lean
// files and is meant to be committed with them. It must hold nothing of the
// attempt that wrote it, whose directory is temporary. Charon, Aeneas, rustc and
// cargo are fake scripts, as in the extraction attempt tests.

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { fakeTools, engine, writeSpec } = require('./helpers/fake-extraction-tools.cjs');

const TMP = fs.realpathSync(os.tmpdir());
const temporaryDirectories = [];
let counter = 0;

after(() => {
  for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true });
});

function workspace() {
  const root = fs.mkdtempSync(path.join(TMP, 'fvs-publication-'));
  temporaryDirectories.push(root);
  const project = path.join(root, 'project');
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.writeFileSync(path.join(project, 'Cargo.toml'), '[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n');
  fs.writeFileSync(path.join(project, 'Cargo.lock'), 'version = 3\n');
  fs.writeFileSync(path.join(project, 'src', 'lib.rs'), 'pub fn one() -> u32 { 1 }\n');
  const tools = fakeTools(project, root, {});
  fs.mkdirSync(path.join(root, 'copies'));
  return { root, project, tools };
}

// One whole attempt, in a fresh temporary directory of its own.
function publish(ws) {
  counter += 1;
  const out = path.join(ws.root, 'copies', `out-${counter}`);
  const prepare = engine(ws.tools, ['prepare', '--project-root', ws.project, '--out', out]);
  assert.equal(prepare.status, 0, prepare.stdout);
  const attempt = engine(ws.tools, ['attempt', '--out', out, '--spec', writeSpec(path.join(ws.root, `spec-${counter}.json`), {})]);
  assert.equal(attempt.status, 0, attempt.stdout);
  for (const name of ['charon', 'aeneas', 'publish']) assert.equal(engine(ws.tools, ['run', '--out', out, '--step', name]).status, 0, name);
  return out;
}

describe('publication record', () => {
  it('names the published files relative to the destination and holds no path of the attempt', () => {
    const ws = workspace();
    const out = publish(ws);
    const file = path.join(ws.project, 'Demo', '.fvs-publication.json');
    const text = fs.readFileSync(file, 'utf8');
    const record = JSON.parse(text);
    assert.deepEqual(Object.keys(record).sort(), ['files', 'schema', 'version']);
    assert.ok(Object.keys(record.files).length > 0);
    for (const name of Object.keys(record.files)) assert.ok(!path.isAbsolute(name) && !name.split('/').includes('..'), name);
    for (const temporary of [out, ws.root, TMP]) assert.ok(!text.includes(temporary), `the record does not mention ${temporary}`);
  });

  it('is the same bytes for two attempts in different temporary directories, so it can be committed', () => {
    const ws = workspace();
    publish(ws);
    const file = path.join(ws.project, 'Demo', '.fvs-publication.json');
    const first = fs.readFileSync(file);
    publish(ws);
    assert.deepEqual(fs.readFileSync(file), first);
  });
});
