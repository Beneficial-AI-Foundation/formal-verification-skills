'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PI_SKILLS_ROOT = path.join(ROOT, 'pi', 'skills');

function skillNames() {
  return fs.readdirSync(PI_SKILLS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

describe('Pi package', () => {
  it('is discoverable and ships its generated skills', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.ok(pkg.keywords.includes('pi-package'));
    assert.deepEqual(pkg.pi, { skills: ['./pi/skills'] });
    assert.ok(pkg.files.includes('pi'));
  });

  it('loads 30 generated skills with zero structural diagnostics', () => {
    const commands = fs.readdirSync(path.join(ROOT, 'commands', 'fvs'))
      .filter((name) => name.endsWith('.md'))
      .map((name) => `fvs-${name.slice(0, -3)}`)
      .sort();
    const diagnostics = [];

    assert.equal(commands.length, 30);
    assert.deepEqual(skillNames(), commands);
    for (const name of commands) {
      const raw = fs.readFileSync(path.join(PI_SKILLS_ROOT, name, 'SKILL.md'), 'utf8');
      const frontmatter = raw.match(/^---\n([\s\S]*?)\n---\n/);
      if (!frontmatter) diagnostics.push(`${name}: missing frontmatter`);
      if (!new RegExp(`^name: ${name}$`, 'm').test(frontmatter?.[1] ?? '')) {
        diagnostics.push(`${name}: invalid name`);
      }
      if (!/^description: .+/m.test(frontmatter?.[1] ?? '')) {
        diagnostics.push(`${name}: missing description`);
      }
    }
    assert.deepEqual(diagnostics, []);
  });

  it('exposes every FVS command as a valid namespaced Pi skill', () => {
    const commands = fs.readdirSync(path.join(ROOT, 'commands', 'fvs'))
      .filter((name) => name.endsWith('.md'))
      .map((name) => `fvs-${name.slice(0, -3)}`)
      .sort();

    assert.deepEqual(skillNames(), commands);
    for (const name of commands) {
      const raw = fs.readFileSync(path.join(PI_SKILLS_ROOT, name, 'SKILL.md'), 'utf8');
      assert.match(raw, new RegExp(`^name: ${name}$`, 'm'));
      assert.ok(raw.includes('<pi_package_runtime>'));
      assert.ok(!raw.includes('.claude/'));
      assert.ok(!raw.includes('CLAUDE_PLUGIN_ROOT'));
    }
  });

  it('documents Pi-native entry points and package updates', () => {
    const help = fs.readFileSync(path.join(PI_SKILLS_ROOT, 'fvs-help', 'SKILL.md'), 'utf8');
    const update = fs.readFileSync(path.join(PI_SKILLS_ROOT, 'fvs-update', 'SKILL.md'), 'utf8');
    const patches = fs.readFileSync(path.join(PI_SKILLS_ROOT, 'fvs-reapply-patches', 'SKILL.md'), 'utf8');

    assert.ok(help.includes('/skill:fvs-fc'));
    assert.ok(help.includes('/skill:fvs-crypto-plan'));
    assert.ok(update.includes('pi update npm:fv-skills-baif'));
    assert.ok(patches.includes('managed Pi package'));
  });
});
