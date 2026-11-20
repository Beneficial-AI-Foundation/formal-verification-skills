'use strict';

// trim-workspace: the translation patches that cut a workspace down to the crates the owner
// chose. The command prints and writes nothing; every printed patch is applied to a clean copy of
// the originals before it is printed. Charon, Aeneas and cargo are the fake scripts of the other
// multi-crate tests; the toy workspace gets a third crate that nobody needs, and a path
// dev-dependency on it.

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { RELEASE, cleanup, workspace, run: engine } = require('./helpers/fake-multicrate-tools.cjs');

after(cleanup);

// The toy workspace plus `extra`, a library no other crate needs, which `app` lists as a path
// dev-dependency (so keeping app keeps it, unless dev-dependencies are dropped).
function trimWorkspace(options = {}) {
  const ws = workspace();
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(ws.project, file)), { recursive: true });
    fs.writeFileSync(path.join(ws.project, file), text);
  };
  write('Cargo.toml', '[workspace]\nmembers = ["app", "extra", "lib"]\nresolver = "2"\n\n[workspace.package]\nversion = "0.1.0"\nedition = "2021"\n');
  write('extra/Cargo.toml', '[package]\nname = "toy-extra"\nversion.workspace = true\nedition.workspace = true\n');
  write('extra/src/lib.rs', 'pub fn extra() -> u32 { 9 }\n');
  fs.appendFileSync(path.join(ws.project, 'app/Cargo.toml'), '\n[dev-dependencies]\ntoy-extra = { path = "../extra" }\n');
  if (options.mutate) options.mutate(write, ws);
  return ws;
}

const trim = (ws, keep, extra = []) => engine(ws, ['trim-workspace', '--project-root', ws.project, '--release', RELEASE, '--keep', keep, ...extra]);

// Every file of the project with its hash, to show that nothing was written.
function snapshot(root) {
  const found = {};
  const visit = (directory) => {
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file);
      if (stat.isDirectory()) visit(file);
      else found[path.relative(root, file)] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    }
  };
  visit(root);
  return found;
}

