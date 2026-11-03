// Layered protocol fixture: AO/Beads are doubles and release verification is supplied by test code.
const fs=require('node:fs'),path=require('node:path');
const f=require('./resume-fixture.cjs');
async function fixture(auto,t,policy={}){
 const e=await import('../../scripts/fvs-execution.mjs');
 const x=f.fixture(auto,undefined,null,{schemaVersion:2,...policy});
 const view=auto.readState({projectRoot:x.root,requireAgreement:true}),agreement=JSON.parse(JSON.stringify(view.agreement.agreement));
 for(const k of ['contextSha256','recordedAt'])delete agreement[k];agreement.payload.contextVersion++;
 agreement.payload.execution={actions:['fixture delegated work'],reference:'fixture:grant'};agreement.approvedPayloadSha256=auto.agreementPayloadSha256(agreement);
 fs.writeFileSync(f.roadmapFile(x.root),'## Decisions\n```fvs-auto-agreement\n'+JSON.stringify(agreement)+'\n```\n');auto.recordAgreement({projectRoot:x.root,agreement,confirmOverwrite:true});
 x.canonical=()=>{const view=auto.readState({projectRoot:x.root,requireAgreement:true});return{view,envelope:view.agreement.agreement};};
 const current=x.canonical();x.project={id:'fixture-project',path:x.root,agent:'fixture',config:{worker:{agent:'fixture',agentConfig:{model:'fixture'}}}};
 const control=x.writeControl;x.writeControl=(extra={})=>control({project:x.project,...extra});x.writeControl();x.profileObservation=t.redactAOProfile(Buffer.from(JSON.stringify({project:x.project})));
 x.auth=f.json(x.owned,'auth',{schema:'fvs/auto-action-authorization',schemaVersion:1,agreementContextSha256:current.view.agreement.contextSha256,approvedPayloadSha256:agreement.approvedPayloadSha256,execution:agreement.payload.execution,correspondence:['construct','launch','prepare-input','release','terminate','compose-spec','materialize-proof','registry-revise','freeze','check','accept','handoff'].map(kind=>({kind,action:'fixture delegated work',reference:'fixture:grant'}))});
 x.profile=f.json(x.owned,'profile',{schema:'fvs/auto-stage-profile',schemaVersion:1,source:'protocol fixture not effective model attestation',controller:x.profileObservation,stages:Object.fromEntries(['extraction','specification','review','proof','reconcile','integration','check','acceptance','research','fc_spec','spec_review','fc_proof_plan','fc_proof_execution'].map(role=>[role,{harness:'fixture',model:'fixture',effort:'fixture',provenance:'fixture'}]))});
 x.initial=x.invoke();x.run=()=>auto.readRuntimeState({projectRoot:x.root}).state.run;
 x.clock=()=>{const v=auto.readRuntimeState({projectRoot:x.root});return{runId:x.runId,schemaVersion:2,budget:v.state.run.budget,startedAtMs:v.state.run.startedAtMs,lastObservedAtMs:v.lastObservedAtMs};};
 x.snapshot=(q=x.request())=>t.transitionSnapshot({q,run:x.run(),canonical:x.canonical(),observation:x.initial.result.observation,action:{before:{registry:null},target:{},authorization:x.auth,profile:x.profile}},{profileObservation:x.profileObservation});
 x.action=(kind,target,stage='extraction')=>{
  const intent=x.local([],stage),q=x.request();
  const a={schema:'fvs/auto-transition-request',schemaVersion:2,runId:x.runId,transitionId:intent.transitionId,reservationId:intent.reservationId,kind,stage,nodes:intent.nodes,owner:intent.owner,expectedHeadSha256:q.expectedHeadSha256,before:x.snapshot(q),target,authorization:x.auth,profile:x.profile,basis:null};
  const ref=f.json(x.owned,'action',a);intent.request=ref;q.transition=x.before(intent);return{a,ref,q,intent};
 };
 x.startup=()=>{
  const startup={challenge:f.uuid(),attemptId:f.uuid(),phase:'resume',resumeId:f.uuid()};
  const invocation=f.json(x.owned,'invocation',{schema:'fvs/auto-proof-invocation',schemaVersion:2,runId:x.runId,invocationId:f.uuid(),execution:e.runControl(x.run())});
  const action=x.action('launch',{projectId:'fixture-project',branchRef:'refs/heads/fixture-stage',assignmentId:f.uuid(),selectionStage:'fc_proof_execution',invocation,startup,resumeOf:null},'proof');
  const actor={projectId:'fixture-project',sessionId:'owned-worker',reservationId:action.a.reservationId,assignmentId:action.a.target.assignmentId,worktree:{path:x.root,gitDir:path.join(x.root,'.git'),gitCommonDir:path.join(x.root,'.git'),branchRef:f.git(x.root,'symbolic-ref','HEAD'),commit:f.git(x.root,'rev-parse','HEAD'),tree:f.git(x.root,'rev-parse','HEAD^{tree}'),dirty:false},profile:null};
  const caller={attemptId:startup.attemptId,phase:startup.phase,target:{projectId:actor.projectId,sessionId:actor.sessionId,resumeId:startup.resumeId}};
  const request=policy.memory==='beads'?auto.prepareMemoryRequest({projectRoot:x.root,...caller,operation:'worker-readonly'}):t.disabledWorkerMemoryRequest(action.a.before.fixed,caller);
  const memoryOut=policy.memory==='beads'?x.out():null;if(memoryOut)auto.primeMemory({projectRoot:x.root,callerRoot:x.root,request,out:memoryOut});
  const before='d'.repeat(64),ack=f.json(x.owned,'ack',{schema:'fvs/auto-startup-ack',schemaVersion:2,runId:x.runId,actionSha256:memoryHash(action.a),beforeEventSha256:before,challenge:startup.challenge,actor,memoryRequest:request,memoryOut,memoryEvidence:t.workerMemoryEvidence(memoryOut,request,action.a.before.fixed),waiting:true});
  const acknowledgement=ack;
  let memoryCalls=0;const services={memoryOut,beforeForAction:()=>before,verifyMemory(o){memoryCalls++;return auto.verifyMemoryBootstrap({...o,projectRoot:x.root});},observeActor:a=>a,currentClock:x.clock,verifyReleasedPacket:()=>({clock:{...x.clock(),observedAtMs:Date.now()}})};
  return{action,actor,request,memoryOut,acknowledgement,services,memoryCalls:()=>memoryCalls};
 };
 x.packet=()=>{
  const s=x.startup(),caller={attemptId:f.uuid(),phase:'resume',target:{projectId:s.actor.projectId,sessionId:s.actor.sessionId,resumeId:f.uuid()}};
  s.request=policy.memory==='beads'?auto.prepareMemoryRequest({projectRoot:x.root,...caller,operation:'worker-readonly'}):t.disabledWorkerMemoryRequest(s.action.a.before.fixed,caller);
  s.memoryOut=policy.memory==='beads'?x.out():null;if(s.memoryOut)auto.primeMemory({projectRoot:x.root,callerRoot:x.root,request:s.request,out:s.memoryOut});s.services.memoryOut=s.memoryOut;
  s.packet=f.json(x.owned,'packet',{schema:'fvs/auto-work-packet',schemaVersion:2,runId:x.runId,actionSha256:memoryHash(s.action.a),launch:s.action.ref,beforeEventSha256:s.services.beforeForAction(),challenge:f.uuid(),actor:s.actor,deliveryHandle:'release-'+f.uuid(),memoryRequest:s.request,procedure:'lean-verify/controller-direct',inputs:[s.action.a.target.invocation],resumeOf:null,startMarker:path.join(x.owned,'start-'+f.uuid()+'.json')});s.marker=t.readWorkPacket(s.packet).startMarker;return s;
 };
 return x;
}
let memoryHash;const ready=import('../../scripts/fvs-project-memory.mjs').then(m=>{memoryHash=m.memoryHash;});
module.exports={...f,fixture:async(...args)=>{await ready;return fixture(...args);}};
