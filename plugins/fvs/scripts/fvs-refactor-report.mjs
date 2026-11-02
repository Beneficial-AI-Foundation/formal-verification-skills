#!/usr/bin/env node
// Bounded source metrics and printed Lean views, not a Lean parser or proof checker.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const lines = text => text === '' ? 0 : text.split(/\r?\n/).length - (text.endsWith('\n') ? 1 : 0);
class MetricUnavailable extends Error {}
class BoundaryCoverageGap extends Error {}

export function scanLean(source) {
  const code = new Set(); const comments = []; const tokens = [];
  let i = 0; let line = 1;
  const consume = (end, isCode) => {
    const text = source.slice(i, end);
    for (const part of text.split('\n')) {
      if (isCode && part.trim()) code.add(line);
      line += 1;
    }
    line -= 1; i = end;
    return text;
  };
  while (i < source.length) {
    const c = source[i];
    if (/\s/u.test(c)) { consume(i + 1, false); continue; }
    if (source.startsWith('--', i)) {
      const end = source.indexOf('\n', i);
      comments.push(consume(end < 0 ? source.length : end, false)); continue;
    }
    if (source.startsWith('/-', i)) {
      let end = i + 2; let depth = 1;
      while (end < source.length && depth) {
        if (source.startsWith('/-', end)) { depth++; end += 2; }
        else if (source.startsWith('-/', end)) { depth--; end += 2; }
        else end++;
      }
      if (depth) throw new Error('Unterminated Lean block comment');
      comments.push(consume(end, false)); continue;
    }
    const raw = source.slice(i).match(/^r(#+)?"/);
    if ((raw || c === '"') && tokens.at(-1) === '!') {
      throw new MetricUnavailable('Interpolated strings require a validated counter');
    }
    if (raw) {
      const close = '"' + (raw[1] || '');
      const end = source.indexOf(close, i + raw[0].length);
      if (end < 0) throw new Error('Unterminated Lean raw string');
      tokens.push(consume(end + close.length, true)); continue;
    }
    if (c === '"') {
      // Interpolation needs the consumer's parser. Keep the source, not a guessed count.
      let end = i + 1;
      for (; end < source.length; end++) {
        if (source[end] === '\\') end++;
        else if (source[end] === '"') break;
      }
      if (end >= source.length) throw new Error('Unterminated Lean string');
      tokens.push(consume(end + 1, true)); continue;
    }
    if (c === '«') {
      const end = source.indexOf('»', i + 1);
      if (end < 0) throw new Error('Unterminated quoted Lean identifier');
      tokens.push(consume(end + 1, true)); continue;
    }
    const char = c === "'" && source.slice(i).match(/^'(?:\\(?:u\{[0-9a-fA-F]+\}|.|\n)|[^'\\\n])'/u);
    if (char) { tokens.push(consume(i + char[0].length, true)); continue; }
    if (source.startsWith('<;>', i)) { tokens.push(consume(i + 3, true)); continue; }
    const word = source.slice(i).match(/^[\p{L}\p{N}_][\p{L}\p{N}_']*/u);
    if (word) { tokens.push(consume(i + word[0].length, true)); continue; }
    tokens.push(consume(i + 1, true));
  }
  return { rawLines: lines(source), codeLines: code.size, comments, tokens,
    sequenceHints: tokens.filter(t => t === ';' || t === '<;>').length };
}

function inventory(root, names) {
  root = fs.realpathSync(root);
  if (!Array.isArray(names) || !names.length || names.some(n => typeof n !== 'string')) {
    throw new Error('A nonempty approved source-file list is required');
  }
  const files = Object.create(null);
  for (const name of [...new Set(names)].sort()) {
    if (path.isAbsolute(name) || name.split(/[\\/]/).some(p => !p || p === '..' || p === '.' || p === '.git' || p === '.lake')) {
      throw new Error(`Unsupported source path: ${name}`);
    }
    const file = path.join(root, name);
    let stat;
    try { stat = fs.lstatSync(file); }
    catch (error) { if (error.code === 'ENOENT') { files[name] = null; continue; } throw error; }
    if (stat.isSymbolicLink() || !stat.isFile() || fs.realpathSync(file) !== file) throw new Error(`Redirected source: ${name}`);
    const source = fs.readFileSync(file, 'utf8');
    let measured = null; let metricUnavailable = null;
    if (name.endsWith('.lean')) {
      try { measured = scanLean(source); }
      catch (error) { if (!(error instanceof MetricUnavailable)) throw error; metricUnavailable = error.message; }
    }
    files[name] = { sha256: hash(source), source, lean: measured, metricUnavailable,
      ancillaryLines: name.endsWith('.lean') ? 0 : source.split(/\r?\n/).filter(s => s.trim()).length };
  }
  return { schema: 'fvs-refactor/source-view', root, files };
}

export const captureScope = (root, names) => inventory(root, names);

export function compareScopes(before, after) {
  if (before.schema !== 'fvs-refactor/source-view' || after.schema !== before.schema || before.root !== after.root) {
    throw new Error('Mismatched source views');
  }
  const rows = []; const oldTokens = []; const newTokens = []; const unavailableFiles = [];
  for (const name of Object.keys(before.files)) {
    if (!Object.prototype.hasOwnProperty.call(after.files, name)) throw new Error(`Missing final observation: ${name}`);
  }
  const removed = (a, b) => {
    const counts = new Map();
    for (const value of b) counts.set(value, (counts.get(value) || 0) + 1);
    return a.filter(value => {
      if (!counts.get(value)) return true;
      counts.set(value, counts.get(value) - 1); return false;
    });
  };
  let codeDelta = 0; let creditedCodeDelta = 0; let ancillaryCost = 0;
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const withoutSeq = a => a.filter(t => t !== ';' && t !== '<;>');
  for (const name of [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].sort()) {
    const a = before.files[name]; const b = after.files[name];
    if (a?.metricUnavailable || b?.metricUnavailable) {
      const reason = a?.metricUnavailable || b?.metricUnavailable;
      unavailableFiles.push({ file: name, reason });
      rows.push({ file: name, metricStatus: 'unavailable', reason,
        beforeCodeLines: a ? a.lean?.codeLines ?? null : 0, afterCodeLines: b ? b.lean?.codeLines ?? null : 0,
        beforeRawLines: a ? lines(a.source) : 0, afterRawLines: b ? lines(b.source) : 0,
        formattingOnly: null, packingOnly: null, sequenceHintDelta: null,
        removedComments: null, addedComments: null, ancillaryDelta: 0 });
      continue;
    }
    if (a?.lean) oldTokens.push(...a.lean.tokens);
    if (b?.lean) newTokens.push(...b.lean.tokens);
    const oldCode = a?.lean?.codeLines || 0; const newCode = b?.lean?.codeLines || 0;
    const formattingOnly = same(a?.lean?.tokens || [], b?.lean?.tokens || []);
    const packingOnly = !formattingOnly && same(withoutSeq(a?.lean?.tokens || []), withoutSeq(b?.lean?.tokens || []));
    const delta = newCode - oldCode;
    const ancillaryDelta = (b?.ancillaryLines || 0) - (a?.ancillaryLines || 0);
    codeDelta += delta;
    creditedCodeDelta += delta < 0 && (formattingOnly || packingOnly) ? 0 : delta;
    // Unknown ancillary languages earn no automatic credit for deletions (which may be prose).
    ancillaryCost += Math.max(0, ancillaryDelta);
    rows.push({ file: name, metricStatus: 'available', beforeCodeLines: oldCode, afterCodeLines: newCode,
      beforeRawLines: a?.lean?.rawLines || 0, afterRawLines: b?.lean?.rawLines || 0, formattingOnly, packingOnly,
      ancillaryDelta, sequenceHintDelta: (b?.lean?.sequenceHints || 0) - (a?.lean?.sequenceHints || 0),
      removedComments: removed(a?.lean?.comments || [], b?.lean?.comments || []),
      addedComments: removed(b?.lean?.comments || [], a?.lean?.comments || []) });
  }
  const available = unavailableFiles.length === 0;
  const formattingOnly = available ? same(oldTokens, newTokens) : null;
  const packingOnly = available ? !formattingOnly && same(withoutSeq(oldTokens), withoutSeq(newTokens)) : null;
  const mixedPackingFiles = rows.filter(r => r.sequenceHintDelta > 0 && r.afterCodeLines < r.beforeCodeLines)
    .map(r => ({ file: r.file, reasonRequired: true, sequenceHintDelta: r.sequenceHintDelta,
      codeDelta: r.afterCodeLines - r.beforeCodeLines }));
  return { schema: 'fvs-refactor/metric-comparison', metricStatus: available ? 'available' : 'unavailable',
    rows, unavailableFiles, mixedPackingFiles, codeDelta: available ? codeDelta : null,
    creditedCodeDelta: available ? creditedCodeDelta : null, ancillaryCost,
    measuredNetCodeDelta: available ? codeDelta + ancillaryCost : null,
    candidateNetCodeDelta: available ? creditedCodeDelta + ancillaryCost : null, formattingOnly, packingOnly,
    metricWin: available ? creditedCodeDelta + ancillaryCost < 0 && !formattingOnly && !packingOnly : null,
    limits: 'Lexical data supports reviewed net reduction and readability judgment, never scoring or acceptance. metricWin is only a legacy candidate field. Unsupported counts/hints are unavailable: continue with a clearly reviewed full-scope comparison, not guessed totals. Review mixed packing and prose changes. Ancillary deletions need a reviewed counter to earn credit.' };
}

export function contextHashes(root, names) {
  if (!Array.isArray(names) || !names.length) throw new Error('Expected context input list');
  root = fs.realpathSync(root);
  const inputs = Object.create(null);
  for (const name of [...new Set(names)].sort()) {
    if (typeof name !== 'string' || path.isAbsolute(name) || name.split(/[\\/]/).some(p => !p || p === '..' || p === '.')) throw new Error('Unsupported context path');
    const file = path.join(root, name);
    let stat;
    try { stat = fs.lstatSync(file); }
    catch (error) { if (error.code === 'ENOENT') { inputs[name] = null; continue; } throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(file) !== file) throw new Error('Redirected context');
    inputs[name] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  }
  return { schema: 'fvs-refactor/context-inputs', root, inputs };
}

// Interpret an existing Elan no-network state dump; never execute/install a toolchain.
export function projectToolchainContext(root, state) {
  root = fs.realpathSync(root);
  const pinPath = path.join(root, 'lean-toolchain');
  const pin = fs.readFileSync(pinPath, 'utf8');
  if (!pin.trim()) throw new Error('Empty project toolchain pin');
  const tc = state?.toolchains; const active = tc?.active_override;
  if (!active?.reason) throw new Error('No project toolchain override resolved; refusing global default');
  const selected = tc.resolved_active?.live?.Ok || tc.resolved_active?.cached;
  if (typeof selected !== 'string' || !selected) throw new Error('Project toolchain cannot be resolved offline');
  const matches = Array.isArray(tc.installed) ? tc.installed.filter(t => t.resolved_name === selected) : [];
  if (matches.length !== 1 || typeof matches[0].path !== 'string' || !path.isAbsolute(matches[0].path)) {
    throw new Error('Exact effective toolchain is not uniquely installed; do not download or substitute');
  }
  const reason = active.reason;
  if (reason !== 'Environment') {
    const keys = reason && typeof reason === 'object' ? Object.keys(reason) : [];
    if (keys.length !== 1 || !['ToolchainFile', 'OverrideDB', 'LeanpkgFile', 'InToolchainDirectory'].includes(keys[0])) {
      throw new Error('Unsupported toolchain override metadata; inspect project setup explicitly');
    }
    const key = keys[0]; const namedPath = reason[key];
    if (typeof namedPath !== 'string' || !path.isAbsolute(namedPath)) throw new Error('Invalid override origin');
    if (key === 'ToolchainFile' && fs.realpathSync(namedPath) !== fs.realpathSync(pinPath)) {
      throw new Error('Toolchain state does not describe this project pin');
    }
    const origin = fs.realpathSync(key.endsWith('File') ? path.dirname(namedPath) : namedPath);
    const relative = path.relative(origin, root);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
      throw new Error('Toolchain state belongs to another project context');
    }
  }
  const installedRoot = fs.realpathSync(matches[0].path);
  const executable = name => {
    const file = fs.realpathSync(path.join(installedRoot, 'bin', name));
    if (path.dirname(file) !== path.join(installedRoot, 'bin') || !fs.statSync(file).isFile()) {
      throw new Error('Toolchain executable redirects outside its installed bin; validate setup explicitly');
    }
    fs.accessSync(file, fs.constants.X_OK);
    return { path: file, sha256: hash(fs.readFileSync(file)) };
  };
  return { schema: 'fvs-refactor/project-toolchain', root,
    pin: { path: pinPath, value: pin.trim(), sha256: hash(pin) },
    effectiveToolchain: selected, overrideReason: reason, unresolved: active.unresolved,
    resolution: tc.resolved_active.live?.Ok ? 'offline-resolved' : 'cached-offline',
    elanVersion: state.elan_version?.current, lean: executable('lean'), lake: executable('lake'),
    environmentOverrides: Object.fromEntries(['ELAN_TOOLCHAIN', 'ELAN_HOME', 'LEAN', 'LEAN_SYSROOT', 'LEAN_PATH',
      'LEAN_SRC_PATH', 'LAKE_CONFIG', 'LAKE_HOME', 'LAKE_OVERRIDE_LEAN'].filter(k => process.env[k] !== undefined)
      .map(k => [k, process.env[k]])),
    limits: 'Selection/identity only, not capability or dependency validation. Record actual versions/configuration and validate commands on this context before use. Never install or guess a replacement.' };
}

export function lakeCompilerIdentity(context, selected) {
  if (context?.schema !== 'fvs-refactor/project-toolchain' || !context.lean?.path || !context.lean?.sha256) {
    throw new Error('Resolved project context required for Lake compiler comparison');
  }
  selected = selected.trim();
  if (!path.isAbsolute(selected)) throw new Error('Lake compiler selection unavailable; validate this pin explicitly, never infer from PATH');
  const file = fs.realpathSync(selected); const sha256 = hash(fs.readFileSync(file));
  if (file !== context.lean.path || sha256 !== context.lean.sha256) {
    throw new Error('Lake-selected compiler differs from resolved project context; resolve the explicit override before continuing');
  }
  return { schema: 'fvs-refactor/lake-compiler', path: file, sha256 };
}

export function normaliseBoundaryMessages(query, raw, expected, definitionSlots = []) {
  if (!Number.isSafeInteger(expected) || expected < 1) throw new Error('Expected query coverage must be positive');
  if (!Array.isArray(definitionSlots) || new Set(definitionSlots).size !== definitionSlots.length ||
      definitionSlots.some(i => !Number.isSafeInteger(i) || i < 0 || i >= expected)) {
    throw new Error('Invalid protected-definition observation coverage');
  }
  const queryTokens = scanLean(query).tokens;
  if (queryTokens.some((t, i) => t === '#' && queryTokens[i + 1] === 'print' && queryTokens[i + 2] === 'sig')) {
    throw new Error('Signature-only queries cannot cover protected definition bodies');
  }
  const data = [];
  for (const line of raw.split(/\r?\n/).filter(s => s.trim())) {
    const message = JSON.parse(line);
    if (message.severity !== 'information' || typeof message.data !== 'string' || !message.data.trim()) {
      throw new Error('Boundary output contains diagnostics or unsupported messages');
    }
    data.push(message.data);
  }
  if (data.length !== expected) throw new Error('Missing or extra boundary observations');
  // Validate all diagnostics/coverage before reporting a tool limitation.
  const headers = data.map(value => value.replace(/^(?:@\[[^\]]*\]\s*)+/, '')
    .replace(/^(?:(?:unsafe|partial|private|protected|meta|noncomputable)\s+)*/, ''));
  if (headers.some(header => /^theorem\s/.test(header))) {
    throw new Error('Theorems use #check and #print axioms only; never print their proof');
  }
  for (const [index, header] of headers.entries()) {
    if (definitionSlots.includes(index) &&
        (!/^(?:def|abbrev)\s/.test(header) || !/:=\s*\S/.test(header))) {
      throw new BoundaryCoverageGap('Protected definition requires a fully rendered := body; signature-only coverage refused');
    }
  }
  if (data.some(value => value.includes('⋯') || value.includes('<not imported>'))) {
    throw new BoundaryCoverageGap('Elided or unavailable boundary value; coverage is unverified');
  }
  return { schema: 'fvs-refactor/printed-view', coverage: 'available', querySha256: hash(query), definitionSlots, data,
    limits: 'Printed syntax comparison only; not kernel identity, complete semantic closure or proof acceptance.' };
}

export function captureBoundaryView(query, raw, expected, definitionSlots = []) {
  try { return normaliseBoundaryMessages(query, raw, expected, definitionSlots); }
  catch (error) {
    if (!(error instanceof BoundaryCoverageGap)) throw error;
    return { schema: 'fvs-refactor/printed-view-gap', coverage: 'review-required',
      querySha256: hash(query), rawSha256: hash(raw), expected, definitionSlots, reason: error.message,
      limits: 'No protected-body comparison or semantic equivalence established. Route the exact gap to an explicit review/checkable comparison; compilation and axiom checks remain required. Matching gap reports are not boundary evidence.' };
  }
}

export function writeExclusive(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
}

function main(args) {
  if (args[0] === 'capture' && args.length === 4) {
    writeExclusive(args[3], captureScope(args[1], JSON.parse(fs.readFileSync(args[2], 'utf8'))));
  } else if (args[0] === 'compare' && args.length === 5) {
    const before = JSON.parse(fs.readFileSync(args[1], 'utf8'));
    const names = JSON.parse(fs.readFileSync(args[3], 'utf8'));
    if (!Array.isArray(names)) throw new Error('Expected final source-file list');
    writeExclusive(args[4], compareScopes(before, captureScope(args[2], [...Object.keys(before.files), ...names])));
  } else if (args[0] === 'messages' && args.length === 6) {
    writeExclusive(args[5], captureBoundaryView(fs.readFileSync(args[1], 'utf8'),
      fs.readFileSync(args[2], 'utf8'), Number(args[3]), JSON.parse(fs.readFileSync(args[4], 'utf8'))));
  } else if (args[0] === 'hashes' && args.length === 4) {
    writeExclusive(args[3], contextHashes(args[1], JSON.parse(fs.readFileSync(args[2], 'utf8'))));
  } else if (args[0] === 'toolchain' && args.length === 4) {
    writeExclusive(args[3], projectToolchainContext(args[1], JSON.parse(fs.readFileSync(args[2], 'utf8'))));
  } else if (args[0] === 'lake-compiler' && args.length === 4) {
    writeExclusive(args[3], lakeCompilerIdentity(JSON.parse(fs.readFileSync(args[1], 'utf8')), fs.readFileSync(args[2], 'utf8')));
  } else throw new Error('Usage: capture ROOT FILES_JSON OUT | compare BASELINE ROOT FILES_JSON OUT | messages QUERY RAW EXPECTED_COUNT DEFINITION_SLOTS_JSON OUT | hashes ROOT FILES_JSON OUT | toolchain ROOT ELAN_STATE_JSON OUT | lake-compiler CONTEXT_JSON SELECTED_PATH OUT');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(`FVS refactor report: ${error.message}`); process.exitCode = 1; }
}
