#!/usr/bin/env node
'use strict';

const { readdirSync } = require('fs');
const { join } = require('path');
const { execFileSync } = require('child_process');

const testsDir = join(__dirname, '..', 'tests');
const files = readdirSync(testsDir)
  .filter(f => f.endsWith('.test.cjs'))
  .sort()
  .map(f => join(testsDir, f));

if (files.length === 0) {
  console.error('No test files found in tests/');
  process.exit(1);
}

try {
  execFileSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
} catch {
  process.exit(1);
}
