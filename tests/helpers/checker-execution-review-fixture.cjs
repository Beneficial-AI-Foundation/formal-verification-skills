// Protocol/wrapper fixtures only. Owned module copies double upstream validation, never production input.
'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),{pathToFileURL}=require('node:url');
const ROOT=path.resolve(__dirname,'../..'),sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function ref(file){return{file,sha256:sha(file)};}
function json(root,name,value){const file=path.join(root,name+'-'+crypto.randomUUID()+'.json');fs.writeFileSync(file,JSON.stringify(value));return ref(file);}
function root(){return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fvs-execution-review-')));}
async function copyModule(dir,tail){const file=path.join(dir,'auto-model-'+crypto.randomUUID()+'.mjs'),source=path.join(ROOT,'scripts/fvs-checker-auto.mjs');let body=fs.readFileSync(source,'utf8');body=body.replace(/from (['"])\.\/([^'"]+)\1/g,(_m,_q,name)=>'from '+JSON.stringify(pathToFileURL(path.join(ROOT,'scripts',name)).href));fs.writeFileSync(file,body+'\n'+tail);return{module:await import(pathToFileURL(file).href),file,sourceSha256:sha(source),copySha256:sha(file)};}
async function publicationModel(version=2,budget={kind:'none'}){
 const e=await import('../../scripts/fvs-execution.mjs'),dir=root(),source=path.join(dir,'source'),store=path.join(dir,'store'),registry=path.join(dir,'registry');for(const p of[source,store,registry])fs.mkdirSync(p);
 const control=e.createExecution('logical-original',budget),sourceTuple={kind:'git',root:source,commit:'a'.repeat(40),expectedTree:'b'.repeat(40)},origin={version,...(version===2?{execution:control}:{deadlineMs:Date.now()+60000}),baseline:{source:sourceTuple,libraries:[]}},records={19:{sha256:'c'.repeat(64),contract:{assumptions:[]}}};
 const config={origin,frozen:{version,build:{projectRoot:source},registry:{root:registry,headSha256:'d'.repeat(64)},records,extractionSourceCommit:'e'.repeat(40),overlayFiles:[],expected:{contexts:[]}},candidate:{source:{commit:sourceTuple.commit,tree:sourceTuple.expectedTree},nodes:[19],build:{}}};
 const cfg=json(dir,'upstream-model',config),baseline=json(dir,'not-real-frozen',{model:'not a valid checker baseline'}),candidateCheck=json(dir,'not-real-check',{model:'not a proof receipt'});
 const common=`const MODEL=JSON.parse(fs.readFileSync(${JSON.stringify(cfg.file)},'utf8'));
frozenArtifacts=()=>({frozen:MODEL.frozen,job:MODEL.origin,context:{view:{union:new Set([19]),nodes:new Map([[19,{dependsOn:[]}]])}}});
registryContext=()=>MODEL.frozen.records;
checkEvidence=()=>MODEL.candidate;
checkBuildEvidence=()=>{};
integrationHead=(_s,out,label)=>save(out,label+'.json',{model:'prevalidated source metadata; not Git observation'});
sourceInventory=()=>({files:[]});
buildSnapshot=async()=>{throw Object.assign(Error('upstream model build boundary'),{code:'model-build-reached'});};
`;
 const accept=await copyModule(dir,common+`checkAuto=async(job,out)=>{exclusive(out);const evidence=save(out,'result.json',{model:'upstream proof double; not acceptance authority'});return{source:MODEL.candidate.source,build:{},evidence};};`);
 const check=await copyModule(dir,common);
 const job={schema:'fvs-checker/accept-request',version,purpose:'auto',runId:'different-producer-job',...(version===2?{execution:control}:{deadlineMs:origin.deadlineMs}),baseline,candidateCheck,source:sourceTuple,node:19,store:{root:store,expectedHeadSha256:null}};
 return{dir,store,registry,job,control,accept,check,origin,baseline,write:(name,v)=>json(dir,name,v),out:()=>path.join(dir,'out-'+crypto.randomUUID())};
}
async function kernelFixture(version=2,budget={kind:'none'},baseline=false,runId='kernel-producer'){
 const e=await import('../../scripts/fvs-execution.mjs'),dir=root(),control=e.createExecution('logical-kernel',budget),compiled=path.join(dir,'Fixture.olean');fs.writeFileSync(compiled,'opaque protocol bytes; never a compiled proof');
 const req={schema:'fvs-checker/kernel-request',version,runId,...(version===2?{execution:control}:{deadlineMs:1}),lean:{path:process.execPath,sha256:sha(process.execPath)},externalSearchPaths:[],externalImports:[],modules:[{name:'Fixture',parts:[compiled]}],referenceModules:[{name:'Fixture',parts:[compiled]}],targets:[{name:'Fixture.target',expectedName:'Fixture.target'}],meaningRoots:[]};
 const original=json(dir,'original-request',req),sealed=json(dir,'sealed-request',req),runner=path.join(dir,'runner.mjs'),helper=path.join(dir,'Audit.lean');fs.copyFileSync(path.join(ROOT,'scripts/fvs-checker.mjs'),runner);fs.copyFileSync(path.join(ROOT,'scripts/FvsKernelAudit.lean'),helper);
 const supervision={cancelled:false,timedOut:false,cleanupComplete:true,cleanup:{kind:'recorded-owned-group-absence',result:'absent',descendantAttestation:false,streamsDrained:true}},phase={argv:[],exit:0,signal:null,error:null,...(version===2?{execution:control,supervision}: {})};
 const audit={schema:baseline?'fvs-kernel-baseline/result':'fvs-kernel-audit/result',version:1,runId,status:baseline?'meaning-checked':'kernel-checked',targetProofsChecked:!baseline,targets:['Fixture.target'],replayed:['Fixture.target'],meaning:[],axioms:[],imports:[]};
 const kernel={authority:'audit-only',audit,attempt:{schema:'fvs-checker/kernel-attempt',authority:'audit-only',version,runId,inputs:{[original.file]:original.sha256,[process.execPath]:sha(process.execPath),[path.join(ROOT,'scripts/fvs-checker.mjs')]:sha(path.join(ROOT,'scripts/fvs-checker.mjs')),[path.join(ROOT,'scripts/FvsKernelAudit.lean')]:sha(path.join(ROOT,'scripts/FvsKernelAudit.lean')),[compiled]:sha(compiled)},snapshots:{runner,helper,modules:[{file:compiled,sha256:sha(compiled)}]},imports:[],discovery:phase,witness:phase,requestSha256:sealed.sha256,argv:[process.execPath,'--run',helper,baseline?'baseline':'audit',sealed.file],exit:0,signal:null,error:null,...(version===2?{execution:control,supervision}: {})}};
 return{dir,kernel,control,req,original,sealed,write:(name,v)=>json(dir,name,v)};
}
module.exports={ROOT,sha,ref,json,root,copyModule,publicationModel,kernelFixture};
