#!/usr/bin/env python3
"""Merge an explicitly granted gate profile into one associated actor's settings.

This is trusted operator coordination, not authentication or OS atomic CAS.
Adapted from the reviewed Phase C merger (377180e3); no polling or global settings.
"""
import hashlib
import json
import os
from pathlib import Path
import shlex
import stat
import subprocess
import sys
import tempfile


class Refused(Exception):
    pass


def need(value, reason):
    if not value:
        raise Refused(reason)


def closed(value, keys):
    need(isinstance(value, dict) and set(value) == set(keys), 'unexpected request fields')


def sha(data):
    return hashlib.sha256(data).hexdigest()


def decode(data):
    def object_pairs(pairs):
        value = {}
        for key, item in pairs:
            need(key not in value, 'duplicate JSON key; preserve ambiguous bytes')
            value[key] = item
        return value
    return json.loads(data, object_pairs_hook=object_pairs)


def canonical(path):
    need(isinstance(path, str) and os.path.isabs(path) and os.path.normpath(path) == path
         and os.path.realpath(path) == path, 'noncanonical or aliased path')
    return path


def read_regular(path):
    canonical(path)
    st = os.lstat(path)
    need(stat.S_ISREG(st.st_mode) and st.st_nlink == 1, 'expected a single-link regular file')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        now = os.fstat(fd)
        need((now.st_dev, now.st_ino) == (st.st_dev, st.st_ino), 'file changed while opening')
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            return stream.read(), st
    finally:
        os.close(fd)


def bound(ref):
    closed(ref, ['file', 'sha256'])
    data, _ = read_regular(ref['file'])
    need(sha(data) == ref['sha256'], 'bound file changed')
    return data


def git(root, *args):
    argv = ['/usr/bin/git', '-C', root, *args]
    result = subprocess.run(argv, capture_output=True, timeout=30, env={
        'PATH': '/usr/bin:/bin', 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CONFIG_NOSYSTEM': '1',
        'GIT_NO_LAZY_FETCH': '1', 'GIT_NO_REPLACE_OBJECTS': '1', 'GIT_OPTIONAL_LOCKS': '0',
        'GIT_TERMINAL_PROMPT': '0'})
    need(result.returncode == 0, 'Git identity observation failed')
    return result.stdout.decode().strip()


def actor_settings(project_root, association):
    need(association.get('schema') == 'fvs/auto-session-association' and association.get('schemaVersion') == 1
         and association.get('scopeRelation') == 'run-assignment'
         and association.get('provenance', {}).get('kind') == 'controller-launch', 'not a retained launched assignment')
    w = association['worktree']
    wt = canonical(w['path'])
    common = os.path.realpath(os.path.join(project_root, git(project_root, 'rev-parse', '--git-common-dir')))
    need(w['gitCommonDir'] == common, 'actor is from another primary Git store')
    need(git(wt, 'rev-parse', '--show-toplevel') == wt
         and os.path.realpath(os.path.join(wt, git(wt, 'rev-parse', '--git-dir'))) == w['gitDir']
         and os.path.realpath(os.path.join(wt, git(wt, 'rev-parse', '--git-common-dir'))) == common
         and git(wt, 'symbolic-ref', '-q', 'HEAD') == w['branchRef'], 'actor Git identity drifted')
    descriptor, _ = read_regular(os.path.join(wt, '.git'))
    need(descriptor.decode().strip() == 'gitdir: ' + w['gitDir'], 'actor Git descriptor differs')
    directory = os.path.join(wt, '.claude')
    canonical(directory)
    need(stat.S_ISDIR(os.lstat(directory).st_mode), 'actor .claude is not a real directory')
    return canonical(os.path.join(directory, 'settings.local.json'))