describe('trim-workspace', () => {
  it('prints the patch that keeps one crate and what it needs, and writes nothing', () => {
    const ws = trimWorkspace();
    const before = snapshot(ws.project);
    const result = trim(ws, 'toy_app');
    assert.equal(result.status, 0, result.stdout);
    const { result: out } = result;
    assert.deepEqual(out.selected, ['toy_app']);
    assert.deepEqual(out.kept.map((entry) => [entry.crate, entry.dir, entry.because]), [
      ['toy_app', 'app', 'selected'],
      ['toy_extra', 'extra', 'dev-dependency of toy_app'],
      ['toy_lib', 'lib', 'path dependency of toy_app'],
    ]);
    assert.deepEqual(out.dropped, [], 'with the dev-dependency kept, nothing is left out');
    assert.deepEqual(snapshot(ws.project), before, 'the project is byte for byte unchanged');
  });

  it('leaves out a crate nobody needs, names it, and prints a patch that applies and is hashed', () => {
    const ws = trimWorkspace();
    const result = trim(ws, 'toy_lib');
    assert.equal(result.status, 0, result.stdout);
    const { result: out } = result;
    assert.deepEqual(out.kept.map((entry) => entry.crate), ['toy_lib']);
    assert.deepEqual(out.dropped.map((entry) => [entry.crate, entry.dir]).sort(), [['toy_app', 'app'], ['toy_extra', 'extra']]);
    assert.deepEqual(out.members, { kept: ['lib'], removed: ['app', 'extra'] });
    assert.deepEqual(out.inputs, ['Cargo.lock', 'Cargo.toml', 'lib']);
    assert.deepEqual(out.config, { extraction: { inputs: out.inputs } });
    assert.deepEqual(out.patches.map((patch) => patch.name), ['trim-workspace-manifest.patch']);
    const [patch] = out.patches;
    assert.equal(patch.sha256, crypto.createHash('sha256').update(patch.text).digest('hex'));
    assert.match(patch.text, /^Supporting patch: trim the workspace manifest to toy_lib and the crates they need\n/);
    assert.match(patch.text, /\nClassification: A-mechanical\n/);
    assert.match(patch.text, /\nIndependent: yes\n/);
    assert.match(patch.text, /-members = \["app", "extra", "lib"\]\n\+members = \[\n\+    "lib",\n\+\]\n/);
    assert.deepEqual(patch.touches, ['Cargo.toml']);
  });

  it('can drop path dev-dependencies on crates that are not kept, and says what that saves', () => {
    const ws = trimWorkspace();
    const kept = trim(ws, 'toy_app', ['--dev-dependencies', 'keep']).result;
    assert.ok(kept.kept.some((entry) => entry.crate === 'toy_extra'));
    const result = trim(ws, 'toy_app', ['--dev-dependencies', 'drop']);
    assert.equal(result.status, 0, result.stdout);
    const { result: out } = result;
    assert.deepEqual(out.kept.map((entry) => entry.crate).sort(), ['toy_app', 'toy_lib']);
    assert.deepEqual(out.dropped.map((entry) => entry.crate), ['toy_extra']);
    assert.deepEqual(out.devOnly.map((entry) => [entry.crate, entry.dir, entry.via]), [['toy_extra', 'extra', 'dev-dependency of toy_app']]);
    assert.ok(out.devOnly[0].bytes > 0);
    assert.deepEqual(out.patches.map((patch) => patch.name), ['trim-workspace-manifest.patch', 'trim-app-dev-dependencies.patch']);
    assert.match(out.patches[1].text, /Change: app\/Cargo\.toml: remove the dev-dependencies toy-extra\./);
    assert.match(out.patches[1].text, /-toy-extra = \{ path = "\.\.\/extra" \}/);
    assert.deepEqual(out.inputs, ['Cargo.lock', 'Cargo.toml', 'app', 'lib']);
  });

  it('keeps the package of a root manifest that is also the workspace, or drops its tables when it is not kept', () => {
    const rootPackage = () => trimWorkspace({ mutate: (write) => {
      write('Cargo.toml', '[package]\nname = "toy-root"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\ntoy-lib = { path = "lib" }\n\n[workspace]\nmembers = ["app", "extra", "lib"]\nresolver = "2"\n');
      write('src/lib.rs', 'pub fn root() {}\n');
    } });
    const kept = trim(rootPackage(), 'toy_root');
    assert.equal(kept.status, 0, kept.stdout);
    assert.deepEqual(kept.result.kept.map((entry) => [entry.crate, entry.because]), [['toy_root', 'selected'], ['toy_lib', 'path dependency of toy_root']]);
    assert.equal(kept.result.rootPackageRemoved, null);
    assert.deepEqual(kept.result.inputs, ['Cargo.lock', 'Cargo.toml', 'lib', 'src']);
    assert.match(kept.result.patches[0].text, /\n \[workspace\]\n-members = \["app", "extra", "lib"\]\n\+members = \[\n\+    "lib",\n\+\]\n/);
    assert.doesNotMatch(kept.result.patches[0].text, /-\[package\]/);

    const dropped = trim(rootPackage(), 'toy_lib');
    assert.equal(dropped.status, 0, dropped.stdout);
    assert.equal(dropped.result.rootPackageRemoved, 'toy-root');
    assert.deepEqual(dropped.result.inputs, ['Cargo.lock', 'Cargo.toml', 'lib']);
    assert.match(dropped.result.patches[0].text, /-\[package\]\n-name = "toy-root"\n/);
    assert.match(dropped.result.patches[0].text, /\n \[workspace\]\n-members = /);
  });

  it('refuses a crate that is not in the workspace, one without a library, and a missing --keep', () => {
    const ws = trimWorkspace({ mutate: (write) => {
      write('Cargo.toml', '[workspace]\nmembers = ["app", "extra", "lib", "tool"]\nresolver = "2"\n\n[workspace.package]\nversion = "0.1.0"\nedition = "2021"\n');
      write('tool/Cargo.toml', '[package]\nname = "toy-tool"\nversion.workspace = true\nedition.workspace = true\n');
      write('tool/src/main.rs', 'fn main() {}\n');
    } });
    const unknown = trim(ws, 'ghost');
    assert.equal(unknown.status, 5, unknown.stdout);
    assert.match(unknown.result.message, /--keep names ghost, which is not an in-repo crate of the workspace/);
    const bin = trim(ws, 'toy-tool');
    assert.equal(bin.status, 5, bin.stdout);
    assert.match(bin.result.message, /--keep names toy-tool, which has no library/);
    const bare = engine(ws, ['trim-workspace', '--project-root', ws.project, '--release', RELEASE]);
    assert.notEqual(bare.status, 0, bare.stdout);
    assert.equal(bare.result.code, 'usage');
    const sideways = trim(ws, 'toy_app', ['--dev-dependencies', 'sideways']);
    assert.notEqual(sideways.status, 0, sideways.stdout);
    assert.equal(sideways.result.code, 'usage');
    assert.match(sideways.result.message, /--dev-dependencies must be keep or drop/);
  });

  it('refuses a members pattern, which the trim cannot cut line by line', () => {
    const ws = trimWorkspace({ mutate: (write) => write('Cargo.toml', '[workspace]\nmembers = ["app", "extra", "l*"]\nresolver = "2"\n\n[workspace.package]\nversion = "0.1.0"\nedition = "2021"\n') });
    const result = trim(ws, 'toy_lib');
    assert.equal(result.status, 8, result.stdout);
    assert.match(result.result.message, /^the members list has a pattern \("l\*"\); list the members one by one before trimming$/);
  });

  it('refuses a path dependency outside the checkout and a symbolic link a kept crate needs, and reports the other links', () => {
    const outside = trimWorkspace({ mutate: (write, ws) => {
      write('lib/Cargo.toml', '[package]\nname = "toy-lib"\nversion.workspace = true\nedition.workspace = true\n\n[dependencies]\nabroad = { path = "../../abroad" }\n');
      fs.mkdirSync(path.join(path.dirname(ws.project), 'abroad', 'src'), { recursive: true });
      fs.writeFileSync(path.join(path.dirname(ws.project), 'abroad', 'Cargo.toml'), '[package]\nname = "abroad"\nversion = "0.1.0"\nedition = "2021"\n');
      fs.writeFileSync(path.join(path.dirname(ws.project), 'abroad', 'src', 'lib.rs'), '');
    } });
    const refusedOutside = trim(outside, 'toy_lib');
    assert.equal(refusedOutside.status, 8, refusedOutside.stdout);
    assert.match(refusedOutside.result.message, /^toy-lib depends by path on abroad at \.\.\/abroad, which is outside the checkout or not a package; a copy cannot hold it$/);

    const linked = trimWorkspace({ mutate: (_, ws) => fs.symlinkSync('more.rs', path.join(ws.project, 'lib/src/alias.rs')) });
    const refusedLink = trim(linked, 'toy_lib');
    assert.equal(refusedLink.status, 8, refusedLink.stdout);
    assert.match(refusedLink.result.message, /a symbolic link lies inside the crates this selection needs \(lib\/src\/alias\.rs\)/);
    assert.deepEqual(refusedLink.result.holders, ['toy_lib']);

    // Any other link under a kept crate (a generated-header directory) does not stop the selection:
    // the result proposes it for extraction.unreadLinks, as `crates` does, and the owner decides.
    const plant = (_, ws) => {
      fs.mkdirSync(path.join(ws.project, 'lib/headers'), { recursive: true });
      fs.symlinkSync('../src', path.join(ws.project, 'lib/headers/c_header_out'));
    };
    const header = trimWorkspace({ mutate: plant });
    const ok = trim(header, 'toy_lib');
    assert.equal(ok.status, 0, ok.stdout);
    assert.deepEqual(ok.result.unreadLinks, []);
    assert.deepEqual(ok.result.staleUnreadLinks, []);
    assert.equal(ok.result.proposedUnreadLinks.length, 1);
    assert.equal(ok.result.proposedUnreadLinks[0].path, 'lib/headers/c_header_out');
    assert.equal(ok.result.proposedUnreadLinks[0].target, '../src');
    assert.equal(ok.result.proposedUnreadLinks[0].buildScript, false);
    assert.equal('ignoredLinks' in ok.result, false);
    // The printed configuration holds the inputs only: the owner's yes adds the link entries.
    assert.deepEqual(Object.keys(ok.result.config.extraction), ['inputs']);

    // A link the owner has listed is reported as listed with the reason, and no longer proposed. An entry
    // that is not a link under the kept crates (a crate the trim left out) is reported as stale.
    const listed = trimWorkspace({ mutate: (write, ws) => {
      plant(write, ws);
      write('.formalising/fvs-config.json', JSON.stringify({ extraction: { unreadLinks: [
        { path: 'lib/headers/c_header_out', reason: 'generated C headers, never read by the build' },
        { path: 'other/headers/gone', reason: 'a crate the selection leaves out' },
      ] } }));
    } });
    const owned = trim(listed, 'toy_lib');
    assert.equal(owned.status, 0, owned.stdout);
    assert.deepEqual(owned.result.unreadLinks, [{ path: 'lib/headers/c_header_out', target: '../src', reason: 'generated C headers, never read by the build' }]);
    assert.deepEqual(owned.result.proposedUnreadLinks, []);
    assert.deepEqual(owned.result.staleUnreadLinks, ['other/headers/gone']);
  });

  it('prints patches that prepare accepts: the trimmed copy holds exactly the kept crates', () => {
    const ws = trimWorkspace();
    const { result: out } = trim(ws, 'toy_lib');
    fs.mkdirSync(path.join(ws.project, 'translation-patches'), { recursive: true });
    for (const patch of out.patches) fs.writeFileSync(path.join(ws.project, 'translation-patches', patch.name), patch.text);
    fs.writeFileSync(path.join(ws.project, 'translation-patches', 'series'), `${out.patches.map((patch) => patch.name).join('\n')}\n`);
    fs.writeFileSync(path.join(ws.project, '.formalising', 'fvs-config.json'), JSON.stringify({ extraction: { mode: 'translation-patches', inputs: out.inputs } }));
    const copy = path.join(ws.root, 'copies', 'trimmed');
    const prepared = engine(ws, ['prepare', '--project-root', ws.project, '--out', copy, '--release', RELEASE]);
    assert.equal(prepared.status, 0, prepared.stdout);
    const crates = engine(ws, ['crates', '--out', copy, '--release', RELEASE]);
    assert.equal(crates.status, 0, crates.stdout);
    assert.deepEqual(crates.result.crates.map((entry) => entry.crate), ['toy_lib']);
    assert.deepEqual(crates.result.compared.packagesNotInCopy.map((entry) => entry.package).sort(), ['toy-app', 'toy-extra']);
    assert.match(fs.readFileSync(path.join(copy, 'tree', 'Cargo.toml'), 'utf8'), /members = \[\s*"lib",?\s*\]/);
  });
});
