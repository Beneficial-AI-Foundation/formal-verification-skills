// Offline fixtures only: the agreement drafting helper prints, checks and never records.
const { before, after, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const HELPER = path.join(ROOT, 'scripts/fvs-auto-agreement.mjs');
const ENGINE = path.join(ROOT, 'scripts/fvs-auto.mjs');
const FIXTURES = path.join(__dirname, 'fixtures/auto-profile');
const temps = [];
let auto;
before(async () => { auto = await import(pathToFileURL(ENGINE).href); });
after(() => { for (const root of temps) fs.rmSync(root, { recursive: true, force: true }); });

// Independent encoding of the approval digest: key-sorted compact JSON of the four approved fields.
const sorted = (value) => {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]));
  return value;
};
const digestOf = (envelope) => crypto.createHash('sha256').update(JSON.stringify(sorted({
  schema: envelope.schema, schemaVersion: envelope.schemaVersion, mode: envelope.mode, payload: envelope.payload,
}))).digest('hex');

const choices = { source: { revision: 'HEAD', configuration: 'default features' }, scope: 'the portable module', limits: { wallClockHours: 40 } };
const stateFile = (root) => path.join(root, '.formalising/auto-fv/state.json');
const roadmapFile = (root) => path.join(root, '.formalising/auto-fv/ROADMAP.md');

function temporary(label) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), label));
  temps.push(directory);
  return directory;
}

