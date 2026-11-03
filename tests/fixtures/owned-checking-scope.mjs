// Real known-PGID unit fixture; no Lean, AO, proof receipt or hostile-host claim.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {runOwned,createExecution,conclusiveOwnedSupervision} from '../../scripts/fvs-execution.mjs';
const [mode,root]=process.argv.slice(2),stop=path.join(root,'stop'),preflight=mode.startsWith('preflight-'),scenario=preflight?'clean':mode;
const control=createExecution('owned-group-unit',mode==='preflight-deadline'?{kind:'deadline',deadlineMs:100}:{kind:'none'}),c=new AbortController();
let now=0,observerHashes=0,changed=false,spawns=0,issued=0;
const open=fs.openSync,read=fs.readSync,close=fs.closeSync,observer=fs.realpathSync('/bin/ps'),observerFds=new Set();
if(preflight){
 fs.openSync=function(file,...args){const fd=open.call(fs,file,...args);if(file===observer)observerFds.add(fd);return fd;};
 fs.closeSync=function(fd){observerFds.delete(fd);return close.call(fs,fd);};
 fs.readSync=function(fd,...args){const n=read.call(fs,fd,...args);if(observerFds.has(fd)&&n===0&&++observerHashes===2){changed=true;now=12*3600000;if(mode==='preflight-cancel')c.abort();}return n;};
}
const preflightFacts=()=>({changed,observerHashes,now,spawns,issued});
const grandchild='const fs=require("node:fs");setInterval(()=>{if(fs.existsSync('+JSON.stringify(stop)+'))process.exit(0)},20);setTimeout(()=>process.exit(89),8000);';
const terminal=path.join(root,'grandchild-terminal.json');
const parent=scenario==='clean'?'const{spawn}=require("node:child_process"),fs=require("node:fs");const child=spawn(process.execPath,["-e","process.exit(0)"],{stdio:"ignore"});child.once("close",(exitCode,signal)=>{fs.writeFileSync('+JSON.stringify(terminal)+',JSON.stringify({pid:child.pid,exitCode,signal}));if(exitCode!==0||signal!==null)process.exit(91);process.stdout.write("done");});':scenario==='cancel-clean'?'process.stdout.write("ready");setInterval(()=>{},1000);setTimeout(()=>process.exit(89),8000);':
 'const{spawn}=require("node:child_process"),fs=require("node:fs");const child=spawn(process.execPath,["-e",'+JSON.stringify(grandchild)+'],{stdio:"ignore"});fs.writeFileSync('+JSON.stringify(path.join(root,'grandchild-pid'))+',String(child.pid));child.unref();'+(scenario==='late'?'process.exit(0);':'process.stdout.write("ready");setInterval(()=>{},1000);setTimeout(()=>process.exit(89),8000);');
let result;
try{
 try{result=await runOwned([process.execPath,'-e',parent],{cwd:root,env:{PATH:path.dirname(process.execPath)+':/usr/bin:/bin',LANG:'C'},maxBuffer:1024*1024},control,{inheritGroup:true,signal:c.signal,now:()=>now,onSpawn(){issued++;},spawnProcess(file,args,options){spawns++;const child=spawn(file,args,options);if(scenario.startsWith('cancel'))child.stdout.once('data',()=>c.abort());return child;}});}
 catch(error){if(!preflight)throw error;const refusal={error:{code:error.code,message:error.message},preflight:preflightFacts()};fs.writeFileSync(path.join(root,'native-refusal.json'),JSON.stringify(refusal,null,2));console.log(JSON.stringify(refusal));}
 if(result){
 const serialized={pid:result.pid,status:result.status,signal:result.signal,cancelled:result.cancelled,timedOut:result.timedOut,cleanupComplete:result.cleanupComplete,cleanup:result.cleanup,...(scenario==='clean'?{terminalGrandchild:JSON.parse(fs.readFileSync(terminal,'utf8'))}:{}),...(preflight?{preflight:preflightFacts()}:{})};
 fs.writeFileSync(path.join(root,'native-result.json'),JSON.stringify(serialized,null,2));
 console.log(JSON.stringify({...serialized,conclusive:conclusiveOwnedSupervision({cancelled:result.cancelled,timedOut:result.timedOut,cleanupComplete:result.cleanupComplete,cleanup:result.cleanup})}));
 }
}finally{fs.openSync=open;fs.readSync=read;fs.closeSync=close;fs.writeFileSync(stop,'stop');await new Promise(done=>setTimeout(done,200));}
