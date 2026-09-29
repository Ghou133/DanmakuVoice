import json
import tempfile
import unittest
from pathlib import Path
from xml.etree import ElementTree as ET
from zipfile import ZipFile
from package_msix import ROOT, FOUNDATION, UAP5, manifest, safe_member, verify


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


if __name__ == '__main__':
    unittest.main()
