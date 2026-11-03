// Review regressions. Proof validation is explicitly modelled; filesystem publication and wrapper readers are real.
'use strict';
const{test,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const f=require('./helpers/checker-execution-review-fixture.cjs'),roots=[];
after(()=>{for(const root of roots)fs.rmSync(root,{recursive:true,force:true});});
async function model(...args){const x=await f.publicationModel(...args);roots.push(x.dir);return x;}
async function kernel(...args){const x=await f.kernelFixture(...args);roots.push(x.dir);return x;}
async function invoke(x,services={}){const request=x.write('accept-request',x.job);return x.accept.module.runAuto('accept',{request:request.file,out:x.out()},{executionServices:services});}
for(const mode of ['cancel','deadline'])test('v2 accepted temp fsync '+mode+' refuses before canonical rename and keeps pending truth',async()=>{
 const x=await model(2,mode==='deadline'?{kind:'deadline',deadlineMs:Date.now()+60000}:{kind:'none'}),c=new AbortController();let now=Date.now(),triggered=false;const opened=new Map(),open=fs.openSync,close=fs.closeSync,sync=fs.fsyncSync;
 fs.openSync=function(file,...args){const fd=open.call(fs,file,...args);opened.set(fd,String(file));return fd;};fs.closeSync=function(fd){opened.delete(fd);return close.call(fs,fd);};fs.fsyncSync=function(fd){const value=sync.call(fs,fd);if(opened.get(fd)?.startsWith(path.join(x.store,'.tmp-'))){triggered=true;if(mode==='cancel')c.abort();else now=x.control.budget.deadlineMs+1;}return value;};
 try{await assert.rejects(invoke(x,{signal:c.signal,now:()=>now}),{code:mode==='cancel'?'cancelled':'timeout'});}finally{fs.openSync=open;fs.closeSync=close;fs.fsyncSync=sync;}
 assert.equal(triggered,true);assert.deepEqual(fs.readdirSync(path.join(x.store,'records')),[]);assert.ok(fs.readdirSync(x.store).some(n=>n.startsWith('.tmp-')));assert.ok(fs.existsSync(path.join(x.store,'lock')));assert.ok(fs.existsSync(path.join(x.registry,'lock')));
});
test('post-commit observed stop retains the already renamed event rather than fabricating cancellation',async()=>{
 const x=await model(),c=new AbortController(),rename=fs.renameSync;let committed=false;fs.renameSync=function(from,to){const result=rename.call(fs,from,to);if(path.dirname(String(to))===path.join(x.store,'records')){committed=true;c.abort();}return result;};let result;
 try{result=await invoke(x,{signal:c.signal});}finally{fs.renameSync=rename;}
 assert.equal(committed,true);assert.equal(c.signal.aborted,true);assert.equal(result.status,'accepted');assert.ok(fs.existsSync(result.acceptedReceipt.file));assert.equal(f.sha(result.acceptedReceipt.file),result.acceptedReceipt.sha256);assert.equal(fs.existsSync(path.join(x.store,'lock')),false);
 const real=await import('../scripts/fvs-checker-auto.mjs');assert.throws(()=>real.readAcceptedStore(x.store),'upstream-model output is not a valid project proof receipt');
});
for(const command of ['check','accept'])test('public '+command+' retains frozen logical execution across different producer IDs; rehashed renewals refuse',async()=>{
 const e=await import('../scripts/fvs-execution.mjs'),x=await model(2,{kind:'deadline',deadlineMs:Date.now()+60000}),base=command==='accept'?x.job:{schema:'fvs-checker/check-request',version:2,purpose:'auto',runId:'another-producer',execution:x.control,baseline:x.baseline,source:x.job.source,nodes:[19]},m=command==='accept'?x.accept.module:x.check.module;
 for(const execution of [e.createExecution('another-logical-run',x.control.budget),e.createExecution(x.control.runId,{kind:'none'}),e.createExecution(x.control.runId,{kind:'deadline',deadlineMs:x.control.budget.deadlineMs+60000})]){
  const request=x.write('renewal',{...base,execution}),out=x.out();await assert.rejects(m.runAuto(command,{request:request.file,out},{executionServices:{}}),err=>err.code==='stale-input'&&/execution policy/.test(err.message));assert.equal(fs.existsSync(out),false);
 }
 if(command==='check'){const request=x.write('same-policy',base);await assert.rejects(m.runAuto(command,{request:request.file,out:x.out()},{executionServices:{}}),{code:'model-build-reached'});}else assert.equal((await invoke(x)).status,'accepted');
 const n=await model(),q=command==='accept'?n.job:{schema:'fvs-checker/check-request',version:2,purpose:'auto',runId:'different-job-id',execution:n.control,baseline:n.baseline,source:n.job.source,nodes:[19]};if(command==='accept')assert.equal((await invoke(n)).status,'accepted');else{const request=n.write('same-none',q);await assert.rejects(n.check.module.runAuto(command,{request:request.file,out:n.out()},{executionServices:{}}),{code:'model-build-reached'});}
});
test('expected kernel wrapper version/control/supervision rejects coherent downgrade and preceding-phase mutants',async()=>{
 const m=await import('../scripts/fvs-checker.mjs'),e=await import('../scripts/fvs-execution.mjs'),x=await kernel();assert.doesNotThrow(()=>m.checkKernelArtifacts(x.kernel,2,x.control));const legacy=await kernel(1);assert.doesNotThrow(()=>m.checkKernelArtifacts(legacy.kernel,1));
 for(const version of [1,99,undefined]){const k=structuredClone(x.kernel);if(version===undefined)delete k.attempt.version;else k.attempt.version=version;delete k.attempt.supervision;assert.throws(()=>m.checkKernelArtifacts(k,2,x.control),err=>err.code==='stale-input'&&/version/.test(err.message));}
 for(const phase of ['discovery','witness','attempt'])for(const mutation of ['missing','cancelled','incomplete']){const k=structuredClone(x.kernel),p=phase==='attempt'?k.attempt:k.attempt[phase];if(mutation==='missing')delete p.supervision;if(mutation==='cancelled')p.supervision.cancelled=true;if(mutation==='incomplete')p.supervision.cleanupComplete=false;assert.throws(()=>m.checkKernelArtifacts(k,2,x.control),err=>err.code==='stale-input'&&/supervision/.test(err.message));}
 const changed=structuredClone(x.kernel);changed.attempt.execution=e.createExecution('other', {kind:'none'});assert.throws(()=>m.checkKernelArtifacts(changed,2,x.control),err=>err.code==='stale-input'&&/execution policy/.test(err.message));
 const childOnly=structuredClone(x.kernel);childOnly.attempt.supervision.cleanup={kind:'child-terminal-within-caller-owned-group',result:'child-terminal',streamsDrained:true,descendantAttestation:false};assert.throws(()=>m.checkKernelArtifacts(childOnly,2,x.control),err=>err.code==='stale-input'&&/supervision/.test(err.message));
});
test('candidate reader rejects rehashed outer references with downgraded kernel attempts',async()=>{
 const x=await kernel(),origin=x.write('origin',{version:2,execution:x.control}),source={commit:'a'.repeat(40),tree:'b'.repeat(40)},frozen=x.write('frozen',{schema:'fvs-checker/auto-baseline',version:2,purpose:'auto',input:origin,registry:{headSha256:'c'.repeat(64)},records:{},targets:[{node:19,name:'Fixture.target'}]}),adapter=x.write('adapter',{version:2,execution:x.control,runId:x.kernel.audit.runId,baseline:frozen,source:{commit:source.commit,expectedTree:source.tree},nodes:[19]});
 const module=await f.copyModule(x.dir,'export{checkEvidence as fixtureCheckEvidence};');
 const candidate=k=>x.write('candidate',{schema:'fvs-checker/auto-check',version:2,purpose:'auto',authority:'provisional-only',status:'provisional',runId:x.kernel.audit.runId,frozenSha256:frozen.sha256,baseline:frozen,registryHeadSha256:'c'.repeat(64),records:{},nodes:[19],source,build:{version:2,execution:x.control,source},audit:k.audit,kernelCheck:x.write('kernel',k),adapterInput:adapter,controllerInput:origin});
 assert.equal(module.module.fixtureCheckEvidence(candidate(x.kernel),frozen.sha256).status,'provisional');for(const version of [1,99,undefined]){const k=structuredClone(x.kernel);if(version===undefined)delete k.attempt.version;else k.attempt.version=version;delete k.attempt.supervision;assert.throws(()=>module.module.fixtureCheckEvidence(candidate(k),frozen.sha256),err=>err.code==='stale-input'&&/version/.test(err.message));}
});

test('frozen meaning reader enforces expected wrapper version/control without treating Lean semantic version1 as a downgrade',async()=>{
 const x=await kernel(2,{kind:'none'},true),source={kind:'git',root:x.dir,commit:'a'.repeat(40),expectedTree:'b'.repeat(40)},origin={version:2,execution:x.control,runId:'freeze-producer',extraction:{model:'upstream extraction context double'},baseline:{source},registry:{root:x.dir,headSha256:'c'.repeat(64)}},input=x.write('freeze-input',origin),inventory=x.write('inventory',{source}),fixtureSource={commit:source.commit,tree:source.expectedTree};
 const base={schema:'fvs-checker/auto-baseline',version:2,purpose:'auto',authority:'expectations-only',runId:origin.runId,input,contextInventory:inventory,checker:{},fixtureSource,build:{version:2,execution:x.control,source:fixtureSource},registry:origin.registry,records:{},extractionSourceCommit:'d'.repeat(40),controllerInput:input,adapterInput:input,compiled:{},imports:{},runtimes:{},meaning:x.kernel.audit,extractionMeaning:x.kernel.audit};
 const copy=await f.copyModule(x.dir,`extractionContext=()=>({identity:{json:{provenance:{sourceCommit:'${'d'.repeat(40)}'}}}});engineIdentity=()=>({});export{frozenArtifacts as fixtureFrozenArtifacts};`);
 const frozen=k=>{const ref=x.write('meaning-kernel',k);return x.write('frozen',{...base,meaningCheck:ref,extractionMeaningCheck:ref});};
 assert.equal(copy.module.fixtureFrozenArtifacts(frozen(x.kernel)).frozen.version,2);
 for(const version of[1,99,undefined]){const k=structuredClone(x.kernel);if(version===undefined)delete k.attempt.version;else k.attempt.version=version;delete k.attempt.supervision;assert.throws(()=>copy.module.fixtureFrozenArtifacts(frozen(k)),err=>err.code==='stale-input'&&/version/.test(err.message));}
 const cancelled=structuredClone(x.kernel);cancelled.attempt.witness.supervision.cancelled=true;assert.throws(()=>copy.module.fixtureFrozenArtifacts(frozen(cancelled)),err=>err.code==='stale-input'&&/supervision/.test(err.message));
});
test('retained helper audit uses the same explicit version/control guard and rejects unknown or incomplete wrappers',async()=>{
 const m=await import('../scripts/fvs-checker.mjs'),x=await kernel(2,{kind:'none'},false,'accepted-step-reuse-19');assert.doesNotThrow(()=>m.checkKernelArtifacts(x.kernel,2,x.control));
 for(const version of[1,99,undefined]){const k=structuredClone(x.kernel);if(version===undefined)delete k.attempt.version;else k.attempt.version=version;assert.throws(()=>m.checkKernelArtifacts(k,2,x.control),err=>err.code==='stale-input'&&/version/.test(err.message));}
 const missing=structuredClone(x.kernel);delete missing.attempt.discovery.supervision;assert.throws(()=>m.checkKernelArtifacts(missing,2,x.control),err=>err.code==='stale-input'&&/supervision/.test(err.message));
});
test('standalone public continuation keeps frozen execution identity before any build and accepts distinct job IDs at the policy gate',async()=>{
 const m=await import('../scripts/fvs-checker.mjs'),e=await import('../scripts/fvs-execution.mjs'),root=f.root();roots.push(root);const part=path.join(root,'Fixture.olean');fs.writeFileSync(part,'protocol bytes; no compiled proof');
 for(const budget of[{kind:'none'},{kind:'deadline',deadlineMs:Date.now()+60000}]){
  const execution=e.createExecution('standalone-logical',budget),frozen=f.json(root,'standalone-frozen',{schema:'fvs-checker/standalone-baseline',version:2,purpose:'standalone',authority:'audit-only',execution,projectRoot:root,compiled:{'Fixture.olean':f.sha(part)},checker:{},externalBindings:{[part]:f.sha(part)},runtimeBindings:{},targets:[{name:'Fixture.target'}],meaning:{status:'meaning-checked',targetProofsChecked:false}}),base={schema:'fvs-checker/check-request',version:2,purpose:'standalone',runId:'other-producer-job-id',baseline:frozen,projectRoot:root,execution};
  const replacements=[e.createExecution('other-logical',budget),e.createExecution(execution.runId,{kind:'deadline',deadlineMs:Date.now()+120000})];if(budget.kind==='deadline')replacements.push(e.createExecution(execution.runId,{kind:'none'}));
  for(const replacement of replacements){const request=f.json(root,'standalone-renewed',{...base,execution:replacement}),out=path.join(root,'out-'+Date.now()+'-'+Math.random());await assert.rejects(m.check({request:request.file,out}),err=>err.code==='stale-input'&&/execution policy/.test(err.message));assert.equal(fs.existsSync(out),false);}
  const unchanged=f.json(root,'standalone-same',base);await assert.rejects(m.check({request:unchanged.file,out:path.join(root,'not-built-'+Math.random())}),err=>err.code==='invalid-input'&&/meaning wrapper/.test(err.message));
 }
});
