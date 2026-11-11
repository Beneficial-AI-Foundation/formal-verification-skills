#!/bin/bash
# Paired probe-lean 0.24 and Lean constants (v2, extractor v3) capture over one discovered import inventory.
# Output and work directories are allocated exclusively and fresh for each attempt. Nothing is published unless
# every step, copy and receipt write succeeded and the receipt names the fresh, non-empty probe extract.
# Usage: paired-run3.sh NAME PROJECT ROOTS [PROBE]   (ROOTS = comma-separated Lean library roots; PROBE defaults to
# the installed probe-lean 0.24.0 and is overridden only for failure tests)
# Every step runs under the deny-network sandbox with an env -i allowlist and a step receipt.
set -euo pipefail
NAME=${1:?name required}; PROJ=${2:?project required}; ROOTS=${3:?roots required}
SCRIPT_DIR=$(cd -- "$(dirname -- "$0")" && pwd -P)
B="$SCRIPT_DIR/qualified"
BASE=${FVS_WITNESS_BASE:?exclusive output parent required}
LAKE=/Users/ada/.elan/toolchains/leanprover--lean4---v4.31.0/bin/lake
LEAN=/Users/ada/.elan/toolchains/leanprover--lean4---v4.31.0/bin/lean
PROBE=${4:-/Users/ada/.fvs/tools/swvf-qualification-latest/probe-lean-0.24.0-lean-v4.31.0-darwin-arm64/bin/probe-lean}
PROFILE='(version 1)(allow default)(deny network*)'
fail() { echo "FAILED: $*" >&2; exit 1; }
[[ "$NAME" =~ ^[A-Za-z0-9][A-Za-z0-9_-]*$ ]] || fail 'invalid exclusive output name'
[[ "$ROOTS" == M1demo ]] || fail 'this bounded capture supports M1demo only'
[[ "$PROJ" == /* && -d "$PROJ" && "$BASE" == /* && -d "$BASE" && ! -L "$BASE" ]] || fail 'absolute existing project/output parent required'
for absent in .formalising Specs Specs.lean .claude .codex; do
  [[ ! -e "$PROJ/$absent" && ! -L "$PROJ/$absent" ]] || fail "implementation-only source contains $absent"
done
/usr/bin/python3 -I - "$PROJ" "$BASE" <<'PATHS'
from pathlib import Path
import sys
source,base=map(Path,sys.argv[1:])
if str(source.resolve())!=str(source) or str(base.resolve())!=str(base):sys.exit('canonical project/output paths required')
if base==source or source in base.parents:sys.exit('output parent must be outside source')
PATHS
R="$BASE/$NAME"
mkdir "$R" || fail 'output exists or cannot be created'
W="$R/work"; PHOME="$R/home"
mkdir "$W" "$PHOME"
ENVS=("HOME=$PHOME" "PATH=$(dirname "$LAKE"):/usr/bin:/bin" LEAN_NUM_THREADS=2)
# Pin copied support/templates before specializing any program.
/usr/bin/python3 -I - "$B" "$W" <<'PINS'
from pathlib import Path
import hashlib,sys
src,dst=map(Path,sys.argv[1:])
pins={
 'inventory.py':'4a4abb988a5ca6b7abc26f4a42bb1f81052e62f9272cdc46db2cb5b79e2de422',
 'step-receipt.sh':'4ab426e48fc7264f8e314a3390ad9bfd29ce618695f77b9c93d75349bc7267b1',
 'receipt5.py':'30d8605612264e7c02395c2961e52b2e2615675db6944d5a96dc5ff3455c2cbe',
 'Discover.lean':'c6cd32c7dfe84153e5d59e0bb4d10382cf05fdcbe3d27f5244c424750b1ce995',
 'LeanConstantsV3.lean':'a3b66ea40a41f12ece51fc080bdce84d09a38bcb086c2e34f358b26dd621f2bb'}
for name,digest in pins.items():
 p=src/name
 if p.is_symlink() or hashlib.sha256(p.read_bytes()).hexdigest()!=digest:sys.exit('qualified input changed: '+name)
for name in ['Discover.lean','LeanConstantsV3.lean']:
 s=(src/name).read_text();old='import M1demo\nimport Specs\n'
 if s.count(old)!=1:sys.exit('unexpected imports template')
 s=s.replace(old,'import M1demo\n',1)
 if name=='LeanConstantsV3.lean':
  old='def projectRoots : List Name := [`M1demo, `Specs]'
  if s.count(old)!=1:sys.exit('unexpected roots template')
  s=s.replace(old,'def projectRoots : List Name := [`M1demo]',1)
 (dst/name).write_text(s)
PINS
BUILD=("$LAKE" --no-cache --rehash --verbose build "$ROOTS")
DISCOVER=("$LAKE" env lean --threads=2 "$W/Discover.lean")
EXTRACT=("$PROBE" extract "$PROJ" -o "$W/lean.json" --library "$ROOTS")
ORACLE=("$LAKE" env lean --threads=2 "$W/LeanConstantsV3.lean")
/usr/bin/python3 -I - "$R" "$PROJ" -- "${BUILD[@]}" -- "${DISCOVER[@]}" -- "${EXTRACT[@]}" -- "${ORACLE[@]}" <<'ARGV'
import json,sys
root,cwd=sys.argv[1:3];groups=[]
for x in sys.argv[3:]:
 if x=='--':groups.append([])
 else:groups[-1].append(x)
with open(root+'/00-planned-argv.json','x') as f:
 json.dump({'status':'prepared-not-executed','cwd':cwd,'commands':dict(zip(['build','discovery','probe','oracle'],groups))},f,indent=2)
ARGV
# Tests may inspect preparation without running a compiler, probe, producer step or --version.
if [[ ${FVS_WITNESS_PREPARE_ONLY:-0} == 1 ]]; then echo "prepared only: $R"; exit 0; fi
[[ ${FVS_WITNESS_PREPARE_ONLY:-0} == 0 ]] || fail 'invalid prepare-only value'
SOURCE_HEAD=$(git -C "$PROJ" rev-parse HEAD) || fail 'source Git identity unavailable'
SOURCE_STATUS=$(git -C "$PROJ" status --porcelain=v1 --untracked-files=all) || fail 'source Git status unavailable'
[[ -z "$SOURCE_STATUS" ]] || fail 'source is dirty'
/usr/bin/python3 -I - "$LEAN" "$LAKE" "$PROBE" <<'TOOLS'
import hashlib,sys
expected=['1b370cfcbf44e80d1b004ab1b1ab9a4c73951f9f7c242140bcff9bc577576554','58261a1a2fa1a362376c71e02ca854a093e71cc5e6ea64b287a931cb2565273d','ac2998e713a49275ba08a3cefbf50db9b30faddbd5f45ac87259028d3248a101']
for p,h in zip(sys.argv[1:],expected):
 if hashlib.sha256(open(p,'rb').read()).hexdigest()!=h:sys.exit('pinned tool changed: '+p)
TOOLS
cp "$W/Discover.lean" "$W/LeanConstantsV3.lean" "$R/" || fail "copying the programs"
{ for f in "$SCRIPT_DIR/paired-run3.sh" "$B/inventory.py" "$B/step-receipt.sh" "$B/receipt5.py" "$W/Discover.lean" "$W/LeanConstantsV3.lean" "$PROBE" "$LEAN" "$LAKE"; do echo "$(shasum -a 256 "$f" | cut -c1-64)  $f"; done; echo "project_head: $SOURCE_HEAD"; } > "$R/00-identities.txt"
cd "$PROJ" || exit 1
discover() {  # $1 = step name; writes $W/$1.inventory.json and prints its summary
  "$B/step-receipt.sh" "$R" "$1" "$W/Discover.lean" "" -- "${ENVS[@]}" "${DISCOVER[@]}" >/dev/null || return 1
  /usr/bin/python3 -I "$B/inventory.py" "$R/$1.log" "$W/$1.inventory.json"
}
"$B/step-receipt.sh" "$R" 01-lake-build "" "" -- "${ENVS[@]}" "${BUILD[@]}" || exit 1
D1=$(discover 02-discover-before-probe) || exit 1
"$B/step-receipt.sh" "$R" 03-probe "" "$W/lean.json" -- "${ENVS[@]}" "${EXTRACT[@]}" || exit 1
[ -s "$W/lean.json" ] || fail "the probe exited 0 but wrote no extract"
D2=$(discover 04-discover-after-probe) || exit 1
cmp -s "$W/02-discover-before-probe.inventory.json" "$W/04-discover-after-probe.inventory.json" || { echo "inventory changed during the probe run"; exit 1; }
D3=$(discover 05-discover-before-oracle) || exit 1
cmp -s "$W/02-discover-before-probe.inventory.json" "$W/05-discover-before-oracle.inventory.json" || { echo "inventory changed between the probe and the oracle"; exit 1; }
"$B/step-receipt.sh" "$R" 06-oracle "$W/LeanConstantsV3.lean" "" -- "${ENVS[@]}" "${ORACLE[@]}" || exit 1
D4=$(discover 07-discover-after-oracle) || exit 1
cmp -s "$W/05-discover-before-oracle.inventory.json" "$W/07-discover-after-oracle.inventory.json" || { echo "inventory changed during the oracle run"; exit 1; }
cp "$W/02-discover-before-probe.inventory.json" "$R/imports.json" || fail "copying the import manifest"
cp "$W/lean.json" "$R/lean.json" || fail "copying the extract"
cp "$R/03-probe.log" "$R/probe.log" || fail "copying the probe log"
AFTER_HEAD=$(git -C "$PROJ" rev-parse HEAD) || fail 'source Git identity unavailable after capture'
AFTER_STATUS=$(git -C "$PROJ" status --porcelain=v1 --untracked-files=all) || fail 'source Git status unavailable after capture'
[[ "$AFTER_HEAD" == "$SOURCE_HEAD" && -z "$AFTER_STATUS" ]] || fail 'source changed during capture'
for absent in .formalising Specs Specs.lean .claude .codex; do
  [[ ! -e "$PROJ/$absent" && ! -L "$PROJ/$absent" ]] || fail "source contaminated during capture: $absent"
done
# Probe receipt (fvs/lean-probe-run v1, runner v5 fields) plus the import inventory digest.
# The receipt writer runs the probe's --version, so it runs under the same sandbox and allowlist.
/usr/bin/sandbox-exec -p "$PROFILE" env -i "${ENVS[@]}" /usr/bin/python3 -I "$B/receipt5.py" "$R" "$PROJ" "$ROOTS" 0 0 "$PROBE" "$R/00-identities.txt" -- "${BUILD[@]}" -- "${EXTRACT[@]}" \
  || fail "writing the probe receipt"
/usr/bin/python3 -I - "$R" "$W" "$PROJ" "$D1" "$D2" "$D3" "$D4" "$LAKE" <<'PY'
import hashlib, json, os, sys
R, W, proj, d1, d2, d3, d4, lake = sys.argv[1:9]
sha = lambda p: hashlib.sha256(open(p, 'rb').read()).hexdigest()
summaries = [json.loads(x) for x in (d1, d2, d3, d4)]
if len({s['digest'] for s in summaries}) != 1:
    sys.exit('inventory digests differ')
imports = summaries[0]
inventory = json.load(open(f'{R}/imports.json'))
receipt = json.load(open(f'{R}/receipt.json'))
# The receipt must name the extract this attempt produced and copied, and the extract must be a probe-lean envelope.
if receipt['outputs'].get('extractSha256') != sha(f'{R}/lean.json') or receipt['outputs']['extractSha256'] != sha(f'{W}/lean.json'):
    sys.exit('the probe receipt does not name this attempt\'s extract')
try:
    envelope = json.load(open(f'{R}/lean.json'))
except ValueError:
    sys.exit('the extract is not JSON')
if not isinstance(envelope, dict) or not isinstance(envelope.get('data'), dict):
    sys.exit('the extract is not a probe-lean envelope')
receipt['inputs']['imports'] = imports
# The probe log the receipt names is the step log.
receipt['outputs']['logSha256'] = sha(f'{R}/probe.log')
json.dump(receipt, open(f'{R}/receipt.json', 'w'), indent=2)
# Oracle output: one complete JSON value, module names equal to discovery.
lines = [l for l in open(f'{R}/06-oracle.log') if l.startswith('{')]
if len(lines) != 1:
    sys.exit('oracle output is not exactly one JSON value')
body = json.loads(lines[0])
if sorted(body['moduleNames']) != sorted(inventory['modules']):
    sys.exit('extractor module names differ from discovery')
names = [n['name'] for n in body['nodes']]
if len(names) != len(set(names)):
    sys.exit('duplicate nodes')
ids = {}
for line in open(f'{R}/00-identities.txt'):
    if '  ' in line:
        digest, path = line.rstrip('\n').split('  ', 1)
        if sha(path) != digest:
            sys.exit('producer/tool/program changed during capture: ' + path)
        ids[os.path.basename(path)] = digest
record = {
    'schema': 'fvs/lean-constants', 'version': 2,
    'producer': {'toolchain': 'leanprover/lean4:v4.31.0', 'leanSha256': ids['lean'], 'lakeSha256': ids['lake'],
                 'extractorSha256': ids['LeanConstantsV3.lean'], 'discoverySha256': ids['Discover.lean'],
                 'harnessSha256': ids['paired-run3.sh']},
    'inputs': {'files': receipt['inputs']['files'], 'compiled': receipt['inputs']['compiled'], 'imports': imports},
    'nodes': body['nodes'],
    'referenced': body['referenced'],
}
text = json.dumps(record, indent=1) + '\n'
tmp = f'{R}/.constants.json.tmp'
open(tmp, 'w').write(text)
os.replace(tmp, f'{R}/constants.json')
run = {'schema': 'fvs/lean-constants-run', 'version': 1, 'exitCode': 0,
       'argv': [lake, 'env', 'lean', '--threads=2', f'{W}/LeanConstantsV3.lean'], 'cwd': proj,
       'inventoryBefore': summaries[2]['digest'], 'inventoryAfter': summaries[3]['digest'],
       'producer': record['producer'], 'outputSha256': hashlib.sha256(text.encode()).hexdigest(), 'outputBytes': len(text.encode())}
tmp = f'{R}/.constants-run.json.tmp'
open(tmp, 'w').write(json.dumps(run, indent=1) + '\n')
os.replace(tmp, f'{R}/constants-run.json')
print('published:', len(record['nodes']), 'nodes;', imports)
PY
[ $? -eq 0 ] || fail "finalizing"
/usr/bin/python3 -I - "$R" <<'SUMS'
from pathlib import Path
import hashlib,sys
r=Path(sys.argv[1]);rows=[]
for p in sorted(r.rglob('*')):
 if p.is_file() and p.name!='SHA256SUMS':rows.append(hashlib.sha256(p.read_bytes()).hexdigest()+'  '+str(p.relative_to(r)))
(r/'SHA256SUMS').write_text('\n'.join(rows)+'\n')
SUMS
echo "== paired run $NAME done"
