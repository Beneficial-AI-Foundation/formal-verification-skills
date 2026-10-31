'use strict';
// Qualification-only OS timing/fault injection. Proof inputs/results are untouched.
const fs = require('node:fs');
const path = require('node:path');
const store = process.env.FVS_TEST_STORE;
const mode = process.env.FVS_TEST_PUBLICATION;
if (store && ['barrier', 'crash', 'rename-failure'].includes(mode)) {
  const originalMkdir = fs.mkdirSync, originalRename = fs.renameSync;
  if (mode === 'rename-failure') {
    fs.renameSync = function (from, to) {
      if (path.dirname(String(to)) === path.join(store, 'records') && path.basename(String(from)).startsWith('.tmp-')) throw new Error('qualification interrupted rename');
      return originalRename.apply(this, arguments);
    };
  } else {
    fs.mkdirSync = function (target) {
      if (String(target) === path.join(store, 'lock')) {
        const gate = process.env.FVS_TEST_GATE, token = process.env.FVS_TEST_TOKEN;
        fs.writeFileSync(path.join(gate, token + '.ready'), JSON.stringify({ pid: process.pid, at: Date.now(), mode }) + '\n', { flag: 'wx' });
        if (mode === 'crash') process.exit(86);
        while (!fs.existsSync(path.join(gate, 'release'))) {
          if (Date.now() >= Number(process.env.FVS_TEST_GATE_DEADLINE)) throw new Error('qualification publication barrier timed out');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
        }
      }
      return originalMkdir.apply(this, arguments);
    };
  }
}
