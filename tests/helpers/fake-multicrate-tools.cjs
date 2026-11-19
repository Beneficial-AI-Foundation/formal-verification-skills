'use strict';

// Fake Charon, Aeneas, rustc and cargo for tests of multi-crate extraction. Unlike
// fake-extraction-tools, Charon here reads `--package` and the manifests of the copy
// it runs in, and writes the LLBC the real tool writes for a workspace: the main
// crate's sources with their contents, and the sources of every crate it reaches by
// a path dependency labelled with that crate and with null contents. Behaviour is
// steered per crate by behaviour.json next to the tools:
//   { "<crate>": { charonExit, hasErrors, errorItems, relabelForeign, alterForeign,
//                  alterMain, aeneasExit, lean } }

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ENGINE = path.resolve(__dirname, '..', '..', 'scripts', 'fvs-extract-patches.mjs');
const RELEASE = '.aeneas/releases/r1/darwin-arm64';
const BEHAVIOUR = "const b = JSON.parse(fs.readFileSync(path.join(path.dirname(process.argv[1]), 'behaviour.json'), 'utf8')); const args = process.argv.slice(2);";

function script(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!${process.execPath}\n'use strict';\nconst fs = require('fs'); const path = require('path');\n${body}\n`, { mode: 0o755 });
}

const CHARON = `${BEHAVIOUR}
if (args[0] === 'version') { console.log('0.1.315 (fake)'); process.exit(0); }
const cwd = fs.realpathSync(process.cwd());
const dest = args[args.indexOf('--dest-file') + 1];
const cargoArgs = args.includes('--') ? args.slice(args.indexOf('--') + 1) : [];
const pkg = cargoArgs[cargoArgs.indexOf('--package') + 1];
const crateOf = (name) => name.replace(/-/g, '_');
const info = {};
(function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'target') continue;
    const file = path.join(dir, name);
    if (fs.statSync(file).isDirectory()) walk(file);
    else if (name === 'Cargo.toml') {
      const text = fs.readFileSync(file, 'utf8');
      const crate = /^name\\s*=\\s*"([^"]+)"/m.exec(text)?.[1];
      if (!crate) continue;
      const deps = [...text.matchAll(/^(\\S+)\\s*=\\s*\\{[^}]*path\\s*=\\s*"([^"]+)"/gm)].map((m) => path.resolve(path.dirname(file), m[2]));
      info[crate] = { dir: path.dirname(file), deps };
    }
  }
})(cwd);
const me = info[pkg];
const mine = b[crateOf(pkg)] ?? {};
fs.writeFileSync(path.join(path.dirname(process.argv[1]), 'seen-charon-' + crateOf(pkg) + '.json'), JSON.stringify({ args, cwd }));
const rel = (file) => path.relative(cwd, file).split(path.sep).join('/');
const sourcesOf = (dir) => fs.readdirSync(path.join(dir, 'src')).filter((name) => name.endsWith('.rs')).sort().map((name) => path.join(dir, 'src', name));
const files = [];
sourcesOf(me.dir).forEach((file) => files.push({ id: files.length, name: { Local: rel(file) }, crate_name: crateOf(pkg), contents: fs.readFileSync(file, 'utf8') + (mine.alterMain ? '// altered\\n' : '') }));
for (const dep of me.deps) {
  const owner = Object.keys(info).find((name) => info[name].dir === dep);
  sourcesOf(dep).forEach((file) => files.push({ id: files.length, name: { Local: rel(file) }, crate_name: mine.relabelForeign ?? crateOf(owner), contents: mine.alterForeign ? fs.readFileSync(file, 'utf8') + '// altered\\n' : null }));
}
const decl = (name, errors) => ({ def_id: 0, item_meta: { name: [{ Ident: [crateOf(pkg), 0] }, { Ident: [name, 0] }], has_errors: errors } });
const decls = [{ ...decl('one', false), def_id: 0 }];
(mine.errorItems ?? []).forEach((name, index) => decls.push({ ...decl(name, true), def_id: index + 1 }));
const llbc = { charon_version: '0.1.315', has_errors: mine.hasErrors === true,
  translated: { crate_name: mine.llbcCrate ?? crateOf(pkg), options: { dest_file: dest, args }, files, fun_decls: decls, type_decls: [], global_decls: [], trait_decls: [], trait_impls: [] } };
