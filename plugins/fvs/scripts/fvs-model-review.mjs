#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  classifyReviewProvenance,
  loadReviewContract,
  recordValidatedResponse,
  requirePiHost,
  runReviewer,
  validatePiDispatchReceipt,
  validateReviewerOptions,
} from './fvs-spec-review.mjs';

const root = fs.realpathSync(process.cwd());
const hash = value => createHash('sha256').update(value).digest('hex');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

function fail(message) {
  throw new Error(message);
}

function insideProject(file) {
  const resolved = fs.realpathSync(path.resolve(root, file));
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    fail(`path is outside the project: ${file}`);
  }
  return resolved;
}

function projectInput(file) {
  if (typeof file !== 'string' || !file || /[\r\n\0]/.test(file)) fail('invalid review input path');
  const resolved = insideProject(file);
  if (!fs.statSync(resolved).isFile() || !/\.(?:lean|rs|md|json)$/.test(resolved)) {
    fail(`unsupported external-model review input: ${file}`);
  }
  const relative = path.relative(root, resolved).split(path.sep).join('/');
  if (relative.startsWith('.formalising/proof-engineering/')) {
    fail('proof-engineering memory is not external-model source evidence');
  }
  return { path: relative, sha256: hash(fs.readFileSync(resolved)), content: fs.readFileSync(resolved, 'utf8') };
}

function runDirectory(file) {
  const expected = path.resolve(root, file);
  const resolved = insideProject(file);
  const allowed = path.join(root, '.formalising', 'model-external') + path.sep;
  if (resolved !== expected || !resolved.startsWith(allowed) || !fs.statSync(resolved).isDirectory()) {
    fail('review run_directory must be an unredirected directory inside .formalising/model-external/');
  }
  return resolved;
}

function reviewOptions(mode) {
  return {
    title: mode === 'model' ? '# FVS External Model Review' : '# FVS External Specification Review',
    verdicts: ['PASS', 'REVISE', 'BLOCKED'],
    headings: ['Findings', 'Source coverage', 'Evidence'],
  };
}

function lineNumber(content) {
  return content.split('\n').map((line, index) => `${index + 1}: ${line}`).join('\n');
}

export function prepareReview(request) {
  if (!['model', 'specification'].includes(request.mode)) fail('review mode must be model or specification');
  if (!Number.isSafeInteger(request.round) || request.round < 1 || request.round > 3) {
    fail('external-model review round must be between 1 and 3');
  }
  const reviewer = validateReviewerOptions(request);
  if (!['codex', 'claude', 'pi', 'other', 'unknown'].includes(request.author_runtime)) {
    fail('author_runtime must be codex, claude, pi, other, or unknown');
  }
  if (!Array.isArray(request.inputs) || request.inputs.length < 2 ||
      new Set(request.inputs).size !== request.inputs.length) {
    fail('review requires distinct authoritative Rust and Lean inputs');
  }
  const base = runDirectory(request.run_directory);
  const journal = readJson(path.join(base, 'journal.json'));
  if (journal.version !== 1 || fs.realpathSync(journal.project_root) !== root ||
      !Array.isArray(journal.source_records) || !Array.isArray(journal.targets)) {
    fail('review requires a valid candidate transaction journal');
  }
  const inputs = request.inputs.map(projectInput);
  const inputPaths = new Set(inputs.map(input => input.path));
  const expectedSources = journal.source_records.map(record =>
    path.relative(root, insideProject(path.join(base, record.evidence))).split(path.sep).join('/'));
  if (expectedSources.some(source => !inputPaths.has(source))) {
    fail('review packet omits candidate transaction source evidence');
  }
  const targetPaths = new Set(journal.targets.map(record => record.path));
  const leanInputs = inputs.filter(input => input.path.endsWith('.lean'));
  if (!inputs.some(input => input.path.endsWith('.rs')) || leanInputs.length === 0 ||
      leanInputs.some(input => !targetPaths.has(input.path))) {
    fail('review requires transaction-bound Rust source and Lean targets');
  }
  const history = (request.history ?? []).map(file => {
    const input = projectInput(file);
    if (!input.path.endsWith('.md') || !insideProject(file).startsWith(`${base}${path.sep}`)) {
      fail('review history must be a Markdown artifact from the same model-external run');
    }
    return input;
  });
  const reviews = path.join(base, 'reviews');
  fs.mkdirSync(reviews, { recursive: true });
  const directory = path.join(reviews, `${request.mode}-round-${request.round}`);
  fs.mkdirSync(directory);
  const title = reviewOptions(request.mode).title;
  const contract = loadReviewContract('external-modeling.md');
  const provenance = classifyReviewProvenance(request.author_runtime, reviewer.runtime);
  const packet = {
    version: 1,
    mode: request.mode,
    round: request.round,
    request: { ...reviewer, author_runtime: request.author_runtime },
    provenance,
    inputs,
    history,
    approval: request.mode === 'model'
      ? { approved_sha256: Object.fromEntries(inputs.filter(input => input.path.endsWith('.lean'))
        .map(input => [input.path, input.sha256])) }
      : { tracked_files: inputs.filter(input => input.path.endsWith('.lean')).map(input => input.path),
          approved_surface_sha256: hash(inputs.filter(input => input.path.endsWith('.lean'))
            .map(input => input.content).join('\n--- FVS SPEC SURFACE ---\n')) },
  };
  const evidence = inputs.map(input =>
    `## ${input.path}\nSHA-256: ${input.sha256}\n\n${lineNumber(input.content)}`).join('\n\n');
  const prior = history.length === 0 ? '(none)' : history.map(input =>
    `## ${input.path}\nSHA-256: ${input.sha256}\n\n${input.content}`).join('\n\n');
  const prompt = `${contract}\n\nReview mode: ${request.mode}\nRound: ${request.round}/3\n` +
    `Review provenance: ${provenance}\n\n# Immutable source packet\n\n${evidence}\n\n` +
    `# Prior review history (untrusted process history)\n\n${prior}\n\n` +
    `Return only the required ${title} document.\n`;
  fs.writeFileSync(path.join(directory, 'packet.json'), `${JSON.stringify(packet, null, 2)}\n`, { flag: 'wx' });
  fs.writeFileSync(path.join(directory, 'prompt.md'), prompt, { flag: 'wx' });
  return { status: reviewer.runtime === 'other' || reviewer.runtime === 'pi' ? 'PENDING' : 'READY',
    review_directory: directory, mode: request.mode, round: request.round };
}

