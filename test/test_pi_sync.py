"""Temporary local Git repositories only. No Pi or network access is used."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'deploy' / 'prepare-pi-sync.py'
RUNTIME = 'static/js/pgl_fullscreen_transitions.js'
NEW_CODE = 'static/js/eafc_fullscreen_bridge.js'
IGNORE = b'node_modules/\nLOG/\n.bspx-sync-backup/\n/ASSETS/templates/\n/DATAROOT*/\n/instances/\n/config*.json\n/liveconfig.json\n/layer-names.json\n'

class PiSyncTests(unittest.TestCase):
    def command(self, *args, okay=True):
        result = subprocess.run(args, capture_output=True, env=self.env)
        if okay and result.returncode:
            self.fail('Command failed: ' + str(args[:2]) + '\n' + result.stderr.decode(errors='replace'))
        return result

    def git(self, repo, *args, okay=True):
        return self.command('git', '-C', str(repo), *args, okay=okay)

    def write(self, repo, path, data):
        target = repo / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)

    def commit(self, repo, message):
        self.git(repo, 'add', '--all')
        self.git(repo, 'commit', '-m', message)
        return self.git(repo, 'rev-parse', 'HEAD').stdout.strip().decode()

    def identity(self, repo):
        for key, value in (('user.name', 'Pi Sync Test'), ('user.email', 'pi-sync@example.invalid'), ('core.autocrlf', 'false'), ('commit.gpgsign', 'false')):
            self.git(repo, 'config', key, value)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='bspx-sync-test-', dir=os.environ.get('BSPX_SYNC_TEST_TMP'))
        self.root = Path(self.temp.name)
        self.env = {**os.environ, 'GIT_TERMINAL_PROMPT': '0', 'GIT_CONFIG_NOSYSTEM': '1'}
        self.origin, self.upstream, self.pi = (self.root / n for n in ('origin.git', 'upstream', 'pi'))
        self.command('git', 'init', '--bare', str(self.origin))
        self.command('git', 'init', '--initial-branch=main', str(self.upstream))
        self.identity(self.upstream)
        self.write(self.upstream, '.gitignore', b'node_modules/\nLOG/\n')
        self.write(self.upstream, RUNTIME, b"window.runningVersion = 'base';\n")
        self.write(self.upstream, 'liveconfig.json', b'{"port":8080}\n')
        self.write(self.upstream, 'ASSETS/templates/stock/example.html', b'<h1>stock</h1>\n')
        self.commit(self.upstream, 'Initial BSPX')
        self.git(self.upstream, 'remote', 'add', 'origin', str(self.origin))
        self.git(self.upstream, 'push', '-u', 'origin', 'main')
        self.command('git', 'clone', '--branch', 'main', str(self.origin), str(self.pi))
        self.identity(self.pi)
        self.write(self.pi, 'local-history.txt', b'Preserve this Pi commit.\n')
        self.pi_head = self.commit(self.pi, 'Existing Pi runtime commit')
        self.git(self.upstream, 'fetch', str(self.pi), 'main')
        self.git(self.upstream, 'merge', '--ff-only', 'FETCH_HEAD')
        self.write(self.pi, RUNTIME, b"window.runningVersion = 'perfect Pi code';\n")
        (self.pi / 'ASSETS/templates/stock/example.html').unlink()
        self.protected = {
            'liveconfig.json': b'{"port":8080,"private":"unchanged"}\n',
            'config.json': b'{"private":"machine"}\n',
            'DATAROOT/PGTEST/profile.json': b'{"templates":["/PGL/local.html"]}\n',
            'DATAROOT/PGTEST/data/Main.json': b'{"controllerEntries":[1,2,3]}\n',
            'instances/runtime.json': b'{"pid":123}\n',
            'ASSETS/templates/PGL/proxy.py': b'API_KEY="local-secret-never-publish"\n',
            'ASSETS/templates/PGL/predictions-config.js': b'window.privateToken="do-not-publish";\n',
            'ASSETS/templates/PGL/graphic.html': b'<h1>Original layout</h1>\n',
            'ASSETS/templates/PGL/image.png': bytes(range(256)),
            'ASSETS/templates/eafc/assets/preview/fcc-snapshot.json': b'{"players":"private-cache"}\n',
        }
        for path, data in self.protected.items():
            self.write(self.pi, path, data)
        self.paths = ['.gitignore', RUNTIME, NEW_CODE]
        self.hashes = {p: hashlib.sha256((self.pi / p).read_bytes()).hexdigest() for p in self.paths if (self.pi / p).exists()}
        self.manifest = {'version': 1, 'sourceRef': 'origin/main', 'paths': self.paths, 'snapshotHashes': self.hashes}
        self.write(self.upstream, RUNTIME, (self.pi / RUNTIME).read_bytes())
        self.write(self.upstream, NEW_CODE, b'window.eafcBridge = true;\n')
        self.write(self.upstream, 'new-controller.js', b"module.exports = 'all rundown items';\n")
        self.write(self.upstream, '.gitignore', IGNORE)
        self.publish_manifest()

    def tearDown(self):
        self.temp.cleanup()

    def publish_manifest(self):
        self.write(self.upstream, 'deploy/pi-sync-manifest.json', (json.dumps(self.manifest) + '\n').encode())
        self.commit(self.upstream, 'Runtime code and controller fix')
        self.git(self.upstream, 'push', 'origin', 'main')
        self.git(self.pi, 'fetch', 'origin', 'main')

    def sync(self, *args, okay=True):
        return self.command(sys.executable, str(SCRIPT), '--repo', str(self.pi), *args, okay=okay)

    def assert_local_data_unchanged(self):
        for path, data in self.protected.items():
            self.assertEqual((self.pi / path).read_bytes(), data, path)
        self.assertFalse((self.pi / 'ASSETS/templates/stock/example.html').exists())
        tracked = self.git(self.pi, 'ls-files').stdout.decode().splitlines()
        self.assertFalse(any(p.startswith(('ASSETS/templates/PGL/', 'ASSETS/templates/eafc/', 'DATAROOT', '.bspx-sync-backup/', 'instances/')) for p in tracked))
        self.assertNotIn('config.json', tracked)
        history = self.git(self.pi, 'log', '--all', '-p').stdout
        self.assertNotIn(b'local-secret-never-publish', history)
        self.assertNotIn(b'do-not-publish', history)

    def test_dry_run_has_no_mutations(self):
        before = self.git(self.pi, 'status', '--porcelain', '--untracked-files=all').stdout
        result = self.sync()
        self.assertIn(b'Dry run only', result.stdout)
        self.assertEqual(self.git(self.pi, 'status', '--porcelain', '--untracked-files=all').stdout, before)
        self.assertFalse((self.pi / '.bspx-sync-backup').exists())
        self.assert_local_data_unchanged()

    def test_apply_push_preserves_history_and_all_local_data(self):
        self.sync('--apply', '--push')
        self.assertEqual((self.pi / RUNTIME).read_bytes(), b"window.runningVersion = 'perfect Pi code';\n")
        self.assertEqual((self.pi / NEW_CODE).read_bytes(), b'window.eafcBridge = true;\n')
        self.assertEqual((self.pi / 'new-controller.js').read_bytes(), b"module.exports = 'all rundown items';\n")
        self.assert_local_data_unchanged()
        self.assertEqual(self.git(self.pi, 'merge-base', '--is-ancestor', self.pi_head, 'HEAD').returncode, 0)
        self.assertEqual(self.git(self.pi, 'rev-parse', 'HEAD').stdout, self.git(self.origin, 'rev-parse', 'main').stdout)
        backups = list((self.pi / '.bspx-sync-backup').glob('*/.gitignore'))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_bytes(), b'node_modules/\nLOG/\n')

    def test_repeat_is_idempotent(self):
        self.sync('--apply', '--push')
        head = self.git(self.pi, 'rev-parse', 'HEAD').stdout
        backups = sorted(p.name for p in (self.pi / '.bspx-sync-backup').iterdir())
        self.sync('--apply', '--push')
        self.assertEqual(self.git(self.pi, 'rev-parse', 'HEAD').stdout, head)
        self.assertEqual(sorted(p.name for p in (self.pi / '.bspx-sync-backup').iterdir()), backups)
        self.assert_local_data_unchanged()

    def test_snapshot_mismatch_aborts_before_writes(self):
        self.write(self.pi, RUNTIME, b'newer edits since capture\n')
        result = self.sync('--apply', okay=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(RUNTIME.encode(), result.stderr)
        self.assertEqual((self.pi / '.gitignore').read_bytes(), b'node_modules/\nLOG/\n')
        self.assert_local_data_unchanged()

    def test_dirty_index_aborts_before_writes(self):
        self.git(self.pi, 'add', RUNTIME)
        staged = self.git(self.pi, 'diff', '--cached').stdout
        result = self.sync('--apply', okay=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b'staged changes', result.stderr)
        self.assertEqual(self.git(self.pi, 'diff', '--cached').stdout, staged)
        self.assert_local_data_unchanged()

    def test_new_local_commit_requires_reconciliation(self):
        self.write(self.pi, 'new-local-commit.txt', b'new local history\n')
        self.git(self.pi, 'add', 'new-local-commit.txt')
        self.git(self.pi, 'commit', '-m', 'New unseen local commit')
        result = self.sync('--apply', okay=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b'not included', result.stderr)
        self.assert_local_data_unchanged()

    def test_credential_in_captured_runtime_aborts_before_staging(self):
        secret_code = b'const API_KEY = "fixture-leaked-key-never-publish";\n'
        self.write(self.pi, RUNTIME, secret_code)
        self.hashes[RUNTIME] = hashlib.sha256(secret_code).hexdigest()
        self.write(self.upstream, RUNTIME, secret_code)
        self.publish_manifest()
        result = self.sync('--apply', okay=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b'credential assignment', result.stderr)
        self.assertNotIn(b'fixture-leaked', result.stderr + result.stdout)
        self.assertEqual(self.git(self.pi, 'diff', '--cached').stdout, b'')

    def test_manifest_cannot_capture_templates_rundowns_config_or_escape(self):
        for path in ('ASSETS/templates/PGL/proxy.py', 'DATAROOT/PGTEST/data/Main.json', 'config.json', '../outside'):
            with self.subTest(path=path):
                old_paths = list(self.paths)
                self.paths.append(path)
                self.publish_manifest()
                result = self.sync('--apply', okay=False)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual((self.pi / '.gitignore').read_bytes(), b'node_modules/\nLOG/\n')
                self.assert_local_data_unchanged()
                self.paths[:] = old_paths

    def test_upstream_cannot_overwrite_local_only_tracked_configuration(self):
        self.write(self.upstream, 'liveconfig.json', b'{"port":9999}\n')
        self.publish_manifest()
        result = self.sync('--apply', okay=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b'local-only', result.stderr)
        self.assert_local_data_unchanged()

if __name__ == '__main__':
    unittest.main()
