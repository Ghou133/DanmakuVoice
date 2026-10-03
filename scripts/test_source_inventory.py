import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from source_inventory import digest, inventory, safe_path, validate_manifest, verify, snapshot_id


class SourceInventoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        subprocess.run(['git', 'init', '-q', str(self.root)], check=True)
        for name in ('Cargo.toml', 'Cargo.lock', 'LICENSE', 'NOTICE.md', 'README.md',
                     'crates/desktop/embedded/ffmpeg.exe'):
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'fixture')
        supplement = self.root / 'third-party/license-supplements/manifest.json'
        supplement.parent.mkdir(parents=True)
        supplement.write_text(json.dumps({'schemaVersion': 1, 'entries': []}))
        subprocess.run(['git', '-C', str(self.root), 'add', '.'], check=True)
        subprocess.run(['git', '-C', str(self.root), '-c', 'user.name=Package test',
                        '-c', 'user.email=package-test@example.invalid', 'commit', '-qm', 'fixture'], check=True)

    def test_snapshot_preserves_current_bytes_and_detects_changes(self):
        manifest = inventory(self.root)
        verify(self.root, manifest)
        (self.root / 'README.md').write_bytes(b'new working-tree content')
        with self.assertRaisesRegex(ValueError, 'source changed'):
            verify(self.root, manifest)
        self.assertNotEqual(manifest['snapshotSha256'], inventory(self.root)['snapshotSha256'])

    def test_untracked_sources_included_private_notes_and_generated_files_excluded(self):
        for name in ('scripts/new.py', 'scripts/__pycache__/junk.pyc', 'Claude outputs/private.txt'):
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'fixture')
        files = {item['path'] for item in inventory(self.root)['files']}
        self.assertIn('scripts/new.py', files)
        self.assertNotIn('scripts/__pycache__/junk.pyc', files)
        self.assertNotIn('Claude outputs/private.txt', files)

    def test_selected_credentials_are_rejected(self):
        (self.root / 'crates/session.json').write_text('private fixture')
        with self.assertRaisesRegex(ValueError, 'credential or database path'):
            inventory(self.root)

    def test_tracked_deletion_is_omitted(self):
        file = self.root / 'crates/deleted.rs'
        file.write_bytes(b'fixture')
        subprocess.run(['git', '-C', str(self.root), 'add', '.'], check=True)
        file.unlink()
        self.assertNotIn('crates/deleted.rs', {item['path'] for item in inventory(self.root)['files']})

    def test_unicode_path_round_trips_through_native_json_output(self):
        name = 'crates/目录/名字.rs'
        file = self.root / name
        file.parent.mkdir(parents=True)
        file.write_bytes('Unicode fixture'.encode())
        tool = Path(__file__).with_name('source_inventory.py')
        result = subprocess.run([os.sys.executable, str(tool), 'inventory', '--root', str(self.root)],
                                check=True, capture_output=True)
        manifest = json.loads(result.stdout.decode('ascii'))
        self.assertIn(name, {item['path'] for item in manifest['files']})
        verify(self.root, manifest)

    def test_manifest_identity_and_path_checks(self):
        for name in ('../escape', '/escape', 'file:stream', r'crates\escape', 'crates/./escape'):
            with self.assertRaises(ValueError):
                safe_path(name)
        manifest = inventory(self.root)
        manifest['files'][0]['sha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'identity mismatch'):
            validate_manifest(manifest)

    @unittest.skipUnless(os.name == 'nt', 'Windows short-path regression')
    def test_short_root_path_preserves_hash_and_link_checks(self):
        import ctypes
        with tempfile.TemporaryDirectory(prefix='source inventory long name ',
                                         dir=self.root) as directory:
            root = Path(directory)
            file = root / 'file.py'
            file.write_bytes(b'short and long paths refer to the same source')
            buffer = ctypes.create_unicode_buffer(32768)
            size = ctypes.windll.kernel32.GetShortPathNameW(str(root), buffer, len(buffer))
            self.assertGreater(size, 0)
            self.assertLess(size, len(buffer))
            short_root = Path(buffer.value)
            self.assertEqual(digest(short_root / file.name, short_root), digest(file, root))
            self.assertEqual(digest(short_root / file.name, short_root), digest(file, root.resolve()))

    def test_parent_directory_link_cannot_include_external_files(self):
        with tempfile.TemporaryDirectory() as external:
            target = Path(external)
            (target / 'file.py').write_bytes(b'outside the selected repository')
            scripts = self.root / 'scripts'
            scripts.mkdir()
            link = scripts / 'redirect'
            if os.name == 'nt':
                subprocess.run(['cmd', '/c', 'mklink', '/J', str(link), str(target)],
                               check=True, capture_output=True)
            else:
                link.symlink_to(target, target_is_directory=True)
            try:
                with self.assertRaisesRegex(ValueError, 'link or reparse'):
                    digest(link / 'file.py', self.root)
            finally:
                if os.name == 'nt':
                    os.rmdir(link)
                else:
                    link.unlink()

    def test_rehashed_manifest_cannot_select_unknown_or_generated_files(self):
        for name in ('private-notes.txt', 'scripts/__pycache__/private.pyc'):
            manifest = inventory(self.root)
            manifest['files'].append({'path': name, 'sha256': '0' * 64})
            manifest['files'].sort(key=lambda item: item['path'])
            manifest['snapshotSha256'] = snapshot_id(manifest['files'])
            with self.assertRaisesRegex(ValueError, 'unlisted|generated'):
                validate_manifest(manifest)


if __name__ == '__main__':
    unittest.main()
