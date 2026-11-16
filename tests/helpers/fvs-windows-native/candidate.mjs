// Make a private release candidate for native acceptance. The shipped gate is
// unchanged; only the candidate's ordinary qualification metadata is prospective.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const [sourceArg, destinationArg, evidenceArg] = process.argv.slice(2);
assert(sourceArg && destinationArg && evidenceArg,
  'Usage: node candidate.mjs <generated-plugin> <new-private-candidate> <new-evidence.json>');
const source = fs.realpathSync(path.resolve(sourceArg));
const canonicalNew = file => path.join(fs.realpathSync(path.dirname(path.resolve(file))), path.basename(file));
const destination = canonicalNew(destinationArg), evidence = canonicalNew(evidenceArg);
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
};
assert(!inside(source, destination), 'Candidate destination must be outside the shipped package');
assert(!inside(source, evidence) && !inside(destination, evidence), 'Evidence must be outside both package trees');
assert(!fs.existsSync(destination), 'Candidate destination must be new');
assert(!fs.existsSync(evidence), 'Candidate evidence must be new');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function inventory(root, relative = '') {
  const result = [];
  for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
    const item = path.join(relative, name), file = path.join(root, item), stat = fs.lstatSync(file);
    assert(!stat.isSymbolicLink(), `Package alias: ${file}`);
    if (stat.isDirectory()) result.push(...inventory(root, item));
    else {
      assert(stat.isFile() && stat.nlink === 1, `Package special or linked file: ${file}`);
      result.push({ path: item.replaceAll('\\', '/'), sha256: sha(fs.readFileSync(file)) });
    }
  }
  return result;
}
const original = inventory(source);
const metadataPath = 'scripts/fvs-probe-windows-qualification.mjs';
const { WINDOWS_SOURCE_QUALIFICATION: qualification } = await import(pathToFileURL(path.join(source, metadataPath)));
const { getWindowsSourcePolicy } = await import(pathToFileURL(path.join(source, 'scripts/fvs-probe-windows-runtime.mjs')));
assert.equal(qualification.qualified, false, 'Use this helper only before qualification');
const policySha256 = getWindowsSourcePolicy().sha256;
fs.cpSync(source, destination, { recursive: true, errorOnExist: true, force: false });
assert.deepEqual(inventory(destination), original, 'Candidate copy differs');
const prospective = { ...qualification, qualified: true, policySha256,
  reason: 'Private release candidate awaiting native acceptance; this metadata is not the shipped qualification.' };
fs.writeFileSync(path.join(destination, metadataPath),
  '// Private acceptance candidate. Never copy this metadata into a release without passing evidence.\n' +
  `export const WINDOWS_SOURCE_QUALIFICATION = Object.freeze(${JSON.stringify(prospective, null, 2)});\n`);
const candidate = inventory(destination);
const changes = candidate.filter((item, index) => item.sha256 !== original[index]?.sha256);
assert.deepEqual(changes.map(item => item.path), [metadataPath]);
assert.deepEqual(inventory(source), original, 'Shipped package changed');
fs.writeFileSync(evidence, JSON.stringify({ schema: 'fvs/windows-release-candidate/v1',
  recordedAt: new Date().toISOString(), source, destination, shippedQualified: false,
  policySha256, delta: { path: metadataPath, before: qualification, after: prospective },
  original, candidate, sourceManifestSha256: sha(JSON.stringify(original)),
  candidateManifestSha256: sha(JSON.stringify(candidate)),
}, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ destination, policySha256, evidence, metadataOnlyDifference: true }));
