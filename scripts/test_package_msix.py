import json
import hashlib
import tempfile
import unittest
from pathlib import Path
from xml.etree import ElementTree as ET
from zipfile import ZipFile
from package_msix import ROOT, FOUNDATION, UAP5, manifest, safe_member, stage, verify
from source_inventory import snapshot_id


class MsixTests(unittest.TestCase):
    def test_opc_encoded_license_names(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            stage = root/'stage'
            stage.mkdir()
            (stage/'toml+spec.txt').write_bytes(b'license')
            package = root/'package.msix'
            with ZipFile(package, 'w') as archive:
                archive.writestr('toml%2Bspec.txt', b'license')
                archive.writestr('AppxBlockMap.xml', '<BlockMap/>')
            verify(package, stage)

    def test_identity_version_and_opt_in_startup(self):
        identity = json.loads((ROOT/'packaging/store-identity.json').read_text(encoding='utf-8'))
        doc = ET.fromstring(manifest(identity, '0.2.2'))
        app_id = doc.find(f'{{{FOUNDATION}}}Identity')
        self.assertEqual(app_id.attrib['Name'], 'CurePirsm.334999D231AD4')
        self.assertEqual(app_id.attrib['Publisher'], identity['publisher'])
        self.assertEqual(app_id.attrib['Version'], '1.2.2.0')
        next_doc = ET.fromstring(manifest(identity, '1.0.0'))
        self.assertEqual(next_doc.find(f'{{{FOUNDATION}}}Identity').attrib['Version'], '2.0.0.0')
        self.assertEqual(doc.find(f'.//{{{UAP5}}}StartupTask').attrib['Enabled'], 'false')
        for bad in ('0.2.2-beta', '0.2.2.1', '0.65536.0', '65535.0.0'):
            with self.assertRaises(ValueError):
                manifest(identity, bad)

    def test_paths_cannot_escape_stage(self):
        for bad in ('../evil', 'C:/evil', '/evil', r'..\evil', 'file:stream'):
            with self.assertRaises(ValueError):
                safe_member(bad)

    def test_package_corruption_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            stage = root/'stage'
            stage.mkdir()
            (stage/'ffmpeg.exe').write_bytes(b'expected')
            package = root/'package.msix'
            with ZipFile(package, 'w') as archive:
                archive.writestr('ffmpeg.exe', b'changed')
                archive.writestr('AppxBlockMap.xml', '<BlockMap/>')
            with self.assertRaises(ValueError):
                verify(package, stage)

    def test_development_stage_uses_immutable_source_materials_and_snapshot_identity(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            commit = '1' * 40
            binary = root / 'app.exe'
            binary.write_bytes(b'fixture application')
            decoder = ROOT / 'crates/desktop/embedded/ffmpeg.exe'
            audit = root / 'audit.zip'
            source = root / 'source.zip'
            source_files = {
                'Cargo.toml': b'[workspace.package]\nversion="0.2.2"\n',
                'Cargo.lock': b'lock fixture',
                'packaging/store-identity.json': (ROOT / 'packaging/store-identity.json').read_bytes(),
                'docs/PRIVACY.md': b'privacy text from the source snapshot, not the caller checkout',
                **{'packaging/Assets/' + name: (ROOT / 'packaging/Assets' / name).read_bytes()
                   for name in ('StoreLogo.png', 'Square44x44Logo.png', 'Square150x150Logo.png')},
            }
            records = [{'path': name, 'sha256': hashlib.sha256(data).hexdigest()}
                       for name, data in sorted(source_files.items())]
            identity = snapshot_id(records)
            tree = json.dumps({'schemaVersion': 1, 'development': True, 'baseCommit': commit,
                               'snapshotSha256': identity, 'files': records}).encode()
            claims = f'Development snapshot: True\nWorking-tree snapshot SHA-256: {identity}\n'
            with ZipFile(audit, 'w') as archive:
                for name in ('LICENSE', 'NOTICE.md', 'third-party/FFmpeg/COPYING.LGPLv2.1',
                             'third-party/FFmpeg/LICENSE.md'):
                    archive.writestr('DanmakuVoice/' + name, b'license fixture')
                archive.writestr('DanmakuVoice/danmakuvoice.exe', binary.read_bytes())
                archive.writestr('DanmakuVoice/third-party/Rust/Cargo.lock', b'lock fixture')
                archive.writestr('DanmakuVoice/third-party/Fonts/fixture-OFL.txt', b'font copyright and license')
                archive.writestr('DanmakuVoice/WORKTREE-SOURCE.json', tree)
                archive.writestr('DanmakuVoice/BUILD-SOURCE.txt', f'Source Git commit: {commit}\nCheckout clean before build: False\n' + claims)
            prefix = f'DanmakuVoice-source-{commit[:12]}/'
            with ZipFile(source, 'w') as archive:
                for name, data in source_files.items():
                    archive.writestr(prefix + name, data)
                archive.writestr(prefix + 'WORKTREE-SOURCE.json', tree)
                archive.writestr(prefix + 'SOURCE-COMMIT.txt', f'DanmakuVoice source commit: {commit}\n' + claims)
            files = stage(audit, binary, decoder, root / 'staged', '0.2.2', commit,
                          source=source, development=True)
            self.assertEqual(files['PRIVACY.md'], source_files['docs/PRIVACY.md'])
            self.assertEqual(files['third-party/Fonts/fixture-OFL.txt'], b'font copyright and license')
            self.assertEqual(files['WORKTREE-SOURCE.json'], tree)
            self.assertIn(identity.encode(), files['SOURCE-AVAILABILITY.txt'])
            self.assertNotIn(b'/releases/download/', files['SOURCE-AVAILABILITY.txt'])


if __name__ == '__main__':
    unittest.main()