if (mine.charonExit === undefined || mine.charonExit === 0) fs.writeFileSync(dest, JSON.stringify(llbc));
process.exit(mine.charonExit ?? 0);`;

const AENEAS = `${BEHAVIOUR}
if (args[0] === '-version') { console.log('aeneas fake'); process.exit(0); }
const dest = args[args.indexOf('-dest') + 1];
const llbc = args[args.length - 1];
const stem = path.basename(llbc).replace(/\\.llbc$/, '');
const camel = stem.split('_').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('');
const mine = b[stem] ?? {};
fs.writeFileSync(path.join(dest, 'translation.json'), JSON.stringify({ crate: stem, functions: [{ def_id: 0, lean_file: camel + '.lean', is_local: true }] }));
fs.writeFileSync(path.join(dest, camel + '.lean'), mine.lean ?? ('def ' + stem + '_one := 1\\n'));
process.exit(mine.aeneasExit ?? 0);`;

// Installs a fake release under PROJECT/.aeneas/releases/... and a fake cargo home
// under SCRATCH; returns their paths and a setter for the behaviour.
function fakeMultiTools(project, scratch, behaviour = {}) {
  const release = path.join(project, RELEASE);
  fs.mkdirSync(release, { recursive: true });
  const setBehaviour = (next) => fs.writeFileSync(path.join(release, 'behaviour.json'), JSON.stringify(next));
  setBehaviour(behaviour);
  fs.writeFileSync(path.join(release, 'rust-toolchain'), '[toolchain]\nchannel = "nightly-2026-09-17"\n');
  script(path.join(release, 'charon'), CHARON);
  script(path.join(release, 'charon-driver'), 'process.exit(0);');
  script(path.join(release, 'aeneas'), AENEAS);
  const cargoHome = path.join(scratch, 'cargo-home');
  script(path.join(cargoHome, 'bin', 'rustc'), "console.log('rustc 1.100.0-nightly (fake)'); console.log('host: aarch64-apple-darwin');");
  script(path.join(cargoHome, 'bin', 'cargo'), "console.log('cargo 1.100.0-nightly (fake)');");
  return { release, cargoHome, scratch, setBehaviour };
}

// Runs the engine with a minimal caller environment plus EXTRA.
function engine(tools, args, extra = {}) {
  const env = { HOME: path.join(tools.scratch, 'home'), RUSTUP_HOME: path.join(tools.scratch, 'rustup'), CARGO_HOME: tools.cargoHome, PATH: '/usr/bin:/bin', ...extra };
  const run = spawnSync(process.execPath, [ENGINE, ...args], { env, encoding: 'utf8' });
  let result;
  try {
    result = JSON.parse(run.stdout);
  } catch {
    result = { code: 'unparsed', stdout: run.stdout, stderr: run.stderr };
  }
  return { status: run.status, result, stdout: run.stdout, stderr: run.stderr };
}

// A toy workspace: an app crate that depends on a library crate by path, both
// inside the repository, with a workspace manifest at the root.
function toyWorkspace(root) {
  const project = path.join(root, 'project');
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
    fs.writeFileSync(path.join(project, file), text);
  };
  write('Cargo.toml', '[workspace]\nmembers = ["app", "lib"]\nresolver = "2"\n\n[workspace.package]\nversion = "0.1.0"\nedition = "2021"\n');
  write('Cargo.lock', 'version = 3\n');
  write('lib/Cargo.toml', '[package]\nname = "toy-lib"\nversion.workspace = true\nedition.workspace = true\n');
  write('lib/src/lib.rs', 'pub fn one() -> u32 { 1 }\n');
  write('lib/src/more.rs', 'pub fn two() -> u32 { 2 }\n');
  write('app/Cargo.toml', '[package]\nname = "toy-app"\nversion.workspace = true\nedition.workspace = true\n\n[dependencies]\ntoy-lib = { path = "../lib" }\n');
  write('app/src/lib.rs', 'pub fn three() -> u32 { toy_lib::one() + 2 }\n');
  write('.formalising/fvs-config.json', JSON.stringify({ extraction: { inputs: ['Cargo.toml', 'Cargo.lock', 'app', 'lib'] } }));
  return project;
}

const toySpec = (fields = {}) => ({
  release: RELEASE,
  cargoArgs: ['--locked'],
  main: 'toy_app',
  crates: [
    { crate: 'toy_lib', package: 'toy-lib', dir: 'lib', publishDir: 'Lean/Lib' },
    { crate: 'toy_app', package: 'toy-app', dir: 'app', publishDir: 'Lean/App' },
  ],
  ...fields,
});


// Lifecycle helpers shared by the multi-crate test files: a toy workspace with fake
// tools, a prepared copy, a recorded attempt and the stages of every crate.
const TMP = fs.realpathSync(os.tmpdir());
const temporaryDirectories = [];
let counter = 0;

function cleanup() {
  for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true });
}

function workspace(behaviour = {}) {
  const root = fs.mkdtempSync(path.join(TMP, 'fvs-multicrate-'));
  temporaryDirectories.push(root);
  const project = toyWorkspace(root);
  const tools = fakeMultiTools(project, root, behaviour);
  fs.mkdirSync(path.join(root, 'copies'));
  return { root, project, tools, behaviour: tools.setBehaviour, release: tools.release };
}

const run = (ws, args) => engine(ws.tools, args);

function prepared(ws) {
  const out = path.join(ws.root, 'copies', `out-${(counter += 1)}`);
  const prep = run(ws, ['prepare', '--project-root', ws.project, '--out', out]);
  if (prep.status !== 0) throw new Error(prep.stdout);
  return out;
}

function specFile(ws, spec) {
  const file = path.join(ws.root, `spec-${(counter += 1)}.json`);
  fs.writeFileSync(file, JSON.stringify(spec));
  return file;
}

function attempted(ws, spec = toySpec()) {
  const out = prepared(ws);
  return { out, recorded: run(ws, ['attempt', '--out', out, '--spec', specFile(ws, spec)]) };
}

const step = (ws, out, name, crate) => run(ws, ['run', '--out', out, '--step', name, ...(crate ? ['--crate', crate] : [])]);

function completeUnit(ws, out, crate) {
  for (const name of ['charon', 'aeneas', 'publish']) {
    const done = step(ws, out, name, crate);
    if (done.status !== 0) throw new Error(`${crate} ${name}: ${done.stdout}`);
  }
}

// Runs the chain of every crate in dependency order (the order of the attempt record).
function complete(ws, spec) {
  const { out, recorded } = attempted(ws, spec);
  if (recorded.status !== 0) throw new Error(recorded.stdout);
  for (const crate of recorded.result.attempt.order) completeUnit(ws, out, crate);
  return out;
}

module.exports = { ENGINE, RELEASE, fakeMultiTools, engine, toyWorkspace, toySpec, cleanup, workspace, run, prepared, specFile, attempted, step, completeUnit, complete };
