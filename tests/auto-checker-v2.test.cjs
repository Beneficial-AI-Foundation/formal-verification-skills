// Protocol/owned-child fixtures only. The executable below is NOT Lean evidence.
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const checker = import(pathToFileURL(path.resolve(__dirname, '../scripts/fvs-checker.mjs')));
const execution = import(pathToFileURL(path.resolve(__dirname, '../scripts/fvs-execution.mjs')));
const roots=[];after(()=>{for(const root of roots)fs.rmSync(root,{recursive:true,force:true});});
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
async function fixture(version=2,budget={kind:'none'}){
 const e=await execution;const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'fvs-kernel-v2-'));roots.push(root);
 const bin=path.join(root,'toolchain/bin');fs.mkdirSync(bin,{recursive:true});const lib=path.join(root,'toolchain/lib/lean');fs.mkdirSync(lib,{recursive:true});const standard=path.join(lib,'Init.olean');fs.writeFileSync(standard,'fixture standard');const lean=path.join(bin,'lean');
 const script=`#!${process.execPath}\nconst fs=require('node:fs');const path=require('node:path');const mode=process.argv.at(-2),q=JSON.parse(fs.readFileSync(process.argv.at(-1)));const standard=${JSON.stringify(standard)};const imports=[{name:'Init',project:false,parts:[standard]}];if(mode==='witness'){console.log(JSON.stringify({schema:'fvs-type-witness/structures',version:1,runId:q.runId,facts:[],declarations:[{name:'A.t',kind:'theorem'}],imports:[...imports,{name:'A',project:true,parts:q.referenceModules[0].parts}]}));}else console.log(JSON.stringify({schema:mode==='baseline'?'fvs-kernel-baseline/result':'fvs-kernel-audit/result',version:1,runId:q.runId,status:mode==='baseline'?'meaning-checked':'kernel-checked',targetProofsChecked:mode!=='baseline',targets:q.targets.map(t=>t.name),replayed:q.targets.map(t=>t.name),meaning:[],axioms:[],imports}));\n`;
 fs.writeFileSync(lean,script,{mode:0o700});const part=path.join(root,'A.olean');fs.writeFileSync(part,'fixture module');
 const job={schema:'fvs-checker/kernel-request',version,runId:'protocol-run',lean:{path:lean,sha256:sha(fs.readFileSync(lean))},externalSearchPaths:[],externalImports:[],modules:[{name:'A',parts:[part]}],referenceModules:[{name:'A',parts:[part]}],targets:[{name:'A.t',expectedName:'A.t'}],meaningRoots:[],...(version===2?{execution:e.createExecution('project-run',budget)}:{deadlineMs:Date.now()+10000})};const request=path.join(root,'input.json');fs.writeFileSync(request,JSON.stringify(job));return{root,job,request,out:path.join(root,'audit'),part};
}
test('v1 public kernel API stays synchronous and rejects a v2 request',async()=>{
 const m=await checker,f=await fixture(1);const result=m.runKernelAudit(f);assert.equal(typeof result.then,'undefined');assert.equal(result.code,'ok');assert.equal(result.attempt.version,1);
 const v2=await fixture();assert.throws(()=>m.runKernelAudit(v2),e=>e.code==='invalid-input');assert.equal(fs.existsSync(v2.out),false);
});
test('v2 owns and awaits all three witness/audit calls with no elapsed-budget fallback',async()=>{
 const m=await checker,f=await fixture();const modes=[];const promise=m.runKernelAuditV2(f,{now:()=>Date.now()+5*3600000,spawnProcess(file,args,opts){modes.push(args.at(-2));assert.equal('timeout'in opts,false);return spawn(file,args,opts);}});assert.equal(typeof promise.then,'function');const result=await promise;
 assert.equal(result.code,'ok');assert.equal(result.attempt.version,2);assert.deepEqual(modes,['witness','witness','audit']);assert.ok(result.attempt.inputs[path.resolve(__dirname,'../scripts/fvs-execution.mjs')]);assert.ok(result.attempt.inputs[path.resolve(__dirname,'../scripts/fvs-project-memory.mjs')]);
});
test('v2 cancellation before final audit publication retains actual command facts, no result',async()=>{
 const m=await checker,f=await fixture(),c=new AbortController();let calls=0;
 await assert.rejects(m.runKernelAuditV2(f,{signal:c.signal,spawnProcess(file,args,opts){calls++;const child=spawn(file,args,opts);if(args.at(-2)==='audit')child.on('close',()=>c.abort());return child;}}),e=>e.code==='cancelled');
 assert.equal(calls,3);assert.equal(fs.existsSync(path.join(f.out,'result.json')),false);const actual=JSON.parse(fs.readFileSync(path.join(f.out,'attempt.json')));assert.equal(actual.error,null);assert.equal(actual.supervision.cancelled,true);assert.equal(actual.exit,0);assert.equal(actual.signal,null);
});
test('v2 selected deadline crossing during final read does not publish a success',async()=>{
 const deadline=Date.now()+10000,m=await checker,f=await fixture(2,{kind:'deadline',deadlineMs:deadline});let finished=false;
 await assert.rejects(m.runKernelAuditV2(f,{now:()=>finished?deadline:Date.now(),spawnProcess(file,args,opts){const child=spawn(file,args,opts);if(args.at(-2)==='audit')child.on('close',()=>{finished=true;});return child;}}),e=>e.code==='timeout');assert.equal(fs.existsSync(path.join(f.out,'result.json')),false);
});
test('v2 data drift still refuses when no elapsed budget exists',async()=>{
 const m=await checker,f=await fixture();await assert.rejects(m.runKernelAuditV2(f,{spawnProcess(file,args,opts){const child=spawn(file,args,opts);if(args.at(-2)==='audit')child.on('close',()=>fs.writeFileSync(f.part,'changed fixture input'));return child;}}),e=>e.code==='stale-input');assert.equal(fs.existsSync(path.join(f.out,'result.json')),false);
});

