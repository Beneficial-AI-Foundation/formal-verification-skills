// Current qualification is independent of the retained historical success.
const {before,test}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'..'),fixture='tests/fixtures/windows-source-v1.json';
const read=f=>fs.readFileSync(path.join(root,f)),json=f=>JSON.parse(read(f));
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
let gate,policy,evidence,compatibility,release;
before(async()=>{
  ({WINDOWS_SOURCE_QUALIFICATION:gate}=await import(pathToFileURL(path.join(root,'scripts/fvs-probe-windows-qualification.mjs'))));
  policy=(await import(pathToFileURL(path.join(root,'scripts/fvs-probe-windows-runtime.mjs')))).getWindowsSourcePolicy();
  ({PROBE_RELEASE:release}=await import(pathToFileURL(path.join(root,'scripts/fvs-probe-inventory.mjs'))));
  evidence=json(fixture);compatibility=json('tests/fixtures/probe-compatibility.json');
});
test('current gate binds the changed policy without inheriting historical qualification',()=>{
  assert.equal(evidence.schema,'fvs/windows-source-compatibility/v2');
  assert.equal(gate.qualified,evidence.status==='passed');
  assert.equal(gate.policySha256,policy.sha256);
  assert.equal(evidence.distribution.policySha256,policy.sha256);
  assert.deepEqual(gate.evidence,{path:fixture,sha256:sha(read(fixture))});
  const receipt=compatibility.sourceReceipts[gate.id];
  assert.equal(receipt.policySha256,policy.sha256);
  assert.deepEqual(receipt.evidence,gate.evidence);
  assert.equal(receipt.status,evidence.status);
  assert.equal(policy.qualified,false);
  if(!gate.qualified){assert.equal(evidence.status,'unqualified');assert(evidence.remainingGates.length>0);}
  else assert.deepEqual(evidence.remainingGates,[]);
});
test('old successful evidence remains byte-identical and explicitly historical',()=>{
  assert.equal(evidence.historical.reviewedHead,'7ad374bd124951017ac0f047af0ac84764e17c27');
  assert.equal(evidence.historical.sha256,'54e7f395dd87b9cb982f460f2f43718b6b6c5234bee253918857bf6c0b6ec8ba');
  assert.equal(sha(read(evidence.historical.path)),evidence.historical.sha256);
  const old=json(evidence.historical.path);assert.equal(old.status,'passed');
  assert.notEqual(old.distribution.policySha256,policy.sha256);
  assert.deepEqual(compatibility.historicalSourceReceipts['windows-source-v1@7ad374b'].evidence,{path:evidence.historical.path,sha256:evidence.historical.sha256});
});
test('current source and generated identities match the evidence',()=>{
  assert.deepEqual(evidence.source.policyFiles,policy.sourceFiles);
  assert.deepEqual(evidence.source.sources,policy.sources);
  for(const group of ['modules','packagedModules','nativeSources'])for(const item of evidence.source[group]){
    assert(!path.isAbsolute(item.file)&&!item.file.split('/').includes('..'));
    assert.equal(sha(read(item.file)),item.sha256,item.file);
  }
  for(const item of evidence.source.modules)assert.equal(evidence.source.packagedModules.find(x=>x.file==='plugins/fvs/'+item.file)?.sha256,item.sha256);
  assert.deepEqual(read('scripts/fvs-probe-windows-qualification.mjs'),read('plugins/fvs/scripts/fvs-probe-windows-qualification.mjs'));
  const native=evidence.source.nativeSources.map(x=>({name:path.basename(x.file),sha256:x.sha256})).sort((a,b)=>a.name<b.name?-1:1);
  assert.equal(native.length,5);
  assert.equal(sha(native.map(x=>x.name+'\0'+x.sha256+'\n').join('')),evidence.source.nativeSourceSetSha256);
});
test('new native regressions identify the tested sources and completed checks',()=>{
  assert(evidence.validation.native.length>0);
  for(const suite of evidence.validation.native){
    assert.equal(suite.ok,true);assert.equal(suite.sourceSetSha256,evidence.source.nativeSourceSetSha256);
    assert.equal(suite.testHooks,true);
    for(const key of ['sha256','launcherSha256','canarySha256','harnessSha256'])assert.match(suite[key],/^[a-f0-9]{64}$/);
    assert(suite.checks.length>0&&suite.checks.every(x=>x.passed));
  }
  const review=evidence.validation.native.find(x=>x.mode==='review-regressions');assert.equal(review.checks.length,8);
  for(const word of ['writable','readonly w','copied','child','hardlink'])assert(review.checks.some(x=>x.name.includes(word)),word);
});
function qualifiedTest(name,check){test(name,t=>{if(!gate.qualified){t.skip('Changed implementation has no completed production qualification');return;}check();});}
test('recorded setup results distinguish fresh-build conflict from authenticated reuse',()=>{
  const {fresh,reviewed,reused,reconfigured}=evidence.validation.setup;
  assert.equal(fresh.policySha256,policy.sha256);assert.equal(fresh.helperBuildsComplete,true);
  assert.equal(fresh.externalArtifactCache,false);assert.equal(fresh.helpers.length,5);
  assert(fresh.helpers.every(x=>x.origin==='fresh-source-build'));
  if(!fresh.ok){
    assert.equal(fresh.status,'blocked-helper-conflict');assert.equal(gate.qualified,false);
    for(const key of ['stageRemoved','journalRemoved','markerRemoved','currentPreserved','matchesPreviousRegisteredInstallation'])assert.equal(fresh.recovery[key],true);
    assert.equal(fresh.recovery.exitCode,0);
  }
  for(const setup of [reviewed,reused,reconfigured]){
    assert.equal(setup.ok,true);assert.equal(setup.policySha256,policy.sha256);
    assert.equal(setup.launcherTestHooks,false);assert.equal(setup.helpers.length,5);
  }
  assert.equal(reviewed.externalArtifactCache,true);assert(reviewed.helpers.every(x=>x.origin==='reviewed-existing-artifact'));
  for(const [setup,previous,receiptSha256]of [[reused,reviewed,reviewed.receipt.sha256],[reconfigured,reused,reused.receiptSha256]]){
    assert.equal(setup.externalArtifactCache,false);
    for(const helper of setup.helpers){assert.equal(helper.reusedFrom.installationId,previous.installationId);assert.equal(helper.reusedFrom.receiptSha256,receiptSha256);}
  }
  assert.notEqual(reconfigured.projectInputsSha256,reused.projectInputsSha256);
});
test('available production evidence binds the current release launcher and confirmed cleanup',()=>{
  for(const run of [evidence.validation.normal,evidence.validation.denial].filter(Boolean)){
    assert.equal(run.ok,true);assert.equal(run.policySha256,policy.sha256);assert.equal(run.launcherTestHooks,false);
    assert.equal(run.launcherSourceSetSha256,evidence.source.nativeSourceSetSha256);
    assert.match(run.launcherSha256,/^[a-f0-9]{64}$/);assert.match(run.evidence.sha256,/^[a-f0-9]{64}$/);
    for(const key of ['jobDrained','protectedResourcesUnchanged','profileAbsent','stageRemoved'])assert.equal(run[key],true);
    assert.equal(run.cleanup.length,2);
    for(const receipt of run.cleanup){assert.match(receipt.sha256,/^[a-f0-9]{64}$/);assert.equal(receipt.exactAclsRestored,true);}
  }
  const denial=evidence.validation.denial;
  assert.equal(denial.installAttemptObserved,true);assert.equal(denial.installDenied,true);assert.equal(denial.graphAccepted,false);
  const normal=evidence.validation.normal;
  if(normal){
    assert.equal(normal.route,'commands');assert.equal(normal.canonicalFunctions,279);assert.equal(normal.charonJoins,189);
    assert.equal(normal.completeCanonicalBaselineEqual,true);assert(normal.graphBytes>0);
    assert.equal(normal.upstreamSorryWarnings,8);assert.equal(normal.missingLeanReferences,47);assert.equal(normal.missingLeanKeys,22);
    assert.equal(normal.projectRoot,evidence.validation.setup.reconfigured.project.projectRoot);assert.equal(evidence.validation.setup.reconfigured.resolvedAndExecuted,true);
  }
});
qualifiedTest('enabled qualification requires fresh, repeated and changed-project setup',()=>{
  const {fresh,reused,reconfigured}=evidence.validation.setup;
  for(const setup of [fresh,reused,reconfigured]){assert.equal(setup.ok,true);assert.equal(setup.policySha256,policy.sha256);assert.equal(setup.launcherTestHooks,false);assert.equal(setup.helpers.length,5);}
  assert(fresh.helpers.every(x=>x.origin==='fresh-source-build'&&!x.reusedFrom));
  assert.equal(reused.externalArtifactCache,false);
  assert(reused.helpers.every(x=>x.reusedFrom.installationId===fresh.installationId));
  assert.notEqual(reconfigured.projectInputsSha256,reused.projectInputsSha256);
  assert.equal(reconfigured.resolvedAndExecuted,true);
});
qualifiedTest('enabled qualification requires a cleaned normal-command graph and real installation denial',()=>{
  const {normal,denial}=evidence.validation;
  assert.equal(normal.ok,true);assert.equal(normal.route,'commands');assert.equal(normal.launcherTestHooks,false);
  assert.equal(normal.canonicalFunctions,279);assert.equal(normal.charonJoins,189);
  assert.equal(normal.completeCanonicalBaselineEqual,true);assert(normal.graphBytes>0);
  assert.equal(normal.upstreamSorryWarnings,8);assert.equal(normal.missingLeanReferences,47);assert.equal(normal.missingLeanKeys,22);
  for(const run of [normal,denial])for(const key of ['jobDrained','protectedResourcesUnchanged','profileAbsent','stageRemoved'])assert.equal(run[key],true);
  assert.equal(denial.installAttemptObserved,true);assert.equal(denial.installDenied,true);assert.equal(denial.graphAccepted,false);
});
test('source changes do not alter or relabel the official Windows archive',()=>{
  const official=release.assets['x86_64-pc-windows-msvc'];
  assert.equal(official.supported,false);assert.equal(official.assetId,554534285);
  assert.equal(official.archiveSha256,'91ebd551073d0f705fdf905185e8d82224c53909f22ef774c231aa411000a2dc');
  assert.equal(official.executableSha256,'68a131d2c8bb02b23e17cd8d99f5d1de059a7adb2f4ff1ba52fd8b635f5c4c77');
  assert.deepEqual(official,compatibility.release.assets['x86_64-pc-windows-msvc']);
});
