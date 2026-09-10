const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { saveLocalPatches, writeManifest } = require('../bin/install.js');

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
