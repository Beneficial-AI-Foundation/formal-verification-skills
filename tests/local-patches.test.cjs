const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const {
  convertClaudeAgentToCodexAgent,
  generateCodexAgentToml,
  saveLocalPatches,
  writeManifest,
} = require('../bin/install.js');

test('updates preserve additions, tracked edits, legacy orphans and earlier complete bundles', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-patches-')));
  const put = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  const meta = () => JSON.parse(fs.readFileSync(path.join(dir, 'fvs-local-patches/backup-meta.json')));
  const contents = (m, rel) => fs.readFileSync(path.join(dir, 'fvs-local-patches', m.bundle, rel), 'utf8');
  try {
    put('agents/fvs-test.toml', 'original');
    put('fv-skills/references/contract.md', 'original');
    writeManifest(dir, 'codex');
    put('agents/fvs-test.toml', 'local toml');
    put('fv-skills/references/contract.md', 'local contract');
    put('skills/fvs-extra/companion.md', 'new companion without SKILL.md');
    put('fvs-local-patches/scripts/fvs-orphan.mjs', 'older orphan');
    put('fvs-local-patches/backup-meta.json', JSON.stringify({ files: [], from_version: '2.3.0' }));
    saveLocalPatches(dir, 'codex');
    const first = meta();
    assert.equal(first.files.length, 4);
    assert.equal(first.kinds['skills/fvs-extra/companion.md'], 'added');
    assert.equal(contents(first, 'scripts/fvs-orphan.mjs'), 'older orphan');
    put('agents/fvs-test.toml', 'second local edit');
    const copy = fs.copyFileSync;
    fs.copyFileSync = () => { throw new Error('simulated disk failure'); };
    try { assert.throws(() => saveLocalPatches(dir, 'codex'), /simulated disk failure/); }
    finally { fs.copyFileSync = copy; }
    assert.equal(meta().bundle, first.bundle, 'failed replacement must leave active bundle intact');
    assert.equal(contents(first, 'agents/fvs-test.toml'), 'local toml');
    put('agents/fvs-test.toml', 'local toml');
    const install = () => execFileSync(process.execPath, [path.resolve(__dirname, '../bin/install.js'),
      '--codex', '--global', '--config-dir', dir], { stdio: 'pipe' });
    install();
    const second = meta();
    assert.equal(contents(second, 'skills/fvs-extra/companion.md'), 'new companion without SKILL.md');
    assert.equal(contents(first, 'agents/fvs-test.toml'), 'local toml');
    const installed = JSON.parse(fs.readFileSync(path.join(dir, 'fvs-file-manifest.json')));
    assert.ok(Object.keys(installed.files).some(f => /^agents\/.*\.toml$/.test(f)));
    assert.ok(installed.files['hooks/fvs-check-update.js']);
    install();
    assert.deepEqual(meta().files, second.files);
    for (const f of meta().files) assert.equal(contents(meta(), f), contents(second, f));
    const before = fs.readFileSync(path.join(dir, 'skills/fvs-help/SKILL.md'), 'utf8');
    put('fvs-local-patches/backup-meta.json', '{malformed');
    assert.throws(install);
    assert.equal(fs.readFileSync(path.join(dir, 'skills/fvs-help/SKILL.md'), 'utf8'), before);
    put('fvs-local-patches/backup-meta.json', JSON.stringify(second));
    fs.unlinkSync(path.join(dir, 'fvs-local-patches', second.bundle, second.files[0]));
    assert.throws(install);
    assert.equal(fs.readFileSync(path.join(dir, 'skills/fvs-help/SKILL.md'), 'utf8'), before);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a fresh Codex install creates its missing config directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-fresh-codex-'));
  const configDir = path.join(root, '.codex');
  try {
    assert.deepEqual(saveLocalPatches(configDir, 'codex'), []);
    assert.ok(fs.statSync(configDir).isDirectory());
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('unchanged generated Codex agent TOMLs are not local patches', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-generated-toml-')));
  const source = '---\nname: fvs-researcher\ndescription: Test researcher\ntools: Read\n---\n\nDo research.\n';
  const put = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  try {
    put('agents/fvs-researcher.md', convertClaudeAgentToCodexAgent(source));
    put('agents/fvs-researcher.toml', generateCodexAgentToml('fvs-researcher', source));
    const manifest = writeManifest(dir, 'codex');
    delete manifest.files['agents/fvs-researcher.toml']; // 2.3.1 did not track generated mirrors
    fs.writeFileSync(path.join(dir, 'fvs-file-manifest.json'), JSON.stringify(manifest, null, 2));

    assert.deepEqual(saveLocalPatches(dir, 'codex'), []);
    assert.ok(!fs.existsSync(path.join(dir, 'fvs-local-patches/backup-meta.json')));

    fs.appendFileSync(path.join(dir, 'agents/fvs-researcher.toml'), '# user setting\n');
    assert.deepEqual(saveLocalPatches(dir, 'codex'), ['agents/fvs-researcher.toml']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('resolved patches stay historical instead of becoming active again', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-resolved-patch-')));
  const file = path.join(dir, 'fv-skills', 'references', 'contract.md');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'upstream');
    writeManifest(dir, 'codex');
    fs.writeFileSync(file, 'local');
    saveLocalPatches(dir, 'codex');

    const metaPath = path.join(dir, 'fvs-local-patches/backup-meta.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    assert.deepEqual(meta.pending, meta.files);
    fs.writeFileSync(file, 'upstream');
    meta.pending = []; // reapply chose the new upstream file
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    const bundles = fs.readdirSync(path.join(dir, 'fvs-local-patches/bundles'));

    assert.deepEqual(saveLocalPatches(dir, 'codex'), []);
    assert.equal(JSON.parse(fs.readFileSync(metaPath, 'utf8')).bundle, meta.bundle);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'fvs-local-patches/bundles')), bundles);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('reapply workflow retires resolved entries without deleting history', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../commands/fvs/reapply-patches.md'), 'utf8');
  assert.match(workflow, /process only `pending`/i);
  assert.match(workflow, /removed from `pending`/i);
  assert.match(workflow, /Preserve `bundle`, historical `files`, `hashes`,/);
  assert.match(workflow, /must not reactivate/i);
});

test('a redirected patch destination fails before replacing installed files', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-patch-link-')));
  try {
    fs.mkdirSync(path.join(dir, 'fv-skills'));
    fs.writeFileSync(path.join(dir, 'fv-skills/custom.md'), 'keep');
    fs.symlinkSync(os.tmpdir(), path.join(dir, 'fvs-local-patches'));
    assert.throws(() => saveLocalPatches(dir), /symlink/);
    assert.equal(fs.readFileSync(path.join(dir, 'fv-skills/custom.md'), 'utf8'), 'keep');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
