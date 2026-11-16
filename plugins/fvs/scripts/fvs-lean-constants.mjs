#!/usr/bin/env node
// Lean-only constants producer: runs FVS's LeanConstants program inside the
// project's own Lean environment and writes the fvs/lean-constants version 2
// record, its fvs/lean-constants-run receipt and the import manifest. No probe
// is involved; the toolchain is whatever the project pins, recorded as evidence.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ILEAN_DIR, projectInputs, oracleShapeProblems, constantsRunProblems, compiledProblems, importProblems, projectModules, notBuiltHint } from './fvs-lean-graph.mjs';

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
// A library root is interpolated into Lean source that #eval runs, and the
// extractor compares module roots, so only a plain top-level identifier.
const ROOT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class Refusal extends Error {}
const refuse = (message) => { throw new Refusal(message); };

// Modules the roots do not import are imported by name after them, so their
// constants are in the environment too.
const header = (roots, extra = []) => `${[...roots, ...extra].map((module) => `import ${module}`).join('\n')}\nopen Lean\n`;

// Import discovery: every module of the roots' import closure, the compiled
// file Lean resolves for it and which data parts exist.
export const discoverySource = (roots, extra = []) => `${header(roots, extra)}
/-! Import discovery for the Lean constants oracle: every module in the import
closure of the roots above, the compiled file Lean resolves for it (findOLean)
and which of its data parts exist (.olean, .olean.server, .olean.private),
which a non-module importer loads. -/

def discover : CoreM Json := do
  let env ← getEnv
  let mut rows : Array Json := #[]
  for mod in env.header.moduleNames do
    let olean ← findOLean mod
    let mut parts : Array String := #[]
    for suffix in ["", ".server", ".private"] do
      let file : System.FilePath := ⟨olean.toString ++ suffix⟩
      if ← file.pathExists then parts := parts.push suffix
    rows := rows.push <| Json.mkObj [("module", toJson mod), ("olean", toJson olean.toString), ("parts", toJson parts)]
  return Json.arr rows

#eval show CoreM Unit from do
  IO.println (← discover).compress
`;

// The constants extractor (fvs/lean-constants version 2, extractor v3).
export const extractorSource = (roots, extra = []) => `${header(roots, extra)}
/-! Lean constants extractor, fvs/lean-constants version 2, extractor v3 (body only; the
harness adds schema, producer and inputs). For every constant declared in a
project module: kernel kind, module, whether Lean has a declaration range
for it (evidence only; source status comes from the bound .ilean files), structure and projection facts, kernel family links, structure
fields resolved to their projection functions, the constants its type and its
value mention (separately; theorem proofs included), and, for definitions,
theorems and opaque constants, the axioms Lean.collectAxioms reports. Also the
environment's imported module names, for comparison with discovery, and every
constant a lane names outside the project with the module Lean records for it,
so a missing project constant is never mistaken for an external one. -/

def projectRoots : List Name := [${roots.map((root) => `\`${root}`).join(', ')}]

def isProjectModule (m : Name) : Bool := projectRoots.contains m.getRoot

def kindOf : ConstantInfo → String
  | .axiomInfo _ => "axiom"
  | .defnInfo _ => "def"
  | .thmInfo _ => "theorem"
  | .opaqueInfo _ => "opaque"
  | .quotInfo _ => "quot"
  | .inductInfo _ => "inductive"
  | .ctorInfo _ => "ctor"
  | .recInfo _ => "recursor"

def moduleOf (env : Environment) (nm : Name) : Option Name :=
  (env.getModuleIdxFor? nm).map fun idx => env.header.moduleNames[idx.toNat]!

