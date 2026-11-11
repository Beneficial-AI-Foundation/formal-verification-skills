// Inert derived recorded metadata, never a fresh witness or canonical proof.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const crypto = require('node:crypto'), zlib = require('node:zlib');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const V2 = path.resolve(__dirname, '../fixtures/auto-lean-graph/oracle-v2');
const RUST = path.resolve(__dirname, '../fixtures/auto-witness-rust');
const text = n => fs.readFileSync(path.join(V2, 'run', n), 'utf8');
async function fixture(t, { capped = false, live = false } = {}) {
  const graphAPI = await import('../../scripts/fvs-lean-graph.mjs');
  const { buildRecord } = await import('../../scripts/fvs-rust-identity.mjs');
  const { buildPlan } = await import('../../scripts/fvs-closure-plan.mjs');
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-witness-binding-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'project'), evidence = path.join(dir, 'evidence');
  fs.cpSync(path.join(V2, 'project'), root, { recursive: true }); fs.mkdirSync(evidence);
  const stateText = text('state.json'), statePath = path.join(root, '.formalising/auto-fv/state.json');
  if (live) { fs.mkdirSync(path.dirname(statePath), { recursive: true }); fs.writeFileSync(statePath, stateText); }
  const receipt = JSON.parse(text('receipt.json')), constants = JSON.parse(text('constants.json'));
  receipt.projectRoot = root; receipt.inputs.files = graphAPI.projectInputs(root);
  constants.inputs.files = { ...receipt.inputs.files };
  const run = JSON.parse(text('constants-run.json')); run.cwd = root;
  if (capped) {
    const bin = path.join(evidence, 'bin'); fs.mkdirSync(bin);
    const lake = path.join(bin, 'lake'), extractor = path.join(evidence, 'LeanConstantsV3.lean');
    fs.writeFileSync(lake, 'Inert Lake identity; must never execute.');
    fs.writeFileSync(extractor, '-- Inert extractor identity; must never elaborate.\n');
    constants.producer.lakeSha256 = sha(fs.readFileSync(lake));
    constants.producer.extractorSha256 = sha(fs.readFileSync(extractor));
    run.producer = { ...constants.producer };
    receipt.lakeBuild.argv = [lake, '--no-cache', '--rehash', '--verbose', 'build', ...receipt.libraries];
    run.argv = [lake, 'env', 'lean', '--threads=2', extractor];
  }
  const data = {
    extractText: text('lean.json'), logText: text('probe.log'), receiptText: JSON.stringify(receipt),
    libraries: ['M1demo', 'Specs'], projectRoot: root, manifestText: text('attempt-manifest.json'),
    constantsText: JSON.stringify(constants), constantsRunText: '',
    importsText: zlib.gunzipSync(fs.readFileSync(path.join(V2, 'run/imports.json.gz'))).toString('utf8'),
    extractionStateText: live ? null : stateText,
  };
  function sign() {
    run.outputSha256 = sha(data.constantsText); run.outputBytes = Buffer.byteLength(data.constantsText);
    data.constantsRunText = JSON.stringify(run); data.receiptText = JSON.stringify(receipt);
  }
  sign();
  const write = (name, bytes) => { const file = path.join(evidence, name); fs.writeFileSync(file, bytes); return { file, sha256: sha(bytes) }; };
  const json = (name, value) => write(name, JSON.stringify(value));
  const wrapped = r => ({ bytes: fs.readFileSync(r.file), json: JSON.parse(fs.readFileSync(r.file)), sha256: r.sha256 });
  function assemble(editGraph = () => {}) {
    sign();
    const refs = Object.fromEntries(Object.entries({ extract: data.extractText, log: data.logText,
      receipt: data.receiptText, manifest: data.manifestText, constants: data.constantsText,
      constantsRun: data.constantsRunText, imports: data.importsText }).map(([n, b]) => [n, write(n + '.json', b)]));
    const state = write('historical-state.json', stateText);
    const rust = {
      sourceCommit: JSON.parse(data.manifestText).source.commit,
      translation: write('translation.json', fs.readFileSync(path.join(root, 'M1demo/translation.json'))),
      manifest: refs.manifest, lean: refs.extract, leanReceipt: refs.receipt, state,
      rust: write('rust.json', fs.readFileSync(path.join(RUST, 'rust.json'))),
      mappings: write('mappings.json', fs.readFileSync(path.join(RUST, 'translations.json'))),
      functions: write('functions.json', fs.readFileSync(path.join(RUST, 'functions.json'))),
      llbc: write('m1demo.llbc', zlib.gunzipSync(fs.readFileSync(path.join(RUST, 'm1demo.llbc.gz')))),
    };
    const identity = json('identity.json', buildRecord(Object.fromEntries(Object.entries(rust).map(([k, r]) => [k, k === 'sourceCommit' ? r : wrapped(r)]))));
    const record = graphAPI.buildLeanGraph(data); editGraph(record);
    const graph = json('graph.json', record);
    const plan = json('plan.json', buildPlan({ identity: wrapped(identity), graph: wrapped(graph), roots: [20, 21], failed: [], llbc: wrapped(rust.llbc) }));
    return { identity, graph, plan, rust, lean: { projectRoot: root, libraries: data.libraries, ...refs } };
  }
  return { dir, root, evidence, stateText, statePath, data, run, receipt, constants, sign, assemble, graphAPI, write, json };
}
module.exports = { fixture, sha };
