'use strict';
const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const tool = import(pathToFileURL(path.join(__dirname, '../scripts/fvs-refactor-report.mjs')));
const dir = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-refactor-report-')));
const TEST_PIN=process.env.FVS_REFACTOR_TEST_PIN || 'leanprover/lean4:v4.31.0';
const TEST_VERSION=TEST_PIN.split(':').at(-1).replace(/^v/,'');
const printedGuard=()=>fs.readFileSync(path.join(__dirname,'../fv-skills/references/lean-refactoring.md'),'utf8')
  .match(/# A previously covered boundary must remain covered\.\n[\s\S]*?\nfi/)[0];
function guardFixture(){
  const root=dir();for(const name of ['baseline','final']){
    fs.mkdirSync(path.join(root,name));fs.writeFileSync(path.join(root,name,'inspection-status.txt'),'0\n');
  }
  return {root,write:(name,value)=>fs.writeFileSync(path.join(root,name,'view.json'),JSON.stringify(value)),
    check:()=>spawnSync('/bin/bash',['-c',printedGuard()],{cwd:root,encoding:'utf8',env:{...process.env,BASELINE_DIR:path.join(root,'baseline'),FINAL_DIR:path.join(root,'final')}})};
}

it('ignores nested comments and sequence text inside strings, chars and quoted identifiers', async () => {
  const { scanLean } = await tool;
  const s = scanLean('/- outer /- ; <;> -/ end -/\n-- ;\ndef x := "; <;> --"\ndef y := r#"/- ; -/"#\ndef c := \';\'\ndef «semi;» := 1\nexample := by first; second\n');
  assert.equal(s.codeLines, 5);
  assert.equal(s.sequenceHints, 1);
  assert.equal(s.comments.length, 2);
  assert.throws(() => scanLean('def x := s!"{x}"'), /validated counter/);
  assert.throws(() => scanLean('def x := s! "{("inner; --")}"'), /validated counter/);
  assert.throws(() => scanLean('/- unclosed'), /Unterminated/);
});

it('comment deletion and physical formatting do not create a metric win', async () => {
  const { captureScope, compareScopes } = await tool; const root = dir();
  fs.writeFileSync(path.join(root, 'A.lean'), '-- useful explanation\nexample (p : Prop) (h : p) : p := by\n  exact h\n');
  const a = captureScope(root, ['A.lean']);
  fs.writeFileSync(path.join(root, 'A.lean'), 'example (p : Prop) (h : p) : p := by exact h\n');
  const r = compareScopes(a, captureScope(root, ['A.lean']));
  assert.equal(r.codeDelta, -1); assert.equal(r.creditedCodeDelta, 0); assert.equal(r.metricWin, false);
  assert.equal(r.rows[0].removedComments.length, 1);
});

it('semicolon packing earns no credit while changed idiomatic reasoning is not vetoed by a count', async () => {
  const { captureScope, compareScopes } = await tool; const root = dir();const file=path.join(root,'A.lean');
  fs.writeFileSync(file, "example (p : Prop) (h : p) : p := by\n  have h' : p := h\n  exact h'\n");
  const a=captureScope(root,['A.lean']);
  fs.writeFileSync(file,"example (p : Prop) (h : p) : p := by\n  have h' : p := h; exact h'\n");
  const packed=compareScopes(a,captureScope(root,['A.lean']));assert.equal(packed.packingOnly,true);assert.equal(packed.metricWin,false);
  fs.writeFileSync(file,'example (p q : Prop) (hp : p) (hq : q) : p ∧ q := by\n  constructor\n  · exact hp\n  · exact hq\n');
  const b=captureScope(root,['A.lean']);
  fs.writeFileSync(file,'example (p q : Prop) (hp : p) (hq : q) : p ∧ q := by\n  constructor <;> assumption\n');
  const idiomatic=compareScopes(b,captureScope(root,['A.lean']));assert.equal(idiomatic.rows[0].sequenceHintDelta,1);assert.equal(idiomatic.metricWin,true);
  assert.deepEqual(idiomatic.mixedPackingFiles.map(r=>r.file),['A.lean']);assert.equal(idiomatic.mixedPackingFiles[0].reasonRequired,true);
});

it('counts new helper cost and gives no cross-file credit for formatting-only savings', async () => {
  const { captureScope, compareScopes }=await tool;const root=dir();
  fs.writeFileSync(path.join(root,'A.lean'),'example : True := by\n  trivial\n');
  const a=captureScope(root,['A.lean','Helper.lean']);
  fs.writeFileSync(path.join(root,'A.lean'),'example : True := by trivial\n');
  fs.writeFileSync(path.join(root,'Helper.lean'),'theorem helper : True := by\n  trivial\n');
  const r=compareScopes(a,captureScope(root,['A.lean','Helper.lean']));
  assert.equal(r.rows.find(x=>x.file==='Helper.lean').afterCodeLines,2);assert.equal(r.candidateNetCodeDelta,2);assert.equal(r.metricWin,false);
  assert.throws(()=>compareScopes(a,captureScope(root,['Helper.lean'])),/Missing final/);
});

it('keeps unsupported interpolation snapshots but never presents partial counts as a scope total', async () => {
  const {captureScope,compareScopes}=await tool;const root=dir();
  fs.writeFileSync(path.join(root,'A.lean'),'example : True := by\n  trivial\n');
  fs.writeFileSync(path.join(root,'B.lean'),'def text := s!"{("inner; --")}"\n');
  const before=captureScope(root,['A.lean','B.lean','Helper.lean']);
  assert.equal(before.files['B.lean'].lean,null);assert.equal(before.files['B.lean'].ancillaryLines,0);
  assert.match(before.files['B.lean'].metricUnavailable,/Interpolated/);assert.equal(before.files['B.lean'].sha256.length,64);
  fs.writeFileSync(path.join(root,'A.lean'),'example : True := by trivial\n');
  fs.writeFileSync(path.join(root,'Helper.lean'),'theorem helper : True := by trivial\n');
  const r=compareScopes(before,captureScope(root,['A.lean','B.lean','Helper.lean']));
  assert.equal(r.metricStatus,'unavailable');assert.deepEqual(r.unavailableFiles.map(x=>x.file),['B.lean']);
  for(const key of ['codeDelta','creditedCodeDelta','measuredNetCodeDelta','candidateNetCodeDelta','metricWin','formattingOnly','packingOnly'])assert.equal(r[key],null,key);
  const row=r.rows.find(x=>x.file==='B.lean');assert.equal(row.beforeCodeLines,null);assert.equal(row.sequenceHintDelta,null);assert.equal(row.removedComments,null);
  assert.equal(r.rows.find(x=>x.file==='Helper.lean').afterCodeLines,1,'known helper cost remains visible');
  fs.unlinkSync(path.join(root,'B.lean'));
  assert.equal(compareScopes(before,captureScope(root,['A.lean','B.lean','Helper.lean'])).metricStatus,'unavailable','removing an uncounted file does not invent savings');
  fs.writeFileSync(path.join(root,'Broken.lean'),'/- unclosed');assert.throws(()=>captureScope(root,['Broken.lean']),/Unterminated/);
});

it('keeps repeated deleted explanations visible and refuses source redirection', async () => {
  const { captureScope, compareScopes, writeExclusive }=await tool;const root=dir();const file=path.join(root,'A.lean');
  fs.writeFileSync(file,'-- explanation\n-- explanation\nexample : True := by trivial\n');const a=captureScope(root,['A.lean']);
  fs.writeFileSync(file,'-- explanation\nexample : True := by trivial\n');const r=compareScopes(a,captureScope(root,['A.lean']));assert.equal(r.rows[0].removedComments.length,1);assert.equal(r.metricWin,false);
  assert.throws(()=>captureScope(root,['../escape.lean']),/Unsupported/);
  fs.symlinkSync(file,path.join(root,'B.lean'));assert.throws(()=>captureScope(root,['B.lean']),/Redirected/);
  fs.symlinkSync(path.join(root,'missing.lean'),path.join(root,'C.lean'));assert.throws(()=>captureScope(root,['C.lean']),/Redirected/);
  writeExclusive(path.join(root,'snapshot.json'),a);assert.throws(()=>writeExclusive(path.join(root,'snapshot.json'),r),/EEXIST/);
});

const oldSplit = name => `theorem ${name} (n : Nat) : n = 0 ∨ 0 < n := by\n  cases n with\n  | zero =>\n    left\n    rfl\n  | succ k =>\n    right\n    exact Nat.zero_lt_succ k\n`;
const shared = '/-- Classifies a natural number as zero or positive. -/\nprivate theorem splitHelper (n : Nat) : n = 0 ∨ 0 < n := by\n  cases n with\n  | zero =>\n    exact Or.inl rfl\n  | succ k =>\n    exact Or.inr (Nat.zero_lt_succ k)\n\ntheorem first (n : Nat) : n = 0 ∨ 0 < n := by\n  exact splitHelper n\ntheorem second (n : Nat) : n = 0 ∨ 0 < n := by\n  exact splitHelper n\n';
it('worked helper example includes the new helper and its explanation in transparent totals',async()=>{
  const {scanLean,captureScope,compareScopes}=await tool;assert.equal(scanLean(oldSplit('first')+oldSplit('second')).codeLines,16);assert.equal(scanLean(shared).codeLines,10);
  const root=dir();fs.writeFileSync(path.join(root,'A.lean'),oldSplit('first')+oldSplit('second'));const a=captureScope(root,['A.lean']);fs.writeFileSync(path.join(root,'A.lean'),shared);
  const r=compareScopes(a,captureScope(root,['A.lean']));assert.equal(r.candidateNetCodeDelta,-6);assert.equal(r.metricWin,true);assert.equal(r.rows[0].addedComments.length,1);
});

it('requires complete Lean JSON observations and binds the unchanged query text', async () => {
  const { normaliseBoundaryMessages }=await tool;const raw=JSON.stringify({severity:'information',data:'claim : True'})+'\n';
  const a=normaliseBoundaryMessages('#check @claim',raw,1);const b=normaliseBoundaryMessages('#check @other',raw,1);assert.notEqual(a.querySha256,b.querySha256);
  assert.throws(()=>normaliseBoundaryMessages('q','',1),/Missing/);
  assert.throws(()=>normaliseBoundaryMessages('q',raw,2),/Missing/);
  assert.throws(()=>normaliseBoundaryMessages('q','not JSON',1));
  assert.throws(()=>normaliseBoundaryMessages('q',JSON.stringify({severity:'error',data:'failure'}),1),/diagnostics/);
  assert.throws(()=>normaliseBoundaryMessages('q',JSON.stringify({severity:'information',data:''}),1),/diagnostics/);
});

it('hashes context without treating configuration comments as proof-line savings',async()=>{
  const {contextHashes}=await tool;const root=dir();fs.writeFileSync(path.join(root,'lakefile.toml'),'name = "a"\n');
  const a=contextHashes(root,['lakefile.toml','lean-toolchain']);fs.writeFileSync(path.join(root,'lakefile.toml'),'name = "b"\n');
  assert.notEqual(a.inputs['lakefile.toml'],contextHashes(root,['lakefile.toml']).inputs['lakefile.toml']);assert.equal(a.inputs['lean-toolchain'],null);
});

it('resolves only the effective installed project override, never the global default',async()=>{
  const {projectToolchainContext}=await tool;const root=dir();fs.writeFileSync(path.join(root,'lean-toolchain'),'project-pin\n');
  const install=name=>{const p=path.join(root,name);fs.mkdirSync(path.join(p,'bin'),{recursive:true});for(const n of ['lean','lake']){fs.writeFileSync(path.join(p,'bin',n),'#!/bin/sh\nexit 99\n');fs.chmodSync(path.join(p,'bin',n),0o755);}return p;};
  const a=install('pinned');const b=install('override');
  const state={elan_version:{current:'fixture'},toolchains:{installed:[{resolved_name:'project-pin',path:a},{resolved_name:'explicit-override',path:b}],default:{resolved:{live:{Ok:'global-other'}}},active_override:{reason:{ToolchainFile:path.join(root,'lean-toolchain')}},resolved_active:{live:{Ok:'project-pin'},cached:'project-pin'}}};
  const ctx=projectToolchainContext(root,state);assert.equal(ctx.effectiveToolchain,'project-pin');assert.equal(ctx.lean.path,path.join(a,'bin','lean'));assert.equal(ctx.pin.value,'project-pin');
  const overridden=structuredClone(state);overridden.toolchains.active_override={reason:'Environment'};overridden.toolchains.resolved_active={live:{Ok:'explicit-override'}};
  assert.equal(projectToolchainContext(root,overridden).lake.path,path.join(b,'bin','lake'));
  const cached=structuredClone(state);cached.toolchains.resolved_active={live:{Err:'offline channel'},cached:'project-pin'};assert.equal(projectToolchainContext(root,cached).resolution,'cached-offline');
  const missing=structuredClone(state);missing.toolchains.resolved_active={live:{Ok:'uninstalled-pin'}};assert.throws(()=>projectToolchainContext(root,missing),/not uniquely installed/);assert.equal(fs.existsSync(path.join(root,'uninstalled-pin')),false);
  const global=structuredClone(state);global.toolchains.active_override=null;assert.throws(()=>projectToolchainContext(root,global),/refusing global default/);
  const nested=path.join(root,'nested');fs.mkdirSync(nested);fs.writeFileSync(path.join(nested,'lean-toolchain'),'different-pin\n');
  assert.throws(()=>projectToolchainContext(nested,state),/does not describe this project pin/);
  fs.appendFileSync(path.join(a,'bin','lean'),'# changed');assert.notEqual(projectToolchainContext(root,state).lean.sha256,ctx.lean.sha256,'binary identity drift is visible');
  fs.writeFileSync(path.join(root,'lean-toolchain'),'changed-pin\n');assert.notEqual(projectToolchainContext(root,state).pin.sha256,ctx.pin.sha256);
});

it('requires rendered definition bodies and refuses elided, opaque, missing or theorem-proof views',async()=>{
  const {normaliseBoundaryMessages}=await tool;const info=data=>JSON.stringify({severity:'information',data})+'\n';
  for(const text of ['opaque core : Nat','axiom core : Nat','constructor Core.mk : Core','def core : Nat','def core : Nat :=','def core : Nat := <not imported>','def core : Nat := ⋯']) {
    assert.throws(()=>normaliseBoundaryMessages('#print core',info(text),1,[0]),/body|unavailable|Elided/);
  }
  assert.throws(()=>normaliseBoundaryMessages('#print root',info('theorem root : True := True.intro'),1),/Theorems/);
  assert.throws(()=>normaliseBoundaryMessages('#print sig core',info('def core : let n := 1; Nat'),1,[0]),/Signature-only/);
  assert.throws(()=>normaliseBoundaryMessages('#print core',info('def core : Nat := 1'),1,[1]),/coverage/);
  assert.equal(normaliseBoundaryMessages('#print core',info('@[reducible] def core : Nat := 1'),1,[0]).data.length,1);
});

it('routes unsupported body coverage to review without masking invalid observations or proof dumps',async()=>{
  const {captureBoundaryView}=await tool;const info=data=>JSON.stringify({severity:'information',data})+'\n';
  for(const text of ['opaque core : Nat','structure Core : Type','class Core : Type','def core : Nat','def core : Nat := <not imported>','def core : Nat := ⋯']){
    const gap=captureBoundaryView('#print core',info(text),1,[0]);
    assert.equal(gap.coverage,'review-required');assert.equal(gap.schema,'fvs-refactor/printed-view-gap');
    assert.equal(gap.data,undefined);assert.equal(gap.querySha256.length,64);assert.equal(gap.rawSha256.length,64);
    assert.match(gap.limits,/Matching gap reports are not boundary evidence/);
  }
  assert.equal(captureBoundaryView('#print core',info('def core : Nat := 1'),1,[0]).coverage,'available');
  const first=info('opaque core : Nat');
  assert.throws(()=>captureBoundaryView('q',first+JSON.stringify({severity:'error',data:'type mismatch'}),2,[0]),/diagnostics/);
  assert.throws(()=>captureBoundaryView('q',first+info('theorem claim : True := True.intro'),2,[0]),/Theorems/);
  assert.throws(()=>captureBoundaryView('q',first,2,[0]),/Missing/);
  assert.throws(()=>captureBoundaryView('#print sig core',first,1,[0]),/Signature-only/);
});

it('CLI writes explicit limitation reports and the printed-view guard never equates two gaps',async()=>{
  const {captureBoundaryView}=await tool;const root=dir();const script=path.join(__dirname,'../scripts/fvs-refactor-report.mjs');
  const run=args=>spawnSync(process.execPath,[script,...args],{cwd:root,encoding:'utf8'});
  fs.writeFileSync(path.join(root,'A.lean'),'def text := s!"{("inner; --")}"\n');fs.writeFileSync(path.join(root,'files.json'),'["A.lean"]');
  assert.equal(run(['capture',root,'files.json','before.json']).status,0);
  assert.equal(run(['compare','before.json',root,'files.json','metrics.json']).status,0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'metrics.json'))).metricWin,null);
  fs.writeFileSync(path.join(root,'query.lean'),'#print core');fs.writeFileSync(path.join(root,'slots.json'),'[0]');
  const raw=JSON.stringify({severity:'information',data:'opaque core : Nat'})+'\n';fs.writeFileSync(path.join(root,'raw.jsonl'),raw);
  assert.equal(run(['messages','query.lean','raw.jsonl','1','slots.json','gap.json']).status,0);
  const gap=JSON.parse(fs.readFileSync(path.join(root,'gap.json')));assert.equal(gap.coverage,'review-required');
  assert.notEqual(run(['messages','query.lean','raw.jsonl','1','slots.json','gap.json']).status,0,'exclusive outputs remain enforced');
  fs.writeFileSync(path.join(root,'raw.jsonl'),JSON.stringify({severity:'error',data:'type mismatch'}));
  assert.notEqual(run(['messages','query.lean','raw.jsonl','1','slots.json','bad.json']).status,0);assert.equal(fs.existsSync(path.join(root,'bad.json')),false);
  const {write,check}=guardFixture();
  write('baseline',gap);write('final',gap);let r=check();assert.equal(r.status,0);assert.match(r.stdout,/Pre-existing coverage gap: complete the explicit reviewed boundary comparison/);
  const valid=captureBoundaryView('#print core',JSON.stringify({severity:'information',data:'def core : Nat := 1'}),1,[0]);
  write('baseline',valid);write('final',valid);assert.equal(check().status,0);
  write('final',{...valid,data:['def core : Nat := 2']});assert.notEqual(check().status,0,'fully covered body drift is still rejected');
});