function project(initialize = true) {
  const root = temporary('fvs-agreement-helper-');
  fs.cpSync(path.join(__dirname, 'fixtures/extract-patches/crate'), root, { recursive: true });
  fs.cpSync(path.join(FIXTURES, 'fresh'), root, { recursive: true });
  for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=fvs', '-c', 'user.email=fvs@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']]) {
    const result = spawnSync('/usr/bin/git', ['-C', root, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  if (initialize) {
    const values = { HOME: path.join(FIXTURES, 'home'), PATH: path.join(FIXTURES, 'bin') + path.delimiter + '/usr/bin:/bin', FVS_TOOLS_HOME: path.join(FIXTURES, 'no-fvs-tools') };
    const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
    Object.assign(process.env, values);
    try { auto.initState({ projectRoot: root, choices, platform: 'aarch64-apple-darwin' }); }
    finally { for (const key of Object.keys(values)) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  }
  return root;
}

const draftFields = {
  layout: 'single-crate',
  boundaries: ['the portable module only'],
  conventions: ['Lean names follow the crate paths'],
  claims: ['functional correctness of the portable module'],
  trust: ['the Aeneas translation is trusted'],
  acceptance: ['the independent checker accepts the proof'],
  ownerReserved: ['the final pull request decision'],
};
const ownerEvidence = { reference: 'chat:owner-reply-1', response: 'Yes, approved exactly as shown. No publication.' };

function writeDraft(fields) {
  const file = path.join(temporary('fvs-agreement-draft-input-'), 'draft.json');
  fs.writeFileSync(file, JSON.stringify(fields));
  return file;
}

function helper(root, draft, ...extra) {
  return spawnSync(process.execPath, [HELPER, '--input', writeDraft(draft), '--project-root', root, ...extra], { encoding: 'utf8' });
}

// The fenced JSON block printed by the helper.
function printedFence(stdout) {
  const match = /```fvs-auto-agreement\n([\s\S]*?)\n```/.exec(stdout);
  assert.ok(match, stdout);
  return JSON.parse(match[1]);
}

const roadmapWith = (envelope) => '# Fixture\n\n## Goal\nFixture only\n\n## Decisions\n' + '```fvs-auto-agreement\n' + JSON.stringify(envelope, null, 2) + '\n```\n\n## Status log\n';

describe('agreement drafting helper', () => {
  it('prints the payload and a digest equal to the independent encoding, and writes nothing', () => {
    const root = project();
    const before = fs.readFileSync(stateFile(root));
    const files = fs.readdirSync(path.dirname(stateFile(root))).sort();
    const result = helper(root, draftFields);
    assert.equal(result.status, 0, result.stderr);
    const digest = /Digest \(sha256 of the canonical payload\): ([0-9a-f]{64})/.exec(result.stdout)?.[1];
    assert.ok(digest, result.stdout);
    const payloadText = /owner exactly this payload and ask whether they approve it:\n([\s\S]*?)\n\nNext:/.exec(result.stdout)?.[1];
    assert.ok(payloadText, result.stdout);
    const payload = JSON.parse(payloadText);
    assert.equal(digest, digestOf({ schema: 'fvs/auto-agreement', schemaVersion: 1, mode: 'nonpublic-intent', payload }));
    assert.deepEqual(payload.choices, JSON.parse(before).choices, 'choices come from the recorded state');
    assert.equal(payload.contextVersion, 1);
    assert.ok(!result.stdout.includes('fvs-auto-agreement'), 'no fence before the owner has replied');
    assert.ok(!result.stdout.includes('record-agreement'));
    assert.deepEqual(fs.readFileSync(stateFile(root)), before);
    assert.deepEqual(fs.readdirSync(path.dirname(stateFile(root))).sort(), files);
  });

  it('prints a fence that the real record step accepts, with the digest and the owner step, and never records it', () => {
    const root = project();
    const before = fs.readFileSync(stateFile(root));
    const out = path.join(temporary('fvs-agreement-out-'), 'agreement.json');
    const result = helper(root, { ...draftFields, ownerEvidence }, '--out', out);
    assert.equal(result.status, 0, result.stderr);
    const envelope = printedFence(result.stdout);
    assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), envelope, 'the written file is the printed fence');
    assert.equal(envelope.approvedPayloadSha256, digestOf(envelope));
    assert.ok(result.stdout.includes(envelope.approvedPayloadSha256));
    assert.deepEqual(envelope.ownerEvidence, ownerEvidence, 'the owner reply is kept word for word');
    assert.deepEqual(fs.readFileSync(stateFile(root)), before, 'the helper does not record');
    assert.ok(!fs.existsSync(roadmapFile(root)) || !fs.readFileSync(roadmapFile(root), 'utf8').includes('fvs-auto-agreement'), 'the helper does not edit the roadmap');

    const command = result.stdout.split('\n').find((line) => line.startsWith('node '));
    assert.equal(command, `node '${ENGINE}' record-agreement --input '${out}' --project-root '${fs.realpathSync(root)}'`);
    assert.ok(!command.includes('--confirm-overwrite'));
    assert.match(result.stdout, /Owner step \(only the owner runs it/);

    // The owner step, run for real on the roadmap holding the printed fence, accepts it.
    fs.writeFileSync(roadmapFile(root), roadmapWith(envelope));
    const recorded = spawnSync(process.execPath, [ENGINE, 'record-agreement', '--input', out, '--project-root', root], { encoding: 'utf8' });
    assert.equal(recorded.status, 0, recorded.stdout + recorded.stderr);
    assert.equal(JSON.parse(recorded.stdout).code, 'recorded');
  });

  it('carries the observer set as one conventions entry, adds no payload key, and the record step accepts it', () => {
    const root = project();
    const observerSet = 'Observer set: return values, error results as callers match them, external effects, panic occurrence and the file and line a panic reports. Not observed: log text, internal variable names.';
    const fields = { ...draftFields, conventions: [...draftFields.conventions, observerSet] };
    const plain = printedFence(helper(root, { ...draftFields, ownerEvidence }, '--out', path.join(temporary('fvs-agreement-out-'), 'plain.json')).stdout);
    const out = path.join(temporary('fvs-agreement-out-'), 'agreement.json');
    const result = helper(root, { ...fields, ownerEvidence }, '--out', out);
    assert.equal(result.status, 0, result.stderr);
    const envelope = printedFence(result.stdout);
    assert.equal(envelope.payload.conventions.filter((entry) => entry.startsWith('Observer set:')).length, 1);
    assert.ok(envelope.payload.conventions.includes(observerSet), 'the entry is kept word for word');
    assert.deepEqual(Object.keys(envelope.payload).sort(), Object.keys(plain.payload).sort(), 'the observer set adds no payload key');
    assert.equal(envelope.approvedPayloadSha256, digestOf(envelope));

    fs.writeFileSync(roadmapFile(root), roadmapWith(envelope));
    const recorded = spawnSync(process.execPath, [ENGINE, 'record-agreement', '--input', out, '--project-root', root], { encoding: 'utf8' });
    assert.equal(recorded.status, 0, recorded.stdout + recorded.stderr);
    assert.equal(JSON.parse(recorded.stdout).code, 'recorded');
  });

  it('drafts a successor with the next context version and names the overwrite confirmation', () => {
    const root = project();
    const first = path.join(temporary('fvs-agreement-out-'), 'first.json');
    const firstEnvelope = printedFence(helper(root, { ...draftFields, ownerEvidence }, '--out', first).stdout);
    fs.writeFileSync(roadmapFile(root), roadmapWith(firstEnvelope));
    auto.recordAgreement({ projectRoot: root, agreement: firstEnvelope });

    const second = path.join(temporary('fvs-agreement-out-'), 'second.json');
    const result = helper(root, { ...draftFields, claims: ['functional correctness and panic freedom'], ownerEvidence: { reference: 'chat:owner-reply-2', response: 'Yes, the wider claim is approved.' } }, '--out', second);
    assert.equal(result.status, 0, result.stderr);
    const successor = printedFence(result.stdout);
    assert.equal(successor.payload.contextVersion, 2);
    const command = result.stdout.split('\n').find((line) => line.startsWith('node '));
    assert.ok(command.endsWith(' --confirm-overwrite'), command);
    assert.match(result.stdout, /only after the owner has confirmed this exact payload/);
    fs.writeFileSync(roadmapFile(root), roadmapWith(successor));
    assert.equal(auto.recordAgreement({ projectRoot: root, agreement: successor, confirmOverwrite: true }).code, 'recorded');
  });

  it('quotes paths so a single quote in them stays one word', () => {
    const root = project();
    const quoted = path.join(temporary('fvs-agreement-out-'), "owner's agreement.json");
    const result = helper(root, { ...draftFields, ownerEvidence }, '--out', quoted);
    assert.equal(result.status, 0, result.stderr);
    const command = result.stdout.split('\n').find((line) => line.startsWith('node '));
    assert.ok(command.includes(`--input '${quoted.replaceAll("'", "'\\''")}'`), command);
  });

  it('refuses a payload the engine would refuse, naming the reason and writing nothing', () => {
    const root = project();
    const before = fs.readFileSync(stateFile(root));
    const out = path.join(temporary('fvs-agreement-out-'), 'agreement.json');
    const result = helper(root, { ...draftFields, claims: [], ownerEvidence }, '--out', out);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /claims must be an explicit list of nonempty strings with at least one entry/);
    assert.ok(!fs.existsSync(out));
    assert.deepEqual(fs.readFileSync(stateFile(root)), before);
  });

  it('never overwrites an existing output file', () => {
    const root = project();
    const out = path.join(temporary('fvs-agreement-out-'), 'agreement.json');
    fs.writeFileSync(out, 'keep me');
    const result = helper(root, { ...draftFields, ownerEvidence }, '--out', out);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /already exists and is never overwritten/);
    assert.equal(fs.readFileSync(out, 'utf8'), 'keep me');
  });

  it('asks for --out once the owner reply is present, and rejects fields that belong to the state', () => {
    const root = project();
    const needsOut = helper(root, { ...draftFields, ownerEvidence });
    assert.equal(needsOut.status, 2);
    assert.match(needsOut.stderr, /--out is required/);
    const foreign = helper(root, { ...draftFields, choices: {} });
    assert.equal(foreign.status, 2);
    assert.match(foreign.stderr, /unknown draft field\(s\): choices/);
  });

  it('points at auto-init when there is no recorded state', () => {
    const root = project(false);
    const result = helper(root, draftFields);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /no auto-track state/);
    assert.match(result.stderr, /run \/fvs:auto-init first/);
  });

  it('is not part of the checker engine identity and is shipped as a plugin script', () => {
    const checker = fs.readFileSync(path.join(ROOT, 'scripts/fvs-checker-auto.mjs'), 'utf8');
    assert.ok(!checker.includes('fvs-auto-agreement'), 'the helper must not change the engine identity');
    const build = fs.readFileSync(path.join(ROOT, 'scripts/build-plugin.cjs'), 'utf8');
    assert.ok(build.includes("'fvs-auto-agreement.mjs'"));
  });
});