test('public v2 audit dispatcher awaits its result instead of returning apparent success',async()=>{
 const m=await checker,f=await fixture();const result=await m.runCommand(['audit','--request',f.request,'--out',f.out]);assert.equal(result.code,'ok');assert.equal(result.attempt.version,2);assert.equal(fs.existsSync(result.evidence.file),true);
});
test('CLI SIGTERM propagates to an owned witness and reports cancellation without proof output',async()=>{
 const f=await fixture(),marker=path.join(f.root,'witness-started');
 const script='#!'+process.execPath+'\nconst fs=require("node:fs");fs.writeFileSync('+JSON.stringify(marker)+',String(process.pid));setInterval(()=>{},1000);setTimeout(()=>process.exit(89),5000);\n';
 fs.writeFileSync(f.job.lean.path,script);f.job.lean.sha256=sha(fs.readFileSync(f.job.lean.path));fs.writeFileSync(f.request,JSON.stringify(f.job));
 const argv=[path.resolve(__dirname,'../scripts/fvs-checker.mjs'),'audit','--request',f.request,'--out',f.out];const child=spawn(process.execPath,argv,{cwd:f.root,env:{PATH:path.dirname(process.execPath)+':/usr/bin:/bin',LANG:'C'},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
 const ended=new Promise((resolve,reject)=>{child.once('close',(code,signal)=>resolve({code,signal}));child.once('error',reject);});
 const until=Date.now()+3000;while(!fs.existsSync(marker)&&Date.now()<until)await new Promise(done=>setTimeout(done,10));assert.equal(fs.existsSync(marker),true,'owned witness actually entered');child.kill('SIGTERM');const result=await ended;
 assert.equal(result.code,130,stderr);assert.equal(result.signal,null);assert.equal(JSON.parse(stdout).code,'cancelled');assert.equal(fs.existsSync(path.join(f.out,'result.json')),false);
 const witness=JSON.parse(fs.readFileSync(path.join(f.out,'witness-attempt.json')));assert.equal(witness.exit,null);assert.equal(witness.signal,'SIGKILL');assert.equal(witness.error,null);assert.equal(witness.supervision.cancelled,true);assert.equal(witness.supervision.cleanupComplete,true);
});
