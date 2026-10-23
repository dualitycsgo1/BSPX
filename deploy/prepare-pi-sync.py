#!/usr/bin/env python3
"""Capture Pi BSPX runtime code and merge main; templates and rundowns stay local.

The default is a read-only dry run. No service is restarted.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tempfile

class SyncError(Exception):
    pass

SOURCE_REF = 'origin/main'
MANIFEST_PATH = 'deploy/pi-sync-manifest.json'
CAPTURE_ALLOWED = {
    '.gitignore', 'views/view-renderer.handlebars',
    'static/js/pgl_fullscreen_transitions.js', 'static/js/eafc_fullscreen_bridge.js',
    'utils/spx_server_functions.js', 'utils/spx_atomic_json.js',
}

def git(repo, *args, check=True):
    result = subprocess.run(['git', '-C', str(repo), *args], stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, check=False)
    if check and result.returncode:
        raise SyncError('Git could not complete ' + args[0] + '. Inspect git status locally; no reset or cleanup was attempted.')
    return result

def sha(data):
    return hashlib.sha256(data).hexdigest()

def relative_path(value):
    if not isinstance(value, str) or not value or '\\' in value or any(ord(c) < 32 for c in value):
        raise SyncError('Manifest contains an invalid path.')
    path = PurePosixPath(value)
    if path.is_absolute() or ':' in value or any(p in ('.', '..', '.git') for p in path.parts) or str(path) != value:
        raise SyncError('Manifest contains an unsafe path.')
    return value

def inside(repo, relative):
    path = repo.joinpath(*PurePosixPath(relative).parts)
    resolved = path.resolve()
    if not resolved.is_relative_to(repo) or resolved == repo or path.is_symlink():
        raise SyncError('A path is a symbolic link or resolves outside the repository: ' + relative)
    return path

def local_only(path):
    parts = [p.lower() for p in PurePosixPath(path).parts]
    return (parts[:2] == ['assets', 'templates']
            or any(p.startswith('dataroot') or p in ('instances', '.git', '.bspx-sync-backup', 'node_modules', 'log') for p in parts)
            or parts[-1] in ('liveconfig.json', 'layer-names.json', '.env')
            or re.fullmatch(r'config[0-9]*\.json', parts[-1]) is not None
            or parts[-1].startswith('.env.'))

def source_blob(repo, path, required=False):
    result = git(repo, 'show', SOURCE_REF + ':' + path, check=False)
    if result.returncode:
        if required:
            raise SyncError('Published main is missing: ' + path)
        return None
    return result.stdout

def scan_public(data, path):
    try:
        text = data.decode('utf-8-sig')
    except UnicodeDecodeError:
        return
    if re.search(r'''\b(?:API_?KEY|CITO_API_KEY|CITO_KEY|BROADCAST_TOKEN|AUTH_SECRET|DATABASE_URL|CLIENT_SECRET)["']?\s*[=:]\s*(["'])([^"'\r\n]+)\1''', text, re.I):
        raise SyncError('A literal credential assignment would enter Git: ' + path)
    if re.search(r'[?&](?:token|access_token|api_key|apikey|passphrase)=[A-Za-z0-9._~%+\-]{8,}', text, re.I):
        raise SyncError('A credential-bearing URL would enter Git: ' + path)

def atomic_write(path, data, private=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    old_mode = path.stat().st_mode & 0o777 if path.exists() else 0o644
    descriptor, temporary = tempfile.mkstemp(prefix='.bspx-sync-', dir=str(path.parent))
    try:
        with os.fdopen(descriptor, 'wb') as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600 if private else old_mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)

def prepare(repo):
    repo = repo.resolve()
    if Path(git(repo, 'rev-parse', '--show-toplevel').stdout.decode().strip()).resolve() != repo:
        raise SyncError('--repo must point to the Git repository root.')
    if git(repo, 'symbolic-ref', '--short', 'HEAD', check=False).stdout.strip() != b'main':
        raise SyncError("Check out the Pi's existing main branch before syncing.")
    if git(repo, 'diff', '--cached', '--quiet', check=False).returncode:
        raise SyncError('The Git index has staged changes. Commit or unstage them before syncing.')
    if git(repo, 'merge-base', '--is-ancestor', 'HEAD', SOURCE_REF, check=False).returncode:
        raise SyncError('The Pi HEAD is not included in origin/main. Fetch main and reconcile the newer local commit before retrying.')
    for identity in ('GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT'):
        git(repo, 'var', identity)
    manifest_bytes = source_blob(repo, MANIFEST_PATH, required=True)
    try:
        manifest = json.loads(manifest_bytes)
    except (ValueError, UnicodeDecodeError):
        raise SyncError('Published main contains an invalid sync manifest.')
    if manifest.get('version') != 1 or manifest.get('sourceRef', SOURCE_REF) != SOURCE_REF:
        raise SyncError('Unsupported sync manifest version or source ref.')
    paths, hashes = manifest.get('paths'), manifest.get('snapshotHashes')
    if not isinstance(paths, list) or not isinstance(hashes, dict):
        raise SyncError('Invalid manifest path list or snapshot hashes.')
    paths = [relative_path(p) for p in paths]
    if len(paths) != len(set(paths)) or '.gitignore' not in paths:
        raise SyncError('Manifest paths must be unique and include .gitignore.')
    for path in paths:
        if local_only(path) or path not in CAPTURE_ALLOWED:
            raise SyncError('Only explicit BSPX runtime code can be captured; local data is excluded: ' + path)
    for path, value in hashes.items():
        relative_path(path)
        if path not in paths or not isinstance(value, str) or not re.fullmatch(r'[a-f0-9]{64}', value):
            raise SyncError('Invalid snapshot hash: ' + path)
    incoming_ignore = source_blob(repo, '.gitignore', required=True)
    for protected in ('.bspx-sync-backup', 'ASSETS/templates', 'DATAROOT*'):
        if protected not in incoming_ignore.decode('utf-8'):
            raise SyncError('Published .gitignore does not protect local templates, rundowns and backups.')
    changes = [p.decode('utf-8') for p in git(repo, 'diff', '--name-only', '-z', 'HEAD', SOURCE_REF).stdout.split(b'\0') if p]
    if any(local_only(p) for p in changes):
        raise SyncError('Published main changes a local-only template, rundown or machine file. Reconcile upstream before syncing; nothing was changed.')
    existing, changed = {}, []
    for path in paths:
        target = inside(repo, path)
        if not target.exists():
            continue  # New source arrives with the merge; never stage deletions.
        if not target.is_file():
            raise SyncError('Manifest path is not a regular file: ' + path)
        data = target.read_bytes()
        if path not in hashes or sha(data) != hashes[path]:
            incoming = source_blob(repo, path)
            if incoming is None or sha(data) != sha(incoming):
                changed.append(path)
        existing[path] = data
    if changed:
        raise SyncError('Files changed since the captured Pi snapshot; nothing was overwritten:\n  ' + '\n  '.join(changed))
    candidates = {**existing, '.gitignore': incoming_ignore}
    for path, data in candidates.items():
        scan_public(data, path)
    head = git(repo, 'rev-parse', 'HEAD').stdout.decode().strip()
    return {'repo': repo, 'manifest': manifest_bytes, 'existing': existing,
            'candidates': candidates, 'ignore': incoming_ignore, 'head': head}

def apply_plan(plan, push=False):
    repo = plan['repo']
    for path, original in plan['existing'].items():
        target = inside(repo, path)
        if not target.exists() or target.read_bytes() != original:
            raise SyncError('A captured code file changed during preparation: ' + path)
    if git(repo, 'diff', '--cached', '--quiet', check=False).returncode:
        raise SyncError('The Git index changed during preparation; nothing was overwritten.')
    if plan['existing'].get('.gitignore') != plan['ignore']:
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
        backup = inside(repo, '.bspx-sync-backup/' + stamp)
        backup.mkdir(parents=True, mode=0o700)
        atomic_write(backup / 'HEAD.txt', (plan['head'] + '\n').encode(), private=True)
        atomic_write(backup / 'pi-sync-manifest.json', plan['manifest'], private=True)
        if '.gitignore' in plan['existing']:
            atomic_write(backup / '.gitignore', plan['existing']['.gitignore'], private=True)
        atomic_write(inside(repo, '.gitignore'), plan['ignore'])
        print('Recovery backup: ' + str(backup.relative_to(repo)))
    # Deliberately add individual runtime files, never a whole directory.
    stage_paths = list(plan['candidates'])
    for start in range(0, len(stage_paths), 50):
        git(repo, 'add', '--', *stage_paths[start:start + 50])
    staged = [p.decode('utf-8') for p in git(repo, 'diff', '--cached', '--name-only', '-z').stdout.split(b'\0') if p]
    try:
        for path in staged:
            if path not in CAPTURE_ALLOWED or local_only(path):
                raise SyncError('A non-runtime file entered the index: ' + path)
            scan_public(git(repo, 'show', ':' + path).stdout, path)
    except SyncError:
        if staged:
            git(repo, 'restore', '--staged', '--', *staged)
        raise
    if staged:
        git(repo, 'commit', '-m', 'Preserve running Pi BSPX code; keep templates and rundowns local')
        print('Committed captured runtime code (' + str(len(staged)) + ' files).')
    else:
        print('Runtime code already matches Git; no snapshot commit was needed.')
    git(repo, 'merge', '--no-edit', SOURCE_REF)
    print('Merged published main while preserving local history.')
    if push:
        git(repo, 'push', 'origin', 'main')
        print('Pushed main to origin without force.')

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, default=Path.cwd())
    parser.add_argument('--apply', action='store_true', help='Back up ignore rules, commit runtime code and merge origin/main.')
    parser.add_argument('--push', action='store_true', help='Push main after --apply (never force).')
    args = parser.parse_args(argv)
    if args.push and not args.apply:
        parser.error('--push requires --apply')
    try:
        plan = prepare(args.repo)
        print('Verified ' + str(len(plan['existing'])) + ' captured runtime files against the Pi snapshot or published main.')
        if args.apply:
            apply_plan(plan, push=args.push)
        else:
            print('Dry run only. No files, Git index, commits, services or feeds were changed.')
            print('Use --apply to preserve and merge; add --push to publish merged main.')
        return 0
    except (SyncError, OSError) as error:
        print('STOP: ' + str(error), file=sys.stderr)
        return 1

if __name__ == '__main__':
    sys.exit(main())
