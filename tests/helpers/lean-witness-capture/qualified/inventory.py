"""Canonical import inventory: from a discovery log (one JSON array of {module, olean, parts}) to
{modules: {module: {olean, parts: {suffix: sha256}}}} with every existing data part hashed.
Usage: inventory.py DISCOVERY_LOG OUT_JSON  -> prints the inventory digest and counts."""
import hashlib, json, sys

log, out = sys.argv[1:3]
rows = json.loads([line for line in open(log) if line.startswith('[')][-1])
modules = {}
for row in rows:
    parts = {}
    for suffix in row['parts']:
        h = hashlib.sha256()
        with open(row['olean'] + suffix, 'rb') as f:
            for chunk in iter(lambda: f.read(1 << 20), b''):
                h.update(chunk)
        parts[suffix or '.olean'] = h.hexdigest()
    if row['module'] in modules:
        sys.exit(f"duplicate module {row['module']}")
    modules[row['module']] = {'olean': row['olean'], 'parts': parts}
inventory = {'modules': dict(sorted(modules.items()))}
text = json.dumps(inventory, sort_keys=True, separators=(',', ':'))
open(out, 'w').write(text)
digest = hashlib.sha256(text.encode()).hexdigest()
print(json.dumps({'digest': digest, 'modules': len(modules), 'files': sum(len(m['parts']) for m in modules.values())}))
