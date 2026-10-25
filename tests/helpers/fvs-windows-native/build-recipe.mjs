// Profile-free regression for deterministic native source identity across hosts.
// Usage: node build-recipe.mjs <pwsh.exe> <new-evidence-directory>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

const [pwshArg,evidenceArg]=process.argv.slice(2);
assert(process.platform==='win32'&&pwshArg&&evidenceArg,'Windows, pwsh and a new evidence directory are required');
const pwsh=path.resolve(pwshArg),evidence=path.resolve(evidenceArg);
fs.mkdirSync(evidence);
const root=fs.mkdtempSync(path.join(path.resolve('.native-work/production-native'),'build recipe regression '));
const source=path.join(root,'source with spaces'),original=path.resolve('scripts/fvs-probe-native/windows');
fs.mkdirSync(source);
const names=['NativeMethods.cs','NativeExtra.cs','VerifiedPrivateLeafCleanup.cs','FvsWindowsLauncher.cs','WindowsLifecycle.cs'];
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex'),fileHash=file=>hash(fs.readFileSync(file));
const sourceRecords=names.map(name=>({file:name,sha256:fileHash(path.join(original,name))}));
for(const name of [...names,'Build-Launcher.ps1'])fs.copyFileSync(path.join(original,name),path.join(source,name),fs.constants.COPYFILE_EXCL);
const expected=hash([...sourceRecords].sort((a,b)=>a.file<b.file?-1:a.file>b.file?1:0).map(item=>item.file+'\0'+item.sha256+'\n').join(''));
const script=path.join(source,'Build-Launcher.ps1'),recipeSha256=fileHash(script),windowsPowerShell=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
const checks=[];
for(const mode of ['direct','inline-1','inline-2']){
 const output=path.join(root,mode+' release');
 const command=mode==='direct'?pwsh:windowsPowerShell;
 const args=mode==='direct'?['-NoProfile','-NonInteractive','-File',script,'-OutputDirectory',output]
  :['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop';& ([scriptblock]::Create([IO.File]::ReadAllText($env:FVS_BUILD_RECIPE))) -SourceDirectory $env:FVS_BUILD_SOURCE -OutputDirectory $env:FVS_BUILD_OUTPUT"];
 const environment={...process.env,FVS_BUILD_RECIPE:script,FVS_BUILD_SOURCE:source,FVS_BUILD_OUTPUT:output};
 // PowerShell 7's inherited module path does not identify Windows PowerShell's
 // Utility module. The setup host also supplies an explicit native environment.
 if(mode!=='direct'){
  for(const key of Object.keys(environment))if(key.toLowerCase()==='psmodulepath')delete environment[key];
  environment.PSModulePath=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/Modules');
 }
 const result=spawnSync(command,args,{encoding:'utf8',windowsHide:true,env:environment});
 fs.writeFileSync(path.join(evidence,mode+'.stdout.log'),result.stdout??'');fs.writeFileSync(path.join(evidence,mode+'.stderr.log'),result.stderr??'');
 assert.equal(result.status,0,result.stderr);
 const file=path.join(output,'fvs-windows-launcher.build.json'),receipt=JSON.parse(fs.readFileSync(file,'utf8'));
 assert.equal(receipt.sourceSetSha256,expected);assert.equal(receipt.testHooks,false);
 assert.equal(receipt.recipeSha256,recipeSha256);assert.deepEqual(receipt.sources,sourceRecords);
 assert.equal(receipt.launcherSha256,fileHash(receipt.launcher));
 assert.equal(receipt.protocol,'fvs/windows-native/v2');assert.equal(receipt.target,'windows-x64');
 fs.copyFileSync(file,path.join(evidence,mode+'.build.json'),fs.constants.COPYFILE_EXCL);
 checks.push({mode,passed:true,sourceSetSha256:receipt.sourceSetSha256,testHooks:receipt.testHooks,launcherSha256:receipt.launcherSha256,buildReceiptSha256:fileHash(file),compilerSha256:receipt.compilerSha256});
 console.log('PASS '+mode);
}
for(const record of sourceRecords)assert.equal(fileHash(path.join(original,record.file)),record.sha256);
const report={schema:'fvs/windows-native-build-recipe-tests/v1',profileFree:true,sourceDirectoryHasSpaces:true,sourceSetAlgorithm:'Ordinal filename strings; filename+NUL+lowercase file SHA256+LF; UTF8 SHA256',sourceSetSha256:expected,recipeSha256,sourceRecords,checks,finishedAt:new Date().toISOString()};
const summary=path.join(evidence,'summary.json');fs.writeFileSync(summary,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({summary,sha256:fileHash(summary),sourceSetSha256:expected,recipeSha256,passed:checks.length}));
