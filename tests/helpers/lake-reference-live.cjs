#!/usr/bin/env node
'use strict';
// Read-only proposed-input preflight, never a compiler or resource-control runner.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const fail = reason => ({status:'BLOCKED', operations:0, reason});
function inspectFile(row) {
  if (!row || !path.isAbsolute(row.path ?? '') || !/^[a-f0-9]{64}$/.test(row.sha256 ?? '')) throw Error('missing canonical path/digest');
  for (let p=row.path;;p=path.dirname(p)) {
    if (fs.lstatSync(p).isSymbolicLink()) throw Error('symlink input or ancestor');
    if (path.dirname(p)===p) break;
  }
  const stat=fs.lstatSync(row.path);
  if(!stat.isFile() || stat.size!==row.bytes || stat.size>1048576*128) throw Error('invalid regular input size');
  if(fs.realpathSync(row.path)!==row.path) throw Error('noncanonical input');
  const sha=crypto.createHash('sha256').update(fs.readFileSync(row.path)).digest('hex');
  if(sha!==row.sha256) throw Error('input digest mismatch');
}
function preflight(q) {
  try {
    if(!q || typeof q!=='object') return fail('missing explicit qualification');
    if(!q.operation || typeof q.operation!=='string' || !q.permissionEvidence) return fail('missing exact-operation consent provenance');
    inspectFile(q.permissionEvidence);
    for(const name of ['lean','lake','nativeCompiler','linker']) {
      if(!q.tools?.[name]?.version || !q.tools[name].origin) return fail(`missing explicit ${name} identity/version/origin`);
      inspectFile(q.tools[name]);
    }
    if(!Array.isArray(q.dynamicLibraries) || !q.dynamicLibraries.length) return fail('missing downstream executable/dylib closure');
    for(const row of q.dynamicLibraries) inspectFile(row);
    if(!q.source?.toolchain || !q.source?.manifest || !q.source?.configuration) return fail('missing pinned source/input identities');
    for(const row of Object.values(q.source)) inspectFile(row);
    if(!q.root || !path.isAbsolute(q.root) || fs.realpathSync(q.root)!==q.root || !fs.lstatSync(q.root).isDirectory()) return fail('invalid owned writable root');
    for(let p=q.root;;p=path.dirname(p)) {
      if(fs.lstatSync(p).isSymbolicLink()) return fail('symlink root ancestor');
      if(path.dirname(p)===p) break;
    }
    if(fs.statSync(q.root).uid!==process.getuid()) return fail('root ownership mismatch');
    for(const name of ['HOME','TMPDIR','toolHome','cacheHome']) {
      const p=q.environment?.[name];
      if(!p || !p.startsWith(q.root+path.sep) || fs.realpathSync(p)!==p || !fs.lstatSync(p).isDirectory()) return fail(`unverified owned ${name}`);
    }
    for(const name of ['osConfinement','oneCompiler','twoThreads','nice19AllDescendants','cacheControls','lifecycle']) {
      if(!q.evidence?.[name]?.source || !q.evidence[name].operation) return fail(`missing source-grounded ${name} evidence`);
      if(q.evidence[name].operation!==q.operation) return fail(`wrong-operation ${name} evidence`);
      inspectFile(q.evidence[name]);
    }
    // Physical bytes and asserted provenance are inputs, not permission or enforcement proof.
    return fail('unsupported real whole-chain control: no independently qualified execution surface; proposed/synthetic metadata never authorizes loading');
  } catch(e) { return fail(`invalid/unverifiable proposed input: ${e.message}`); }
}
function readQualification(file) {
  if(!file || !path.isAbsolute(file)) return fail('missing absolute --qualification input');
  try {
    const s=fs.lstatSync(file);
    if(!s.isFile() || s.isSymbolicLink() || s.size>1048576 || fs.realpathSync(file)!==file) return fail('unsafe qualification file');
    return preflight(JSON.parse(fs.readFileSync(file,'utf8')));
  } catch(e) { return fail(`unreadable/invalid qualification: ${e.message}`); }
}
if(require.main===module) {
  const at=process.argv.indexOf('--qualification');
  const result=readQualification(at>=0?process.argv[at+1]:undefined);
  console.error(JSON.stringify(result));
  process.exitCode=2;
}
module.exports={preflight,readQualification};
