// Protocol fixture only. Genuine Beads qualification is a separate explicit lane.
const fs = require('node:fs');
const path = require('node:path');
const a = process.argv.slice(2);
const root = a[a.indexOf('-C') + 1];
const store = path.join(root, '.beads');
const controlFile = path.join(store, 'fixture-control.json');
const c = fs.existsSync(controlFile) ? JSON.parse(fs.readFileSync(controlFile)) : {};
const cmd = a.includes('--version') ? 'version' : ['where', 'info', 'memories', 'remember', 'prime'].find((x) => a.includes(x));
fs.appendFileSync(path.join(root, '.fixture-bd-calls.jsonl'), JSON.stringify({ argv: a, cmd, readonly: a.includes('--readonly'), redirected: process.env.BEADS_DIR ?? null }) + '\n');
if (c.fail === cmd) { console.error('fixture failure ' + cmd); process.exit(9); }
const emit = (v) => console.log(JSON.stringify(v));
if (cmd === 'version') console.log('bd version ' + (c.version ?? '1.3.1') + ' (fixture)');
else if (cmd === 'where') emit({ schema_version: 1, path: c.wherePath ?? store, database_path: c.databasePath ?? path.join(store, 'embeddeddolt'), prefix: 'fixture' });
else if (cmd === 'info') emit({ schema_version: 1, mode: c.mode ?? 'direct', database_path: c.databasePath ?? path.join(store, 'embeddeddolt') });
else if (cmd === 'memories') {
  if (c.badJson) process.stdout.write('{broken');
  else emit({ schema_version: 1, ...(fs.existsSync(path.join(store, 'context.txt')) ? { 'fvs-auto-project-context': fs.readFileSync(path.join(store, 'context.txt'), 'utf8') } : {}) });
} else if (cmd === 'remember') {
  if (a.includes('--readonly')) { console.error('fixture refuses readonly write'); process.exit(8); }
  if (a[a.indexOf('--key') + 1] !== 'fvs-auto-project-context') process.exit(7);
  fs.writeFileSync(path.join(store, 'context.txt'), c.wrongReadback ? 'wrong' : a[a.indexOf('--key') + 2]);
  if (c.partialRemember) process.exit(6);
  console.log('fixture remembered');
} else if (cmd === 'prime') {
  if (c.driftState) {
    const f = path.join(root, '.formalising/auto-fv/state.json');
    const s = JSON.parse(fs.readFileSync(f)); s.choicesGeneration++; fs.writeFileSync(f, JSON.stringify(s));
  }
  const output = () => {
    if (c.oversize) process.stdout.write('x'.repeat(2 * 1024 * 1024));
    else if (c.missingPrime) console.log('## No context');
    else console.log('## Persistent Memories\n\n### fvs-auto-project-context\n' + fs.readFileSync(path.join(store, 'context.txt'), 'utf8') + '\n');
  };
  if (c.timeout) setTimeout(output, 12000); else output();
} else { console.error('unknown fixture command'); process.exit(5); }