it('a covered baseline stops on failed final inspection or a missing final view',async()=>{
  const {captureBoundaryView}=await tool;const {root,write,check}=guardFixture();
  const valid=captureBoundaryView('#print core',JSON.stringify({severity:'information',data:'def core : Nat := 1'}),1,[0]);
  write('baseline',valid);
  let r=check();assert.notEqual(r.status,0);assert.match(r.stderr,/Previously available protected coverage lost/);assert.doesNotMatch(r.stdout,/complete the explicit reviewed/);
  write('final',valid);fs.writeFileSync(path.join(root,'final','inspection-status.txt'),'7\n');
  r=check();assert.notEqual(r.status,0);assert.match(r.stderr,/Final inspection failed/);assert.doesNotMatch(r.stdout,/complete the explicit reviewed/);
});

it('a covered baseline stops when the final protected view becomes elided',async()=>{
  const {captureBoundaryView}=await tool;const {write,check}=guardFixture();
  const query='set_option pp.maxSteps 20000\n#print core';const info=data=>JSON.stringify({severity:'information',data});
  write('baseline',captureBoundaryView(query,info('def core : Nat := 1'),1,[0]));
  const gap=captureBoundaryView(query,info('def core : Nat := ⋯'),1,[0]);assert.equal(gap.coverage,'review-required');
  write('final',gap);const r=check();assert.notEqual(r.status,0);assert.match(r.stderr,/Previously available protected coverage lost/);assert.doesNotMatch(r.stdout,/complete the explicit reviewed/);
});

