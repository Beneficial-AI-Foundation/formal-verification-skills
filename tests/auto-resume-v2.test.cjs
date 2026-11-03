// AO/Beads protocol doubles, not actual AO or backend qualification.
'use strict';
const { test, after }=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {pathToFileURL}=require('node:url');const f=require('./helpers/resume-fixture.cjs');
const auto=import(pathToFileURL(path.join(f.ROOT,'scripts/fvs-auto.mjs')));const resume=import(pathToFileURL(path.join(f.ROOT,'scripts/fvs-auto-resume.mjs')));const roots=[];after(()=>{for(const p of roots)fs.rmSync(p,{recursive:true,force:true});});
async function make(policy={}){const m=await auto,r=await resume,x=f.fixture(m,undefined,null,{schemaVersion:2,...policy});roots.push(x.owned);return{m,r,x};}
function services(m,x,extra={}){return{loadCanonical(){const view=m.readState({projectRoot:x.root,requireAgreement:true});return{view,envelope:{mode:view.agreement.agreement.mode}};},refreshMemory(){throw Error('disabled memory backend called');},verifyMemory(){throw Error('disabled memory backend called');},inspectAcceptance(){throw Error('not this fixture');},...extra};}
function invoke(r,x,q,svc){const out=x.out();return{q,out,result:r.runResume('state',{projectRoot:x.root,request:q,out},svc)};}
test('v2 no-budget and disabled memory reconcile twice without a backend or deadline',async()=>{
 const{m,r,x}=await make(),s=services(m,x),before=fs.readFileSync(f.stateFile(x.root));const a=invoke(r,x,x.request(),s);assert.equal(a.result.schemaVersion,2);assert.equal(a.result.code,'reconciled');assert.equal(a.result.observation.memory.status,'disabled');assert.equal(a.result.observation.memory.request,null);
 const run=m.readRuntimeState({projectRoot:x.root}).state.run;assert.deepEqual(run.budget,{kind:'none'});assert.deepEqual(run.limits,{workers:3});assert.equal('deadlineMs'in run,false);
 const b=invoke(r,x,x.request(),services(m,x,{now:()=>run.startedAtMs+5*3600000}));assert.equal(b.result.code,'reconciled');assert.notEqual(a.q.attemptId,b.q.attemptId);assert.deepEqual(m.readRuntimeState({projectRoot:x.root}).state.run,run);assert.deepEqual(fs.readFileSync(f.stateFile(x.root)),before);
 assert.throws(()=>r.consumeResume({projectRoot:x.root,request:a.q,out:a.out},s),e=>e.code==='resume-head-stale');assert.equal(r.consumeResume({projectRoot:x.root,request:b.q,out:b.out},services(m,x,{now:()=>run.startedAtMs+5*3600000})).code,'reconciled');
 // Wall time is audit, not a no-budget freshness TTL.
 const c=invoke(r,x,x.request(),s);assert.equal(c.result.code,'reconciled');assert.equal(r.consumeResume({projectRoot:x.root,request:c.q,out:c.out},s).code,'reconciled');
});
test('no elapsed budget never makes stale source or expected head current',async()=>{
 const{m,r,x}=await make(),s=services(m,x);invoke(r,x,x.request(),s);const prior=m.readRuntimeState({projectRoot:x.root}).headSha256;assert.throws(()=>invoke(r,x,x.request({expectedHeadSha256:null}),s),e=>e.code==='resume-head-stale');assert.equal(m.readRuntimeState({projectRoot:x.root}).headSha256,prior);
 const q=x.request();q.source.expectedTree='0'.repeat(40);const stale=invoke(r,x,q,s);assert.equal(stale.result.code,'partial');assert.ok(stale.result.observation.reasons.includes('integration-source-mismatch'));assert.throws(()=>r.consumeResume({projectRoot:x.root,request:q,out:stale.out},s));
});
test('selected v2 deadline is derived once and remains exhausted across resume',async()=>{
 const{m,r,x}=await make({budget:{kind:'wall-clock',hours:4}}),s=services(m,x);invoke(r,x,x.request(),s);const run=m.readRuntimeState({projectRoot:x.root}).state.run;assert.equal(run.budget.deadlineMs-run.startedAtMs,4*3600000);
 const result=invoke(r,x,x.request(),services(m,x,{now:()=>run.budget.deadlineMs+1}));assert.equal(result.result.code,'partial');assert.ok(result.result.observation.reasons.includes('original-limit-exhausted'));assert.deepEqual(m.readRuntimeState({projectRoot:x.root}).state.run,run);
});
test('enabled memory keeps actual independent bootstrap checks; no disabled substitution',async()=>{
 const{m,r,x}=await make({memory:'beads'});const good=invoke(r,x,x.request(),services(m,x,{refreshMemory:m.refreshMemory,verifyMemory:m.verifyMemoryBootstrap}));assert.equal(good.result.code,'reconciled');assert.equal('status'in good.result.observation.memory,false);assert.ok(f.calls(x.root).some(row=>row.argv.includes('prime')));
 const prior=m.readRuntimeState({projectRoot:x.root}).headSha256;assert.throws(()=>invoke(r,x,x.request({memoryRequest:null}),services(m,x)),e=>e.code==='resume-memory-mismatch');assert.equal(m.readRuntimeState({projectRoot:x.root}).headSha256,prior);
 const y=await make();const q=y.x.request();q.memoryRequest={attemptId:q.attemptId,phase:q.phase,operation:'coordinator-refresh',target:{projectId:q.ao.projectId,sessionId:q.ao.coordinatorSessionId,resumeId:q.resumeId}};assert.throws(()=>invoke(y.r,y.x,q,services(y.m,y.x)),e=>e.code==='resume-memory-mismatch');
});
test('v1/v2 request and runtime versions cannot be mixed or migrated',async()=>{
 const{m,r,x}=await make();invoke(r,x,x.request(),services(m,x));const before=fs.readFileSync(path.join(x.root,'.formalising/auto-fv/resume/state.json'));const q=x.request();q.schemaVersion=1;assert.throws(()=>invoke(r,x,q,services(m,x)));assert.deepEqual(fs.readFileSync(path.join(x.root,'.formalising/auto-fv/resume/state.json')),before);
});