def write_exclusive(file, data):
    with open(file, 'xb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


def merge(file, rules, out, before_commit=None):
    before, st = read_regular(file)
    settings = decode(before)
    need(isinstance(settings, dict) and isinstance(settings.get('hooks'), dict), 'missing AO hooks')
    need('permissions' not in settings, 'existing permissions require explicit reconciliation')
    after = (json.dumps({**settings, 'permissions': {'allow': rules}}, indent=2) + '\n').encode()
    write_exclusive(os.path.join(out, 'before.json'), before)
    fd, temporary = tempfile.mkstemp(prefix='.settings.local.', dir=os.path.dirname(file))
    committed = False
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(after)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, stat.S_IMODE(st.st_mode))
        if before_commit:
            before_commit()
        current, now = read_regular(file)
        need(current == before and (now.st_dev, now.st_ino, now.st_size, now.st_mtime_ns)
             == (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns), 'settings drifted; not overwritten')
        os.replace(temporary, file)
        committed = True
    finally:
        if not committed and os.path.lexists(temporary):
            os.unlink(temporary)
    installed, _ = read_regular(file)
    write_exclusive(os.path.join(out, 'after.json'), installed)
    need(installed == after and {k: v for k, v in json.loads(installed).items() if k != 'permissions'} == settings,
         'installed readback differs; hold actor')
    return {'file': file, 'beforeSha256': sha(before), 'installedSha256': sha(installed), 'rules': rules}


def install(request):
    closed(request, ['schema', 'schemaVersion', 'projectRoot', 'association', 'grant', 'node', 'gate', 'out'])
    need(request['schema'] == 'fvs/auto-actor-permissions' and request['schemaVersion'] == 1, 'unsupported request')
    root = canonical(request['projectRoot'])
    association = decode(bound(request['association']))
    grant = decode(bound(request['grant']))
    closed(grant, ['schema', 'schemaVersion', 'runId', 'projectId', 'controllerSessionId', 'gate', 'node', 'ownerReference'])
    need(grant['schema'] == 'fvs/auto-actor-permission-grant' and grant['schemaVersion'] == 1
         and grant['ownerReference'] and all(grant[k] == association[k] for k in ['runId', 'projectId', 'controllerSessionId'])
         and grant['gate'] == request['gate'] and grant['node'] == request['node'], 'grant does not cover this actor/run/tools')
    bound(request['node'])
    bound(request['gate'])
    file = actor_settings(root, association)
    out = canonical(request['out'])
    need(not os.path.lexists(out) and os.path.isdir(os.path.dirname(out)), 'exclusive output parent required')
    for protected in [root, association['worktree']['path']]:
        need(os.path.commonpath([out, protected]) not in [out, protected], 'output overlaps protected project/actor')
    os.mkdir(out, 0o700)
    write_exclusive(os.path.join(out, 'request.json'), (json.dumps(request, indent=2) + '\n').encode())
    gate, node = shlex.quote(request['gate']['file']), shlex.quote(request['node']['file'])
    result = merge(file, [f'Bash(node {gate} *)', f'Bash({node} {gate} *)'], out)
    bound(request['node'])
    bound(request['gate'])
    need(actor_settings(root, association) == file, 'actor identity changed during merge')
    result.update({'schema': 'fvs/auto-actor-permissions-result', 'schemaVersion': 1, 'association': request['association'],
                   'grant': request['grant'], 'verified': True, 'authority': 'trusted operator readback; not actor authentication or OS isolation'})
    write_exclusive(os.path.join(out, 'result.json'), (json.dumps(result, indent=2) + '\n').encode())
    return result


if __name__ == '__main__':
    try:
        need(len(sys.argv) == 3 and sys.argv[1] == '--input', 'Usage: fvs-auto-actor-permissions.py --input REQUEST.json')
        print(json.dumps(install(decode(Path(sys.argv[2]).read_bytes()))))
    except (Refused, OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        print(json.dumps({'status': 'permission-installation-unverified', 'message': str(error)}), file=sys.stderr)
        sys.exit(1)
