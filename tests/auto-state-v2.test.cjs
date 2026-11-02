'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const auto = import(pathToFileURL(path.resolve(__dirname, '../scripts/fvs-auto.mjs')));
const fixtures = path.join(__dirname, 'fixtures/auto-profile'), roots = [];
after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });
const stateFile = root => path.join(root, '.formalising/auto-fv/state.json');
const read = root => JSON.parse(fs.readFileSync(stateFile(root)));
const selected = { source: { revision: 'HEAD', configuration: 'fixture' }, scope: 'one selected fixture', limits: { workers: 3 } };
function stub(fn) {
 const values = { HOME: path.join(fixtures, 'home'), PATH: path.join(fixtures, 'bin') + ':/usr/bin:/bin', FVS_TOOLS_HOME: path.join(fixtures, 'no-fvs-tools') };
 const before = Object.fromEntries(Object.keys(values).map(k => [k, process.env[k]]));Object.assign(process.env, values);
 try { return fn(); } finally { for (const k of Object.keys(values)) if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k]; }
}
function project() {
 const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fvs-state-v2-'));roots.push(root);
 fs.cpSync(path.join(__dirname, 'fixtures/extract-patches/crate'), root, { recursive: true });fs.cpSync(path.join(fixtures, 'fresh'), root, { recursive: true });
 for (const a of [['init','-q'],['add','-A'],['-c','user.name=Fixture','-c','user.email=fixture@invalid','-c','commit.gpgsign=false','commit','-qm','fixture']]) assert.equal(spawnSync('/usr/bin/git',['-C',root,...a]).status,0);
 return root;
}
function init(m, root, choices = selected, extra = {}) { return stub(() => m.initState({ projectRoot:root, choices, platform:'aarch64-apple-darwin', ...extra })); }
function agreement(m, root, contextVersion=1) {
 const s=read(root);const a={schema:'fvs/auto-agreement',schemaVersion:s.schemaVersion,mode:'nonpublic-intent',payload:{choicesGeneration:s.choicesGeneration??0,choices:s.choices,contextVersion,boundaries:[],conventions:[],layout:'single-crate',claims:['fixture only'],trust:['kernel'],acceptance:['independent checker'],ownerReserved:['final PR'],execution:null,draftPr:null},ownerEvidence:{reference:'fixture:owner',response:'fixture agreement'}};
 a.approvedPayloadSha256=m.agreementPayloadSha256(a);fs.writeFileSync(path.join(root,'.formalising/auto-fv/ROADMAP.md'),'# Fixture\n\n## Decisions\n```fvs-auto-agreement\n'+JSON.stringify(a)+'\n```\n');return a;
}
test('new no-budget state has explicit disabled memory and no phantom node/wall limit',async()=>{
 const m=await auto,root=project();const result=init(m,root);assert.equal(result.state.schemaVersion,2);
 assert.deepEqual(read(root).choices,{...selected,budget:{kind:'none'},memory:{mode:'disabled'}});
 const before=fs.readFileSync(stateFile(root));assert.equal(init(m,root).code,'unchanged');assert.deepEqual(fs.readFileSync(stateFile(root)),before);
 const a=agreement(m,root);m.recordAgreement({projectRoot:root,agreement:a});assert.equal(m.readState({projectRoot:root,requireAgreement:true}).agreement.status,'stored-context-current');
 const sealed=fs.readFileSync(stateFile(root));m.readState({projectRoot:root,requireAgreement:true});assert.deepEqual(fs.readFileSync(stateFile(root)),sealed);
});
test('selected budgets and enabled memory bind agreement generation, including ABA',async()=>{
 const m=await auto,root=project();init(m,root,{...selected,budget:{kind:'wall-clock',hours:4},memory:{mode:'beads'}});m.recordAgreement({projectRoot:root,agreement:agreement(m,root)});
 init(m,root,{...selected,budget:{kind:'none'},memory:{mode:'disabled'}},{confirmOverwrite:true});
 init(m,root,{...selected,budget:{kind:'wall-clock',hours:4},memory:{mode:'beads'}},{confirmOverwrite:true});
 assert.equal(read(root).choicesGeneration,2);assert.throws(()=>m.readState({projectRoot:root,requireAgreement:true}),e=>e.code==='stale-agreement');
});
test('all state writers preserve v2 choices; malformed/mixed inputs never write',async()=>{
 const m=await auto,root=project();init(m,root);const a=agreement(m,root);m.recordAgreement({projectRoot:root,agreement:a});m.recordRoadmap({projectRoot:root,decision:'declined'});
 assert.deepEqual(read(root).choices.budget,{kind:'none'});assert.equal(read(root).schemaVersion,2);
 const before=fs.readFileSync(stateFile(root));
 for(const choices of [{...selected,limits:{workers:3,nodeHours:2}},{...selected,budget:{kind:'none',hours:1}},{...selected,memory:{mode:'disabled',ready:true}},{...selected,budget:{kind:'wall-clock',hours:Infinity}}]) assert.throws(()=>init(m,root,choices));
 assert.throws(()=>init(m,root,selected,{schemaVersion:1}),e=>e.code==='migration-required');assert.deepEqual(fs.readFileSync(stateFile(root)),before);
 const wrong={...a,schemaVersion:1};wrong.approvedPayloadSha256=m.agreementPayloadSha256(wrong);assert.throws(()=>m.recordAgreement({projectRoot:root,agreement:wrong}));assert.deepEqual(fs.readFileSync(stateFile(root)),before);
});
test('legacy initialization/rerun stays literal v1 and cannot migrate in place',async()=>{
 const m=await auto,root=project(),legacy={...selected,limits:{wallClockHours:40}};init(m,root,legacy);assert.equal(read(root).schemaVersion,1);assert.deepEqual(read(root).choices.limits,{nodeHours:2,workers:3,wallClockHours:40});
 const before=fs.readFileSync(stateFile(root));assert.equal(init(m,root,legacy).code,'unchanged');assert.throws(()=>init(m,root,selected,{schemaVersion:2}),e=>e.code==='migration-required');assert.deepEqual(fs.readFileSync(stateFile(root)),before);
});
