#!/usr/bin/env python3
"""Merge an explicitly granted gate profile into one associated actor's settings.

This is trusted operator coordination, not authentication or OS atomic CAS.
Adapted from the reviewed Phase C merger (377180e3); no polling or global settings.
"""
import hashlib
import json
import os
from pathlib import Path
import secrets
import shlex
import stat
import subprocess
import sys


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


def read_regular(path, dir_fd=None):
    # With dir_fd, path is a leaf name inside that already pinned directory and is resolved only through it.
    if dir_fd is None:
        canonical(path)
    st = os.lstat(path, dir_fd=dir_fd)
    need(stat.S_ISREG(st.st_mode) and st.st_nlink == 1, 'expected a single-link regular file')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=dir_fd)
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
    # The grant is written to this worktree's own settings.local.json. Links to FVS entries inside a real
    # .claude folder are fine; a linked .claude folder or settings.local.json would put the grant in a shared file.
    directory = os.path.join(wt, '.claude')
    need(not os.path.islink(directory), 'actor .claude is a link, so its settings.local.json would be shared with other '
         'worktrees; use a real .claude folder per worktree and link only the FVS entries inside it, never settings.local.json')
    canonical(directory)
    need(stat.S_ISDIR(os.lstat(directory).st_mode), 'actor .claude is not a real directory')
    file = os.path.join(directory, 'settings.local.json')
    need(not os.path.islink(file), 'actor settings.local.json is a link to a file shared with other worktrees; '
         'keep it a real per-worktree file')
    return canonical(file)


def write_exclusive(file, data):
    with open(file, 'xb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


def open_directory(path):
    # O_NOFOLLOW covers only the last component, so also require that the opened directory is the one the
    # canonical path names now. Every later step goes through the descriptor, never back through the path.
    canonical(path)
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        opened, named = os.fstat(fd), os.lstat(path)
        need((opened.st_dev, opened.st_ino) == (named.st_dev, named.st_ino), 'directory changed while opening')
        canonical(path)
    except BaseException:
        os.close(fd)
        raise
    return fd


def merge(file, rules, out, before_commit=None):
    # The staged file, the final checks and the replace all go through one pinned directory descriptor, so a
    # swapped path or link cannot redirect the write into another directory. The guarantee is about that
    # directory object, not its name; a concurrent same-user process that relocates it or links files at that
    # instant is outside the boundary.
    directory, name = os.path.split(canonical(file))
    dir_fd = open_directory(directory)
    try:
        before, st = read_regular(name, dir_fd)
        settings = decode(before)
        need(isinstance(settings, dict) and isinstance(settings.get('hooks'), dict), 'missing AO hooks')
        need('permissions' not in settings, 'existing permissions require explicit reconciliation')
        after = (json.dumps({**settings, 'permissions': {'allow': rules}}, indent=2) + '\n').encode()
        write_exclusive(os.path.join(out, 'before.json'), before)
        temporary = '.settings.local.' + secrets.token_hex(8)
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=dir_fd)
        committed = False
        try:
            with os.fdopen(fd, 'wb') as stream:
                need(os.fstat(stream.fileno()).st_nlink == 1, 'staged settings file is linked elsewhere; nothing written')
                stream.write(after)
                stream.flush()
                os.fsync(stream.fileno())
                os.fchmod(stream.fileno(), stat.S_IMODE(st.st_mode))
            if before_commit:
                before_commit()
            current, now = read_regular(name, dir_fd)
            need(current == before and (now.st_dev, now.st_ino, now.st_size, now.st_mtime_ns)
                 == (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns), 'settings drifted; not overwritten')
            os.replace(temporary, name, src_dir_fd=dir_fd, dst_dir_fd=dir_fd)
            committed = True
        finally:
            if not committed:
                try:
                    os.unlink(temporary, dir_fd=dir_fd)
                except FileNotFoundError:
                    pass
        installed, _ = read_regular(name, dir_fd)
    finally:
        os.close(dir_fd)
    write_exclusive(os.path.join(out, 'after.json'), installed)
    need(installed == after and {k: v for k, v in json.loads(installed).items() if k != 'permissions'} == settings,
         'installed readback differs; hold actor')
    return {'file': file, 'beforeSha256': sha(before), 'installedSha256': sha(installed), 'rules': rules}


def install(request):
    closed(request, ['schema', 'schemaVersion', 'projectRoot', 'association', 'grant', 'node', 'gate', 'out'])
    need(request['schema'] == 'fvs/auto-actor-permissions' and request['schemaVersion'] == 1, 'unsupported request')
    for tool in ['node', 'gate']:
        closed(request[tool], ['file', 'sha256'])
        need(isinstance(request[tool]['file'], str) and not any(c in request[tool]['file'] for c in '*?\r\n'),
             'literal wildcard/pattern tool paths are unsupported; no permission change')
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
