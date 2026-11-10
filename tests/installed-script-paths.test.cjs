'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-script-paths-'));
after(() => fs.rmSync(temporary, { recursive: true, force: true }));
const envFor = home => ({
  PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`,
  HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'),
  TMPDIR: temporary, DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1',
});

function run(command, args, cwd, env, input) {
  const result = spawnSync(command, args, { cwd, env, input, encoding: 'utf8' });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
  return result.stdout;
}

function styleSnippet(root, file = 'fv-skills/workflows/lean-verify.md') {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  const blocks = [...text.matchAll(/```bash\n([\s\S]*?)```/g)].map(match => match[1]);
  const snippet = blocks.find(block => block.includes('fvs-lean-style-check.mjs') && /\bdiscover\b/.test(block));
  assert.ok(snippet, 'installed workflow must contain the style-discovery command');
  return snippet.trim() + (snippet.includes('STYLE_INFO=$(') ? '\nprintf \'%s\' "$STYLE_INFO"' : '');
}

function checkSnippet(snippet, cwd, env) {
  const result = JSON.parse(run('/bin/bash', ['-c', snippet], cwd, env));
  assert.equal(result.status, 'fallback');
  assert.equal(result.maxLineLength, 100);
}

for (const runtime of ['claude', 'codex', 'opencode', 'antigravity']) {
  for (const scope of ['local', 'global', 'custom']) {
    test(`${runtime} ${scope}: emitted scripts resolve from root and nested cwd, with spaces and shell characters`, () => {
      const directory = path.join(temporary, `${runtime}-${scope}`);
      const home = path.join(directory, 'home with spaces $& $\'');
      const project = path.join(directory, 'project with spaces $literal "quote" \'apostrophe\' `tick` $& $\'');
      const nested = path.join(project, 'nested');
      for (const dir of [home, nested]) fs.mkdirSync(dir, { recursive: true });
      const env = envFor(home);
      const args = [path.join(ROOT, 'bin/install.js'), `--${runtime}`, scope === 'local' ? '--local' : '--global'];
      let config;
      if (scope === 'custom') {
        config = path.join(directory, 'custom install $literal "quote" \'apostrophe\' `tick` $& $\'');
        args.push('--config-dir', config);
      } else if (scope === 'local') {
        config = path.join(project, runtime === 'antigravity' ? '.agents' : `.${runtime}`);
      } else {
        config = path.join(home, runtime === 'antigravity' ? '.gemini/config'
          : runtime === 'opencode' ? '.config/opencode' : `.${runtime}`);
      }
      const installed = runtime === 'antigravity' ? path.join(config, 'plugins/fvs') : config;
      run(process.execPath, args, project, env);
      const auditBytes = fs.readFileSync(path.join(ROOT, 'scripts/FvsKernelAudit.lean'));
      const auditPath = path.join(installed, 'scripts/FvsKernelAudit.lean');
      assert.ok(fs.existsSync(auditPath), 'the independent checker requires its installed Lean audit helper');
      assert.deepEqual(fs.readFileSync(auditPath), auditBytes, 'installed audit helper must equal the exact source bytes');
      const manifest = JSON.parse(fs.readFileSync(path.join(installed, 'fvs-file-manifest.json'), 'utf8'));
      assert.equal(manifest.files['scripts/FvsKernelAudit.lean'], crypto.createHash('sha256').update(auditBytes).digest('hex'));
      for (const file of ['run-tests.cjs', 'build-plugin.cjs', 'build-hooks.js']) {
        assert.equal(fs.existsSync(path.join(installed, 'scripts', file)), false, 'development script is not an installed helper: ' + file);
      }
      const snippet = styleSnippet(installed);
      for (const cwd of [project, nested]) checkSnippet(snippet, cwd, env);

      const auto = fs.readFileSync(path.join(installed, 'fv-skills/workflows/auto-init.md'), 'utf8');
      const assignment = auto.split('\n').find(line => line.startsWith('AUTO='));
      assert.ok(assignment);
      for (const cwd of [project, nested]) {
        const actual = run('/bin/bash', ['-c', `${assignment}\nprintf '%s' "$AUTO"`], cwd, env);
        assert.ok(path.isAbsolute(actual));
        assert.equal(fs.realpathSync(actual), fs.realpathSync(path.join(installed, 'scripts/fvs-auto.mjs')));
        assert.match(run('/bin/bash', ['-c', `${assignment}\nnode "$AUTO" --help`], cwd, env), /Usage: node fvs-auto\.mjs/);
      }

      for (const workflow of ['auto-extract', 'aeneas-extract']) {
        const text = fs.readFileSync(path.join(installed, `fv-skills/workflows/${workflow}.md`), 'utf8');
        const assignment = text.split('\n').find(line => line.startsWith('PATCH_ENGINE='));
        assert.ok(assignment);
        for (const cwd of [project, nested]) {
          const actual = run('/bin/bash', ['-c', `${assignment}\nprintf '%s' "$PATCH_ENGINE"`], cwd, env);
          assert.equal(fs.realpathSync(actual), fs.realpathSync(path.join(installed, 'scripts/fvs-extract-patches.mjs')));
        }
      }
      for (const [file, script] of [
        ['fv-skills/workflows/lean-verify.md', 'fvs-checker.mjs'],
        ['fv-skills/references/extraction-patch-migration.md', 'fvs-extract-patches.mjs'],
        ['fv-skills/references/auto-setup.md', 'fvs-auto.mjs'],
        ['fv-skills/references/auto-setup.md', 'fvs-probe-inventory.mjs'],
      ]) {
        const text = fs.readFileSync(path.join(installed, file), 'utf8');
        const calls = text.split('\n').filter(line => line.includes('node ') && line.includes(`/scripts/${script}`));
        assert.ok(calls.length, file);
        for (const call of calls) {
          const start = call.indexOf('node ') + 5, end = call.indexOf(`/${script}`, start) + script.length + 2;
          const token = call.slice(start, end);
          for (const cwd of [project, nested]) {
            const actual = run('/bin/bash', ['-c', `printf '%s' ${token}`], cwd, env);
            assert.equal(fs.realpathSync(actual), fs.realpathSync(path.join(installed, 'scripts', script)));
          }
        }
      }

      // The two historical review workflow call sites must name this installation,
      // without invoking a provider or constructing a review request.
      for (const [workflow, script] of [['crypto-review', 'fvs-codex-think.mjs'], ['lean-spec-review', 'fvs-spec-review.mjs']]) {
        const text = fs.readFileSync(path.join(installed, `fv-skills/workflows/${workflow}.md`), 'utf8');
        const call = text.split('\n').find(line => line.startsWith('node ') && line.includes(`/scripts/${script}`));
        const token = call.slice(5, call.indexOf(`/${script}`) + script.length + 2);
        const resolved = run('/bin/bash', ['-c', `printf '%s' ${token}`], nested, env);
        assert.ok(path.isAbsolute(resolved));
        assert.equal(fs.realpathSync(resolved), fs.realpathSync(path.join(installed, 'scripts', script)));
      }
    });
  }
}

test('plugin snippets retain their plugin root and execute after host expansion, independent of cwd', () => {
  const plugin = path.join(temporary, 'plugin cache with spaces');
  const project = path.join(temporary, 'plugin project/nested');
  const home = path.join(temporary, 'plugin home');
  for (const dir of [project, home]) fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(path.join(ROOT, 'plugins/fvs'), plugin, { recursive: true });
  const snippet = styleSnippet(plugin);
  assert.ok(snippet.includes('${CLAUDE_PLUGIN_ROOT}/scripts/'));
  checkSnippet(snippet.replaceAll('${CLAUDE_PLUGIN_ROOT}', plugin), project, envFor(home));
});

test('Pi snippets keep package-relative resources, quoted after resolution against the skill directory', () => {
  const packageRoot = path.join(temporary, 'Pi package with spaces');
  const skillDirectory = path.join(packageRoot, 'pi/skills/fvs-lean-verify');
  const project = path.join(temporary, 'Pi project/nested');
  const home = path.join(temporary, 'Pi home');
  for (const dir of [project, home, path.join(packageRoot, 'scripts')]) fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(path.join(ROOT, 'pi/skills/fvs-lean-verify'), skillDirectory, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'scripts/fvs-lean-style-check.mjs'), path.join(packageRoot, 'scripts/fvs-lean-style-check.mjs'));
  const snippet = styleSnippet(skillDirectory, 'SKILL.md');
  assert.ok(snippet.includes('"../../../scripts/fvs-lean-style-check.mjs"'));
  // This is the documented Pi host/agent resolution step, not resolution from cwd.
  const relative = '../../../scripts/fvs-lean-style-check.mjs';
  const resolved = path.resolve(skillDirectory, relative);
  checkSnippet(snippet.replace(relative, resolved), project, envFor(home));
});

test('CommonJS marker scopes installed .js hooks without changing an ESM project or .mjs scripts', () => {
  const project = path.join(temporary, 'esm project');
  const home = path.join(temporary, 'esm home');
  for (const dir of [project, home]) fs.mkdirSync(dir, { recursive: true });
  const packageText = '{"name":"fixture-only","type":"module"}\n';
  fs.writeFileSync(path.join(project, 'package.json'), packageText);
  const env = envFor(home);
  run(process.execPath, [path.join(ROOT, 'bin/install.js'), '--claude', '--local'], project, env);
  const installed = path.join(project, '.claude');
  assert.equal(fs.readFileSync(path.join(installed, 'package.json'), 'utf8'), '{"type":"commonjs"}\n');
  assert.equal(fs.readFileSync(path.join(project, 'package.json'), 'utf8'), packageText);
  const output = run(process.execPath, [path.join(installed, 'hooks/fvs-statusline.js')], project, env,
    JSON.stringify({ model: { display_name: 'fixture-model' }, workspace: { current_dir: project } }));
  assert.match(output, /fixture-model/);
  checkSnippet(styleSnippet(installed), project, env);
});

for (const runtime of ['claude', 'codex', 'opencode', 'antigravity']) {
  test(`${runtime}: uninstall removes the owned audit helper and preserves an unrelated directory`, () => {
    const project = path.join(temporary, 'audit-cleanup-' + runtime);
    const home = path.join(temporary, 'audit-cleanup-home-' + runtime);
    fs.mkdirSync(project); fs.mkdirSync(home);
    const env = envFor(home);
    const args = [path.join(ROOT, 'bin/install.js'), `--${runtime}`, '--local'];
    run(process.execPath, args, project, env);
    const installed = path.join(project, runtime === 'antigravity' ? '.agents/plugins/fvs' : `.${runtime}`);
    const audit = path.join(installed, 'scripts/FvsKernelAudit.lean');
    assert.ok(fs.existsSync(audit));
    const unrelated = path.join(project, 'unrelated'); fs.mkdirSync(unrelated);
    fs.writeFileSync(path.join(unrelated, 'FvsKernelAudit.lean'), 'unrelated owned fixture');
    run(process.execPath, [...args, '--uninstall'], project, env);
    assert.equal(fs.existsSync(audit), false);
    assert.equal(fs.readFileSync(path.join(unrelated, 'FvsKernelAudit.lean'), 'utf8'), 'unrelated owned fixture');
  });
}