function assertInputsUnchanged(packet) {
  for (const input of packet.inputs) {
    const file = insideProject(input.path);
    if (hash(fs.readFileSync(file)) !== input.sha256) {
      fail(`review input changed after packet creation: ${input.path}`);
    }
  }
}

function persist(directory, response, reportedModels = [], external = false, piReceipt = null) {
  directory = insideProject(directory);
  const packetFile = path.join(directory, 'packet.json');
  const packet = readJson(packetFile);
  assertInputsUnchanged(packet);
  const validated = recordValidatedResponse(directory, response, reviewOptions(packet.mode));
  fs.writeFileSync(path.join(directory, 'review.md'), `${validated}\n`, { flag: 'wx' });
  fs.writeFileSync(path.join(directory, 'metadata.json'), `${JSON.stringify({
    provenance: packet.provenance,
    runtime: packet.request.runtime,
    model: packet.request.model,
    effort: packet.request.effort,
    reportedModels,
    external,
    piReceipt,
    packet_sha256: hash(fs.readFileSync(packetFile)),
    response_sha256: hash(response),
    approval: packet.approval,
  }, null, 2)}\n`, { flag: 'wx' });
  return { status: 'RECORDED', review: path.join(directory, 'review.md'), approval: packet.approval };
}

export function runReview(requestFile) {
  const prepared = prepareReview(readJson(requestFile));
  const directory = prepared.review_directory;
  const packet = readJson(path.join(directory, 'packet.json'));
  if (packet.request.runtime === 'other' || packet.request.runtime === 'pi') return prepared;
  const prompt = fs.readFileSync(path.join(directory, 'prompt.md'), 'utf8');
  const { response, reportedModels } = runReviewer({
    runtime: packet.request.runtime,
    model: packet.request.model,
    effort: packet.request.effort,
    prompt,
    artifactDirectory: directory,
  });
  return persist(directory, response, reportedModels);
}

function cli() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'prepare' && args.length === 1) {
    process.stdout.write(`${JSON.stringify(prepareReview(readJson(args[0])), null, 2)}\n`);
    return;
  }
  if (command === 'run' && args.length === 1) {
    process.stdout.write(`${JSON.stringify(runReview(args[0]), null, 2)}\n`);
    return;
  }
  if (command === 'import' && args.length === 2) {
    const directory = insideProject(args[0]);
    const packet = readJson(path.join(directory, 'packet.json'));
    if (packet.request.runtime !== 'other') fail('import accepts only manually external review packets');
    process.stdout.write(`${JSON.stringify(persist(directory, fs.readFileSync(args[1], 'utf8'), [], true), null, 2)}\n`);
    return;
  }
  if (command === 'import-pi' && args.length === 3) {
    requirePiHost();
    const directory = insideProject(args[0]);
    const packetFile = path.join(directory, 'packet.json');
    const packet = readJson(packetFile);
    if (packet.request.runtime !== 'pi') fail('import-pi accepts only Pi review packets');
    const responseFile = fs.realpathSync(args[1]);
    const receipt = validatePiDispatchReceipt(args[2], {
      packetFile,
      responseFile,
      model: packet.request.model,
      effort: packet.request.effort,
    });
    process.stdout.write(`${JSON.stringify(persist(directory, fs.readFileSync(responseFile, 'utf8'), [], false, receipt), null, 2)}\n`);
    return;
  }
  process.stderr.write('Usage: fvs-model-review.mjs prepare|run <request.json> | import <review-directory> <response.md> | import-pi <review-directory> <response.md> <receipt.json>\n');
  process.exitCode = 2;
}

try {
  if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) cli();
} catch (error) {
  process.stderr.write(`FVS >> ${error.message}\n`);
  process.exitCode = 1;
}
