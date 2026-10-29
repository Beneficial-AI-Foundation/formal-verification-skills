'use strict';

// Fake Charon, Aeneas, rustc and cargo for tests of the patch engine's recorded
// extraction attempt. They are node scripts steered by behaviour.json next to
// them, and they record the arguments and environment they actually received.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ENGINE = path.resolve(__dirname, '..', '..', 'scripts', 'fvs-extract-patches.mjs');
const RELEASE = '.aeneas/releases/r1/darwin-arm64';
const BEHAVIOUR = "const b = JSON.parse(fs.readFileSync(path.join(path.dirname(process.argv[1]), 'behaviour.json'), 'utf8')); const args = process.argv.slice(2);";

function script(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!${process.execPath}\n'use strict';\nconst fs = require('fs'); const path = require('path');\n${body}\n`, { mode: 0o755 });
}

// Installs a fake release under PROJECT/.aeneas/releases/... and a fake cargo
// home under SCRATCH; returns their paths and a setter for the behaviour.
function fakeTools(project, scratch, behaviour = {}) {
  const release = path.join(project, RELEASE);
  fs.mkdirSync(release, { recursive: true });
  const setBehaviour = (next) => fs.writeFileSync(path.join(release, 'behaviour.json'), JSON.stringify(next));
  setBehaviour(behaviour);
  fs.writeFileSync(path.join(release, 'rust-toolchain'), '[toolchain]\nchannel = "nightly-2026-09-17"\n');
  script(path.join(release, 'charon'), `${BEHAVIOUR}
if (args[0] === 'version') { console.log('0.1.274 (fake)'); process.exit(0); }
fs.writeFileSync(path.join(path.dirname(process.argv[1]), 'seen-charon.json'), JSON.stringify({ env: process.env, args, cwd: process.cwd() }));
if (b.charonTouchTree) fs.writeFileSync(path.join(process.cwd(), 'src', 'extra.rs'), '');
const dest = args[args.indexOf('--dest-file') + 1];
const llbc = { charon_version: '0.1.274', translated: { crate_name: 'demo', options: { dest_file: dest, args },
  files: [{ id: 0, name: { Local: 'src/lib.rs' }, crate_name: 'demo', contents: fs.readFileSync(path.join(process.cwd(), 'src', 'lib.rs'), 'utf8') }],
  fun_decls: [{ def_id: 0, generics: { types: [], const_generics: [] } }] } };
if (b.llbcDuplicateFile) llbc.translated.files.push({ ...llbc.translated.files[0] });
if (b.llbcNoContents) delete llbc.translated.files[0].contents;
if (b.llbcRelabel) { llbc.translated.files[0].crate_name = b.llbcRelabel === true ? undefined : b.llbcRelabel; llbc.translated.files[0].contents += '// altered\\n'; }
if (b.llbcAlterContents) llbc.translated.files[0].contents += '// altered\\n';
if (b.llbcRelabelOnly) llbc.translated.files[0].crate_name = b.llbcRelabelOnly;
if (b.charonWriteLlbc !== false) fs.writeFileSync(dest, JSON.stringify(llbc));
if (b.charonSignal) process.kill(process.pid, 'SIGKILL');
process.exit(b.charonExit ?? 0);`);
  script(path.join(release, 'charon-driver'), 'process.exit(0);');
  script(path.join(release, 'aeneas'), `${BEHAVIOUR}
if (args[0] === '-version') { console.log('aeneas fake'); process.exit(0); }
fs.writeFileSync(path.join(path.dirname(process.argv[1]), 'seen-aeneas.json'), JSON.stringify({ env: process.env, args }));
const dest = args[args.indexOf('-dest') + 1];
if (b.aeneasTouchLlbc) fs.appendFileSync(args[args.length - 1], ' ');
fs.writeFileSync(path.join(dest, 'translation.json'), JSON.stringify({ crate: 'demo', functions: b.translationFunctions ?? [{ def_id: 0, lean_file: 'Demo.lean' }] }));
if (b.aeneasMkdir) fs.mkdirSync(path.join(dest, b.aeneasMkdir));
for (const file of b.aeneasFiles ?? ['Demo.lean']) fs.writeFileSync(path.join(dest, file), b.lean ?? 'def one := 1\\n');
process.exit(b.aeneasExit ?? 0);`);
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

function writeSpec(file, fields = {}) {
  fs.writeFileSync(file, JSON.stringify({ release: RELEASE, crate: 'demo', publishDir: 'Demo', cargoArgs: ['--locked'], ...fields }));
  return file;
}

module.exports = { ENGINE, RELEASE, fakeTools, engine, writeSpec };
