'use strict';
const {it} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname,'..');
const read = name => fs.readFileSync(path.join(ROOT,name),'utf8');
const families = ['lean-specify','lean-verify','lean-formalise','lean-refactor','crypto-execute','model-external'];
it('provides a practical source-cited Lake guide without measured claims', () => {
  assert.ok(fs.existsSync(path.join(ROOT,'fv-skills/references/lake-build.md')), 'Lake reference must exist');
  const guide = read('fv-skills/references/lake-build.md').replace(/\s+/g,' ');
  for (const fragment of ['<overview>','<quick_reference>','<patterns>','<anti_patterns>', '551c61ba0263a59279ffaa892d2927b269e713c9','4.34.1','v4.31.0','v4.33.1','[@[<package>]/][<target>|[+]<module>][:<facet>]', '@a/b','@a/+A:c','Foo/Bar.lean:o',':olean','leanArts',':static',':shared','lake env','does not build imports','lake-manifest.json','lean-toolchain','LAKE_CACHE_DIR','Mathlib','intentional dependency change','ONE simultaneous compiler','TWO threads','nice19','ALL descendants','UNRUN','operator-postrelease','configured default targets','final project/style/trust']) assert.ok(guide.includes(fragment), fragment);
});
it('loads installed-root content before actual child prompts in all six pairs', () => {
  for (const family of families) {
    for (const dir of ['commands/fvs','fv-skills/workflows']) {
      const file=`${dir}/${family}.md`, text=read(file);
      const loader=text.indexOf('LAKE_BUILD_GUIDE=$(cat ~/.claude/fv-skills/references/lake-build.md)');
      assert.ok(loader>=0,`${file} installed loader`);
      const prompts=[...text.matchAll(/prompt="([\s\S]*?)"\s*\)/g)].map(m=>({at:m.index,body:m[1]}));
      if (prompts.length) for (const prompt of prompts) {
        assert.ok(loader<prompt.at, `${file} load before dispatch`);
        assert.equal((prompt.body.match(/<lake_build_guide>/g)||[]).length,1, `${file} exactly one guide per prompt`);
        assert.match(prompt.body,/<lake_build_guide>\s*\$LAKE_BUILD_GUIDE\s*<\/lake_build_guide>/);
      }
      else if (family==='model-external' && dir==='commands/fvs') {
        assert.match(text,/Follow the workflow[\s\S]*forward the loaded `LAKE_BUILD_GUIDE`/);
      } else {
        const blocks=[...text.matchAll(/```text\n([\s\S]*?)```/g)].filter(m=>m[1].includes('<proof_engineering_context>')||m[1].includes('<external_modeler_prompt'));
        assert.ok(blocks.length>=2,`${file} actual mode prompts`);
        for(const block of blocks) assert.match(block[1],/<lake_build_guide>\s*\$LAKE_BUILD_GUIDE\s*<\/lake_build_guide>/);
      }
    }
  }
});
it('portable plugin and Pi renderers keep the loader-to-prompt content chain', () => {
  const {renderPluginSkill,renderPiSkill}=require('../scripts/build-plugin.cjs');
  for(const family of families) for(const render of [renderPluginSkill,renderPiSkill]) {
    const text=render(path.join(ROOT,'commands/fvs',family+'.md'),family);
    assert.ok(!text.includes('cat ~/.claude/fv-skills/references/lake-build.md'));
    assert.match(text,/LAKE_BUILD_GUIDE=\$\(cat [^\n]*fv-skills\/references\/lake-build\.md/);
    if(family!=='model-external') assert.match(text,/<lake_build_guide>\s*\$LAKE_BUILD_GUIDE/);
  }
});
it('reference links preserve read-only reviewer and skill inventories', () => {
  for(const name of ['aeneas-patterns','lean-refactoring','review-diagnostics']) assert.ok(read(`fv-skills/references/${name}.md`).includes('(lake-build.md)'));
  assert.match(read('fv-skills/references/review-diagnostics.md'),/read-only|read.only/);
  for(const [directory,count] of [['agents',14],['fv-skills/workflows',21]]) assert.equal(fs.readdirSync(path.join(ROOT,directory)).filter(n=>n.endsWith('.md')).length,count);
});
it('optional preflight refuses incomplete and synthetic qualification before loading tools', () => {
  assert.ok(fs.existsSync(path.join(ROOT,'tests/helpers/lake-reference-live.cjs')),'guarded preflight exists');
  const {preflight}=require('./helpers/lake-reference-live.cjs');
  for(const data of [null,{}, {permission:true}, {tools:{lean:'/fake',lake:'/fake'},controls:{oneCompiler:true,twoThreads:true,nice19:true}}]) {
    const result=preflight(data);
    assert.equal(result.status,'BLOCKED');
    assert.equal(result.operations,0);
    assert.ok(result.reason);
  }
  // This synthetic packet contains plain text, NOT executable tools or real control proof.
  const os=require('node:os'), crypto=require('node:crypto');
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'fvs-lake-preflight-synthetic-'));
  const input=path.join(root,'plain-data.txt'); fs.writeFileSync(input,'synthetic data only\n');
  const row={path:input,bytes:fs.statSync(input).size,sha256:crypto.createHash('sha256').update(fs.readFileSync(input)).digest('hex')};
  const q={operation:'synthetic-never-authorized',permissionEvidence:row,root,tools:{},dynamicLibraries:[row],source:{toolchain:row,manifest:row,configuration:row},environment:{},evidence:{}};
  for(const name of ['lean','lake','nativeCompiler','linker']) q.tools[name]={...row,version:'synthetic',origin:'plain-text-test-data'};
  for(const name of ['HOME','TMPDIR','toolHome','cacheHome']) {const p=path.join(root,name); fs.mkdirSync(p); q.environment[name]=p;}
  for(const name of ['osConfinement','oneCompiler','twoThreads','nice19AllDescendants','cacheControls','lifecycle']) q.evidence[name]={...row,source:'synthetic-not-source-qualification',operation:q.operation};
  assert.match(preflight(q).reason,/unsupported real whole-chain control/);
  for(const name of Object.keys(q.evidence)) {const broken=structuredClone(q); delete broken.evidence[name]; assert.match(preflight(broken).reason,new RegExp(name));}
  const mismatch=structuredClone(q); mismatch.tools.lean.sha256='0'.repeat(64); assert.match(preflight(mismatch).reason,/digest mismatch/);
  const unsafe=structuredClone(q); unsafe.environment.HOME=ROOT; assert.match(preflight(unsafe).reason,/owned HOME/);
  const source=read('tests/helpers/lake-reference-live.cjs');
  assert.ok(!/require\(['"]node:child_process|spawn\(|execFile\(/.test(source), 'no execution bypass');
});