def extract : CoreM Json := do
  let env ← getEnv
  let mut own : Array (Name × ConstantInfo) := #[]
  for pair in env.constants.map₁.toList do
    if (moduleOf env pair.1).any isProjectModule then own := own.push pair
  let mut nodes : Array Json := #[]
  for (nm, info) in own do
    let typeUses := info.type.getUsedConstants
    let valueUses := ((info.value? (allowOpaque := true)).map (·.getUsedConstants)).getD #[]
    let ranges ← findDeclarationRanges? nm
    let family : List (String × Json) := match info with
      | .inductInfo v =>
        let recursors := own.filterMap fun (r, ri) => match ri with
          | .recInfo rv => if rv.all.contains nm then some r else none
          | _ => none
        [("family", Json.mkObj [("ctors", toJson v.ctors), ("recursors", toJson recursors)])]
      | .ctorInfo v => [("family", Json.mkObj [("inductive", toJson v.induct)])]
      | .recInfo v => [("family", Json.mkObj [("inductives", toJson v.all)])]
      | _ => []
    let fields : List (String × Json) :=
      if isStructure env nm then
        [("fields", Json.arr ((getStructureFields env nm).map fun f =>
          Json.mkObj [("field", toJson f), ("projection", toJson (getProjFnForField? env nm f))]))]
      else []
    let axioms ← match info with
      | .defnInfo _ | .thmInfo _ | .opaqueInfo _ => do pure [("axioms", toJson (← collectAxioms nm))]
      | _ => pure []
    nodes := nodes.push <| Json.mkObj ([
      ("name", toJson nm), ("module", toJson (moduleOf env nm)), ("kind", toJson (kindOf info)),
      ("hasDeclarationRange", toJson ranges.isSome), ("isStructure", toJson (isStructure env nm)),
      ("isProjection", toJson (env.isProjectionFn nm)),
      ("isClass", toJson (isClass env nm)), ("isInstance", toJson (Meta.isInstanceCore env nm)),
      ("type", toJson typeUses), ("value", toJson valueUses)] ++ family ++ fields ++ axioms)
  let ownNames : NameSet := own.foldl (fun acc p => acc.insert p.1) {}
  let mut seen : NameSet := {}
  let mut referenced : Array Json := #[]
  for p in own do
    let info := p.2
    let uses := info.type.getUsedConstants ++ ((info.value? (allowOpaque := true)).map (·.getUsedConstants)).getD #[]
    for c in uses do
      unless ownNames.contains c || seen.contains c do
        seen := seen.insert c
        referenced := referenced.push <| Json.mkObj [("name", toJson c), ("module", toJson (moduleOf env c))]
  return Json.mkObj [("nodes", Json.arr nodes), ("referenced", Json.arr referenced), ("moduleNames", toJson env.header.moduleNames)]

#eval show CoreM Unit from do
  IO.println (← extract).compress
