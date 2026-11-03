// Real known-PGID unit fixture; no Lean, AO, proof receipt or hostile-host claim.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {runOwned,createExecution,conclusiveOwnedSupervision} from '../../scripts/fvs-execution.mjs';
const [mode,root]=process.argv.slice(2),stop=path.join(root,'stop'),control=createExecution('owned-group-unit',{kind:'none'}),c=new AbortController();
const grandchild='const fs=require("node:fs");setInterval(()=>{if(fs.existsSync('+JSON.stringify(stop)+'))process.exit(0)},20);setTimeout(()=>process.exit(89),8000);';
const terminal=path.join(root,'grandchild-terminal.json');
const parent=mode==='clean'?'const{spawn}=require("node:child_process"),fs=require("node:fs");const child=spawn(process.execPath,["-e","process.exit(0)"],{stdio:"ignore"});child.once("close",(exitCode,signal)=>{fs.writeFileSync('+JSON.stringify(terminal)+',JSON.stringify({pid:child.pid,exitCode,signal}));if(exitCode!==0||signal!==null)process.exit(91);process.stdout.write("done");});':mode==='cancel-clean'?'process.stdout.write("ready");setInterval(()=>{},1000);setTimeout(()=>process.exit(89),8000);':
 'const{spawn}=require("node:child_process"),fs=require("node:fs");const child=spawn(process.execPath,["-e",'+JSON.stringify(grandchild)+'],{stdio:"ignore"});fs.writeFileSync('+JSON.stringify(path.join(root,'grandchild-pid'))+',String(child.pid));child.unref();'+(mode==='late'?'process.exit(0);':'process.stdout.write("ready");setInterval(()=>{},1000);setTimeout(()=>process.exit(89),8000);');
let result;
try{
 result=await runOwned([process.execPath,'-e',parent],{cwd:root,env:{PATH:path.dirname(process.execPath)+':/usr/bin:/bin',LANG:'C'},maxBuffer:1024*1024},control,{inheritGroup:true,signal:c.signal,spawnProcess(file,args,options){const child=spawn(file,args,options);if(mode.startsWith('cancel'))child.stdout.once('data',()=>c.abort());return child;}});
 const serialized={pid:result.pid,status:result.status,signal:result.signal,cancelled:result.cancelled,timedOut:result.timedOut,cleanupComplete:result.cleanupComplete,cleanup:result.cleanup,...(mode==='clean'?{terminalGrandchild:JSON.parse(fs.readFileSync(terminal,'utf8'))}:{})};
 fs.writeFileSync(path.join(root,'native-result.json'),JSON.stringify(serialized,null,2));
 console.log(JSON.stringify({...serialized,conclusive:conclusiveOwnedSupervision({cancelled:result.cancelled,timedOut:result.timedOut,cleanupComplete:result.cleanupComplete,cleanup:result.cleanup})}));
}finally{fs.writeFileSync(stop,'stop');await new Promise(done=>setTimeout(done,200));}