const REAL_LAKE=process.env.FVS_REFACTOR_TEST_LAKE;
const REAL_ELAN=process.env.FVS_REFACTOR_TEST_ELAN;
it('installed Elan resolves file, environment and directory overrides offline without installing',{skip:!REAL_ELAN},async()=>{
  const {projectToolchainContext}=await tool;const root=dir();
  const installs=JSON.parse(process.env.FVS_REFACTOR_TEST_INSTALLED_CONTEXTS);assert.ok(installs.length>=2);
  const elanHome=path.join(root,'elan');fs.mkdirSync(path.join(elanHome,'toolchains'),{recursive:true});
  for(const entry of installs)fs.symlinkSync(entry.path,path.join(elanHome,'toolchains',entry.directoryName),'dir');
  const settings=path.join(elanHome,'settings.toml');const other=installs.find(x=>x.pin!==TEST_PIN);assert.ok(other);
  const config=`default_toolchain = "${other.pin}"\nversion = "12"\n`;
  fs.writeFileSync(settings,config);fs.writeFileSync(path.join(root,'lean-toolchain'),TEST_PIN+'\n');
  for(const n of ['home','tmp'])fs.mkdirSync(path.join(root,n));
  const env={HOME:path.join(root,'home'),TMPDIR:path.join(root,'tmp'),ELAN_HOME:elanHome,PATH:'/usr/bin:/bin',LC_ALL:'C'};
  const capture=extra=>{const r=spawnSync(REAL_ELAN,['dump-state','--no-net'],{cwd:root,env:{...env,...extra},encoding:'utf8',timeout:20000});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
  const original=fs.readFileSync(path.join(root,'lean-toolchain'),'utf8');
  const a=projectToolchainContext(root,capture());assert.equal(a.effectiveToolchain,TEST_PIN);assert.equal(a.lean.path,fs.realpathSync(path.join(installs.find(x=>x.pin===TEST_PIN).path,'bin','lean')));
  const b=projectToolchainContext(root,capture({ELAN_TOOLCHAIN:other.pin}));assert.equal(b.effectiveToolchain,other.pin);assert.equal(b.overrideReason,'Environment');
  fs.writeFileSync(settings,config+`\n[overrides]\n${JSON.stringify(root)} = "${other.pin}"\n`);
  const c=projectToolchainContext(root,capture());assert.equal(c.effectiveToolchain,other.pin);assert.equal(c.overrideReason.OverrideDB,root);
  const names=fs.readdirSync(path.join(elanHome,'toolchains'));
  const missing=capture({ELAN_TOOLCHAIN:'leanprover/lean4:v0.0.999'});assert.throws(()=>projectToolchainContext(root,missing),/not uniquely installed/);
  assert.deepEqual(fs.readdirSync(path.join(elanHome,'toolchains')),names);assert.equal(fs.readFileSync(path.join(root,'lean-toolchain'),'utf8'),original);
});
it('real Lean external-file comparison keeps type and axiom checks while body and metric gaps need review',{skip:!REAL_LAKE},t=>{
  const root=dir();for(const name of ['home','tmp','Extra'])fs.mkdirSync(path.join(root,name));
  fs.writeFileSync(path.join(root,'lean-toolchain'),TEST_PIN+'\n');
  fs.writeFileSync(path.join(root,'lakefile.toml'),'name = "external_review"\ndefaultTargets = ["Main"]\n[[lean_lib]]\nname = "Main"\n');
  fs.writeFileSync(path.join(root,'Main.lean'),'def mainValue : Nat := 0\n');
  const env={HOME:path.join(root,'home'),TMPDIR:path.join(root,'tmp'),PATH:path.dirname(REAL_LAKE)+':/usr/bin:/bin',LEAN_NUM_THREADS:'1',LC_ALL:'C',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0'};
  const run=args=>spawnSync('nice',['-n','19',REAL_LAKE,'--no-cache',...args],{cwd:root,env,encoding:'utf8',timeout:60000});
  const ok=r=>assert.equal(r.status,0,r.error?.message||r.stderr+r.stdout);
  const fixed='opaque externalCore : Nat := 1\naxiom externalSpare : True\ndef text : String := s!"{("inner; --")}"\n';
  const queries='\nset_option pp.all true\n#check @externalClaim\n#check @externalCore\n#print axioms externalClaim\n#print axioms externalCore\n';
  const file=path.join(root,'Extra','Proof.lean');const probe=path.join(root,'Extra','Instrumented.lean');
  // Only public global names in this fixture; this does not validate arbitrary private/module contexts.
  const capture=proof=>{fs.writeFileSync(file,fixed+proof);ok(run(['lean','Extra/Proof.lean']));
    fs.writeFileSync(probe,fixed+proof+queries);const output=run(['env','lean','--json','Extra/Instrumented.lean']);ok(output);return output.stdout;};
  return tool.then(({normaliseBoundaryMessages,captureBoundaryView,captureScope,compareScopes})=>{
    const raw=capture('theorem externalClaim : True := True.intro\n');const baseline=normaliseBoundaryMessages(queries,raw,4);
    const source=captureScope(root,['Extra/Proof.lean']);assert.equal(source.files['Extra/Proof.lean'].lean,null);
    fs.writeFileSync(path.join(root,'ImportProbe.lean'),'import Extra.Proof\n');assert.notEqual(run(['env','lean','ImportProbe.lean']).status,0,'file valid for direct gate but not importable as a library');
    const final=normaliseBoundaryMessages(queries,capture('theorem externalClaim : True := by exact True.intro\n'),4);
    assert.deepEqual(final,baseline,'same validated public-name query preserves types and axiom observations');
    assert.equal(compareScopes(source,captureScope(root,['Extra/Proof.lean'])).metricStatus,'unavailable','no fabricated interpolation count');
    fs.writeFileSync(probe,fs.readFileSync(file,'utf8')+queries+'#print externalCore\n');const printed=run(['env','lean','--json','Extra/Instrumented.lean']);ok(printed);
    assert.equal(captureBoundaryView(queries+'#print externalCore\n',printed.stdout,5,[4]).coverage,'review-required','opaque body needs explicit source review, not signature equality');
    const changed=normaliseBoundaryMessages(queries,capture('theorem externalClaim : True := externalSpare\n'),4);
    assert.notDeepEqual(changed,baseline);assert.match(changed.data[2],/externalSpare/,'axiom safeguard still exposes changed assumptions');
    fs.writeFileSync(file,fixed+'theorem externalClaim : False := by trivial\n');assert.notEqual(run(['lean','Extra/Proof.lean']).status,0,'the fallback never waives compilation');
    t.diagnostic(`Bounded public-name external-file fixture retained at ${root}; body review/metric judgment not automated acceptance.`);
  });
});
it('real Lean views allow proof rewrites but expose type, definition and hidden-axiom changes', {skip:!REAL_LAKE},async t=>{
  const {normaliseBoundaryMessages,scanLean}=await tool;assert.ok(path.isAbsolute(REAL_LAKE));const root=dir();for(const n of ['home','tmp'])fs.mkdirSync(path.join(root,n));
  fs.writeFileSync(path.join(root,'lean-toolchain'),TEST_PIN+'\n');fs.writeFileSync(path.join(root,'lakefile.toml'),'name = "guard_demo"\ndefaultTargets = ["GuardDemo"]\n[[lean_lib]]\nname = "GuardDemo"\n');
  const query='import GuardDemo\nset_option pp.all true\nset_option pp.maxSteps 20000\n#check @claim\n#check @core\n#print core\n#print axioms claim\n#print axioms core\n';const q=path.join(root,'Probe.lean');fs.writeFileSync(q,query);
  const env={HOME:path.join(root,'home'),TMPDIR:path.join(root,'tmp'),PATH:path.dirname(REAL_LAKE)+':/usr/bin:/bin',LEAN_NUM_THREADS:'1',LC_ALL:'C',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0'};
  const run=args=>{const r=spawnSync('nice',['-n','19',REAL_LAKE,...args],{cwd:root,env,encoding:'utf8',timeout:60000});assert.equal(r.status,0,r.error?.message||r.stderr+r.stdout);return r;};
  const capture=source=>{fs.writeFileSync(path.join(root,'GuardDemo.lean'),source);run(['--no-cache','build']);return normaliseBoundaryMessages(query,run(['env','lean','--json',q]).stdout,5,[2]);};
  const baseline=capture('def core : Nat := 1\naxiom spare : True\ntheorem claim : True := True.intro\n');
  assert.deepEqual(capture('def core : Nat := 1\naxiom spare : True\ntheorem claim : True := by exact True.intro\n'),baseline);
  assert.notDeepEqual(capture('def core : Nat := 2\naxiom spare : True\ntheorem claim : True := True.intro\n'),baseline);
  assert.notDeepEqual(capture('def core : Nat := 1\naxiom spare : True\ntheorem claim : True ∧ True := ⟨True.intro, True.intro⟩\n'),baseline);
  const hidden=capture('def core : Nat := 1\naxiom spare : True\ntheorem claim : True := spare\n');assert.match(hidden.data[3],/spare/);assert.notDeepEqual(hidden,baseline);
  assert.throws(()=>capture('opaque core : Nat := 1\naxiom spare : True\ntheorem claim : True := True.intro\n'),/body/);
  capture('def core : Nat := 1\naxiom spare : True\ntheorem claim : True := True.intro\n');
  const elided=query.replace('pp.maxSteps 20000','pp.maxSteps 1');fs.writeFileSync(q,elided);
  assert.throws(()=>normaliseBoundaryMessages(elided,run(['env','lean','--json',q]).stdout,5,[2]),/Elided/);
  const proofDump=query+'#print claim\n';fs.writeFileSync(q,proofDump);
  assert.throws(()=>normaliseBoundaryMessages(proofDump,run(['env','lean','--json',q]).stdout,6,[2]),/Theorems/);
  fs.writeFileSync(q,query);
  for(const source of [oldSplit('first')+oldSplit('second'),shared,
    'theorem commDemo (a b : Nat) : a + b = b + a := by\n  induction b with\n  | zero => simp\n  | succ b ih => rw [Nat.add_succ, Nat.succ_add, ih]\n',
    'theorem commDemo (a b : Nat) : a + b = b + a := by\n  exact Nat.add_comm a b\n',
    "theorem packingDemo (p : Prop) (h : p) : p := by\n  have h' : p := h\n  exact h'\n",
    "theorem packingDemo (p : Prop) (h : p) : p := by\n  have h' : p := h; exact h'\n"]){
    fs.writeFileSync(path.join(root,'GuardDemo.lean'),source);run(['--no-cache','build']);
  }
  const interpolated='def interpolationDemo : String := s!"{("inner; --")}"\n';
  fs.writeFileSync(path.join(root,'GuardDemo.lean'),interpolated);run(['--no-cache','build']);
  assert.throws(()=>scanLean(interpolated),/validated counter/);
  const spacedInterpolation=interpolated.replace('s!"','s! "');
  fs.writeFileSync(path.join(root,'GuardDemo.lean'),spacedInterpolation);run(['--no-cache','build']);
  assert.throws(()=>scanLean(spacedInterpolation),/validated counter/);
  const reference=fs.readFileSync(path.join(__dirname,'../fv-skills/references/lean-refactoring.md'),'utf8');
  const timing=[...reference.matchAll(/```bash\n([\s\S]*?)```/g)].map(m=>m[1]).find(b=>b.includes('FVS_ELAPSED_SECONDS'));
  assert.ok(timing);const times=path.join(root,'times');fs.mkdirSync(times);
  const timingArgs=['-c',`SPEC_PATH=GuardDemo.lean\nTIMING_DIR=${times}\nPHASE=baseline\nELABORATION_CMD=("${REAL_LAKE}" lean "$SPEC_PATH" -- --profile)\n${timing}`];
  const timed=spawnSync('/bin/bash',timingArgs,{cwd:root,env,encoding:'utf8',timeout:60000});assert.equal(timed.status,0,timed.stderr+timed.stdout);
  const log=path.join(times,'baseline-1.log');const bytes=fs.readFileSync(log);assert.match(bytes.toString(),/FVS_ELAPSED_SECONDS=\d/);
  const refused=spawnSync('/bin/bash',timingArgs,{cwd:root,env,encoding:'utf8',timeout:60000});assert.notEqual(refused.status,0);assert.deepEqual(fs.readFileSync(log),bytes,'baseline timing logs must not be overwritten');
  t.diagnostic(`Printed-boundary fixture retained at ${root}; comparisons are not kernel identity proofs.`);
});