`;

function usage() {
  process.stdout.write([
    'Usage: node fvs-lean-constants.mjs run --project DIR --roots ROOT[,ROOT...] --out DIR [--lake FILE]',
    '',
    '--project  the Lean project root (where lake build works)',
    '--roots    the project\'s Lean library roots, plain top-level names',
    '--out      a new directory outside the project; the Lean programs stay in DIR/work, because the',
    '           receipt names them and the graph step re-hashes them',
    '--lake     the toolchain\'s lake binary; by default the one beside `lean --print-prefix` in the project',
    '',
    'Builds the roots (lake --no-cache --rehash --verbose build), then by name (+Module) any project module',
    'under the roots that they do not import, with a warning in the receipt; discovers the import inventory before',
    'and after running the extractor, and writes constants.json, constants-run.json and imports.json',
    'only when every step succeeded and nothing changed during the run.',
    'Exit: 0 written; 1 refused or a step failed (the reason is printed; logs stay in DIR); 2 usage.',
    '',
  ].join('\n'));
}

// The Lake and Lean binaries of the project's toolchain (not an elan shim).
export function toolchain(project, lakeFlag) {
  let lake = lakeFlag;
  if (!lake) {
    const prefix = spawnSync('lean', ['--print-prefix'], { cwd: project, encoding: 'utf8' });
    if (prefix.status !== 0 || !prefix.stdout.trim()) refuse('cannot find the project\'s Lean toolchain (lean --print-prefix failed); pass --lake');
    lake = path.join(prefix.stdout.trim(), 'bin', 'lake');
  }
  if (!path.isAbsolute(lake) || path.basename(lake) !== 'lake') refuse('--lake must be an absolute path to a file named lake');
  const lean = path.join(path.dirname(lake), 'lean');
  for (const file of [lake, lean]) if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) refuse(`no toolchain binary at ${file}`);
  let name = 'unknown (no lean-toolchain file)';
  try { name = fs.readFileSync(path.join(project, 'lean-toolchain'), 'utf8').trim() || name; } catch { /* evidence only */ }
  return { lake, lean, name };
}

// One step with its output in a log file (discovery logs exceed spawnSync's buffer).
function step(out, name, argv, cwd) {
  const log = path.join(out, `${name}.log`);
  const fd = fs.openSync(log, 'wx');
  try {
    const result = spawnSync(argv[0], argv.slice(1), { cwd, stdio: ['ignore', fd, fd], env: { ...process.env, LEAN_NUM_THREADS: '2' } });
    if (result.error) refuse(`${name}: ${result.error.message}`);
    if (result.status !== 0) refuse(`${name} exited ${result.status ?? result.signal} (see ${log})`);
  } finally { fs.closeSync(fd); }
  return fs.readFileSync(log, 'utf8');
}

const lastLine = (text, opener, name) => {
  const lines = text.split('\n').filter((line) => line.startsWith(opener));
  if (lines.length !== 1) refuse(`${name} printed ${lines.length} JSON values, not one`);
  try { return JSON.parse(lines[0]); } catch { return refuse(`${name} output is not JSON`); }
};

// Canonical import inventory: each module's compiled file and the sha256 of every data part.
function inventory(text, name) {
  const rows = lastLine(text, '[', name);
  const modules = {};
  for (const row of Array.isArray(rows) ? rows : refuse(`${name} output is not a list`)) {
    if (Object.hasOwn(modules, row.module)) refuse(`${name} lists module ${row.module} twice`);
    modules[row.module] = { olean: row.olean, parts: Object.fromEntries(row.parts.map((suffix) => [suffix || '.olean', sha256(fs.readFileSync(row.olean + suffix))]).sort()) };
  }
  const sortedKeys = (value) => (value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedKeys(value[key])])) : value);
  const textOut = JSON.stringify(sortedKeys({ modules }));
  return { text: textOut, summary: { digest: sha256(textOut), modules: Object.keys(modules).length, files: Object.values(modules).reduce((n, m) => n + Object.keys(m.parts).length, 0) } };
}

// The project's compiled modules (every .olean data part and sidecar), by path from the project root.
function compiledFiles(project) {
  const compiled = {};
  const walk = (directory, relative) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const rel = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(path.join(directory, entry.name), rel);
      else if (entry.name.includes('.olean')) compiled[rel] = sha256(fs.readFileSync(path.join(directory, entry.name)));
    }
  };
  if (fs.existsSync(path.join(project, ILEAN_DIR))) walk(path.join(project, ILEAN_DIR), ILEAN_DIR);
  return Object.fromEntries(Object.entries(compiled).sort());
}

const publish = (file, text) => {
  fs.writeFileSync(`${file}.tmp`, text, { flag: 'wx' });
  fs.renameSync(`${file}.tmp`, file);
};

export function produce({ project: projectArg, roots, out: outArg, lake: lakeArg }) {
  if (!Array.isArray(roots) || roots.length === 0 || roots.some((root) => !ROOT_NAME.test(root)) || new Set(roots).size !== roots.length) {
    refuse('--roots must be distinct plain top-level Lean names');
  }
  if (!projectArg || !fs.statSync(projectArg, { throwIfNoEntry: false })?.isDirectory()) refuse('--project must be an existing directory');
  const project = fs.realpathSync(projectArg);
  if (!outArg) refuse('--out is required');
  const parent = fs.realpathSync(path.dirname(path.resolve(outArg)));
  const out = path.join(parent, path.basename(outArg));
  // A .lean file inside the project would itself become a project input.
  if (out === project || out.startsWith(`${project}${path.sep}`)) refuse('--out must be outside the project');
  if (fs.existsSync(out)) refuse('--out must be a new directory');
  const tools = toolchain(project, lakeArg);
  fs.mkdirSync(out);
  const work = path.join(out, 'work');
  fs.mkdirSync(work);
  const self = fileURLToPath(import.meta.url);
  const discoverArgvFor = (file) => [tools.lake, 'env', 'lean', '--threads=2', file];
  const build = (name, targets) => step(out, name, [tools.lake, '--no-cache', '--rehash', '--verbose', 'build', ...targets], project);

  // The build runs in place, so the inputs are fixed before it starts. It may
  // write only build outputs under .lake (the compiled files and .ilean files);
  // every other project input must come out of it byte for byte unchanged.
  const sources = (inputs) => Object.fromEntries(Object.entries(inputs).filter(([file]) => !file.startsWith(`${ILEAN_DIR}/`)));
  const baseline = sources(projectInputs(project));
  const unchanged = () => {
    const built = sources(projectInputs(project));
    const touched = [...new Set([...Object.keys(baseline), ...Object.keys(built)])].filter((file) => baseline[file] !== built[file]).sort();
    if (touched.length > 0) refuse(`the project files changed during the build (only build outputs under .lake may change): ${touched.join(', ')}`);
  };
  build('01-build', roots);
  unchanged();

  // Building the roots compiles only their import closure. A project module
  // outside it is built by name and imported after the roots, so the record
  // still covers it, and the run receipt warns that a plain build skips it.
  const rootsDiscovery = path.join(work, 'DiscoverRoots.lean');
  fs.writeFileSync(rootsDiscovery, discoverySource(roots), { flag: 'wx' });
  const reached = new Set(Object.keys(JSON.parse(inventory(step(out, '01a-discover-roots', discoverArgvFor(rootsDiscovery), project), 'discovery').text).modules));
  const unimported = projectModules(baseline).map((module) => module.replaceAll('/', '.'))
    .filter((module) => roots.includes(module.split('.')[0]) && !reached.has(module)).sort();
  const warnings = [];
  if (unimported.length > 0) {
    // A module name goes into Lean source and Lake's arguments, so only plain identifiers.
    if (!unimported.every((module) => module.split('.').every((part) => ROOT_NAME.test(part)))) {
      refuse(`the library roots do not import ${unimported.join(', ')}: ${notBuiltHint(unimported, roots)}`);
    }
    build('01b-build-modules', unimported.map((module) => `+${module}`));
    unchanged();
    warnings.push(`the library roots do not import ${unimported.join(', ')}, so Lake built them by name for this record and a plain lake build skips them: ${notBuiltHint(unimported, roots)}`);
  }

  const discovery = path.join(work, 'Discover.lean');
  const extractor = path.join(work, 'LeanConstants.lean');
  fs.writeFileSync(discovery, discoverySource(roots, unimported), { flag: 'wx' });
  fs.writeFileSync(extractor, extractorSource(roots, unimported), { flag: 'wx' });
  const producer = {
    toolchain: tools.name,
    leanSha256: sha256(fs.readFileSync(tools.lean)),
    lakeSha256: sha256(fs.readFileSync(tools.lake)),
    extractorSha256: sha256(fs.readFileSync(extractor)),
    discoverySha256: sha256(fs.readFileSync(discovery)),
    harnessSha256: sha256(fs.readFileSync(self)),
  };
  const oracleArgv = [tools.lake, 'env', 'lean', '--threads=2', extractor];
  const discoverArgv = discoverArgvFor(discovery);
  const files = projectInputs(project);
  const compiled = compiledFiles(project);
  const before = inventory(step(out, '02-discover-before', discoverArgv, project), 'discovery');
  // Every project module under the roots must now be loaded, or the record would silently leave it out.
  const loaded = new Set(Object.keys(JSON.parse(before.text).modules));
  const unbuilt = projectModules(files).map((module) => module.replaceAll('/', '.'))
    .filter((module) => roots.includes(module.split('.')[0]) && !loaded.has(module)).sort();
  if (unbuilt.length > 0) refuse(`the library roots do not import ${unbuilt.join(', ')}: ${notBuiltHint(unbuilt, roots)}`);
  const body = lastLine(step(out, '03-constants', oracleArgv, project), '{', 'the extractor');
  const after = inventory(step(out, '04-discover-after', discoverArgv, project), 'discovery');
  if (before.summary.digest !== after.summary.digest) refuse('the import inventory changed during the extractor run');
  if (JSON.stringify(projectInputs(project)) !== JSON.stringify(files) || JSON.stringify(compiledFiles(project)) !== JSON.stringify(compiled)) {
    refuse('the project files or compiled modules changed during the run');
  }
  const modules = Object.keys(JSON.parse(before.text).modules);
  if (!Array.isArray(body?.moduleNames) || JSON.stringify([...body.moduleNames].sort()) !== JSON.stringify(modules)) {
    refuse('the extractor\'s module names differ from discovery');
  }
  for (const [file, digest] of Object.entries(producer)) {
    const source = { leanSha256: tools.lean, lakeSha256: tools.lake, extractorSha256: extractor, discoverySha256: discovery, harnessSha256: self }[file];
    if (source && sha256(fs.readFileSync(source)) !== digest) refuse(`${path.basename(source)} changed during the run`);
  }

  const record = { schema: 'fvs/lean-constants', version: 2, producer, inputs: { files, compiled, imports: before.summary }, nodes: body.nodes, referenced: body.referenced };
  const recordText = `${JSON.stringify(record, null, 1)}\n`;
  const shape = oracleShapeProblems(record);
  if (shape.length > 0) refuse(`the extractor output is not a usable record: ${shape.join('; ')}`);
  const run = {
    schema: 'fvs/lean-constants-run', version: 1, exitCode: 0, argv: oracleArgv, cwd: project,
    inventoryBefore: before.summary.digest, inventoryAfter: after.summary.digest, producer,
    outputSha256: sha256(recordText), outputBytes: Buffer.byteLength(recordText),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
  const runProblems = constantsRunProblems(run, recordText, record, project);
  if (runProblems.length > 0) refuse(`the run receipt would not be accepted: ${runProblems.join('; ')}`);
  // The analysed modules are the project's own: those under the given roots.
  // A compiled file of any other module (another library, stale build output)
  // would make the graph step reject the record, so it is named here instead.
  const analysed = modules.filter((module) => roots.includes(module.split('.')[0]));
  const bound = [...compiledProblems(compiled, analysed, project), ...importProblems(before.text, before.summary, compiled, analysed, record.referenced)];
  if (bound.length > 0) refuse(`the compiled modules or import manifest would not be accepted: ${bound.join('; ')}`);
  publish(path.join(out, 'imports.json'), before.text);
  publish(path.join(out, 'constants.json'), recordText);
  publish(path.join(out, 'constants-run.json'), `${JSON.stringify(run, null, 1)}\n`);
  return { out, nodes: record.nodes.length, imports: before.summary, toolchain: tools.name, warnings };
}

function parseFlags(argv) {
  const known = ['project', 'roots', 'out', 'lake'];
  const flags = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]?.replace(/^--/, '');
    if (!argv[index]?.startsWith('--') || !known.includes(name) || argv[index + 1] === undefined || Object.hasOwn(flags, name)) return null;
    flags[name] = argv[index + 1];
  }
  return flags;
}

function main(argv) {
  if (argv[0] !== 'run') { usage(); return argv[0] === '--help' || argv[0] === '-h' ? 0 : 2; }
  const flags = parseFlags(argv.slice(1));
  if (!flags) { usage(); return 2; }
  try {
    const result = produce({ project: flags.project, roots: flags.roots?.split(','), out: flags.out, lake: flags.lake });
    for (const warning of result.warnings) process.stderr.write(`warning: ${warning}\n`);
    process.stdout.write(`written: ${result.nodes} constants from ${result.imports.modules} modules (toolchain ${result.toolchain}) to ${result.out}\n`);
    return 0;
  } catch (error) {
    if (!(error instanceof Refusal) && error?.code === undefined) throw error;
    process.stderr.write(`refused: ${error.message}\n`);
    return 1;
  }
}

const isMain = (() => {
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) process.exitCode = main(process.argv.slice(2));
