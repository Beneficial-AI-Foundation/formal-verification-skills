import hashlib, json, os, subprocess, sys
R, proj, libs, lcode, pcode, binary, _cmd = sys.argv[1:8]
rest = sys.argv[9:]; split = rest.index('--'); lake, probe = rest[:split], rest[split + 1:]
sha = lambda p: hashlib.sha256(open(p, 'rb').read()).hexdigest()
skip = {'.lake', '.aeneas', '.git', 'target'}
files = {}
for root, dirs, names in os.walk(proj):
    dirs[:] = [d for d in dirs if d not in skip]
    for n in names:
        if n.endswith('.lean') or n in ('translation.json', 'lakefile.toml', 'lake-manifest.json', 'lean-toolchain'):
            p = os.path.join(root, n); files[os.path.relpath(p, proj)] = sha(p)
st = os.path.join(proj, '.formalising', 'auto-fv', 'state.json')
if os.path.exists(st): files['.formalising/auto-fv/state.json'] = sha(st)
build = os.path.join(proj, '.lake', 'build', 'lib', 'lean')
for root, dirs, names in os.walk(build):
    for n in names:
        if n.endswith('.ilean'):
            p = os.path.join(root, n); files[os.path.relpath(p, proj)] = sha(p)
compiled = {}
for root, dirs, names in os.walk(build):
    for n in names:
        if '.olean' in n:
            p = os.path.join(root, n); compiled[os.path.relpath(p, proj)] = sha(p)
head = subprocess.run(['git', '-C', proj, 'rev-parse', 'HEAD'], capture_output=True, text=True).stdout.strip() or None
out = os.path.join(R, 'lean.json')
receipt = {
    'schema': 'fvs/lean-probe-run', 'version': 1,
    'projectRoot': proj,
    'libraries': [] if libs == '-' else libs.split(','),
    'lakeBuild': {'argv': lake, 'exitCode': int(lcode)},
    'probe': {'argv': probe, 'exitCode': int(pcode), 'sha256': sha(binary),
              'version': subprocess.run([binary, '--version'], capture_output=True, text=True).stdout.strip()},
    'inputs': {'leanProjectCommit': head, 'files': dict(sorted(files.items())), 'compiled': dict(sorted(compiled.items()))},
    'outputs': {'extractSha256': sha(out) if os.path.exists(out) else None,
                'logSha256': sha(os.path.join(R, 'probe.log'))},
}
json.dump(receipt, open(os.path.join(R, 'receipt.json'), 'w'), indent=2); open(os.path.join(R, 'receipt.json'), 'a').write('\n')
