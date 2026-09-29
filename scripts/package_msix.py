"""Stage a Store submission from the verified audit package; never sign or publish."""
import argparse
import hashlib
import json
import re
import struct
import tomllib
from pathlib import Path, PurePosixPath
from xml.etree import ElementTree as ET
from urllib.parse import unquote
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
FFMPEG_SHA256 = '8fb7ecc11f4f7a441ae7075a81c984289250b166e78dedf51900bbeb1a96ef4d'
NS = 'http://schemas.microsoft.com/appx/manifest/'
FOUNDATION = NS + 'foundation/windows10'
UAP = NS + 'uap/windows10'
UAP5 = UAP + '/5'
UAP10 = UAP + '/10'
RESCAP = NS + 'foundation/windows10/restrictedcapabilities'
for prefix, uri in [('', FOUNDATION), ('uap', UAP), ('uap5', UAP5), ('uap10', UAP10), ('rescap', RESCAP)]:
    ET.register_namespace(prefix, uri)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def store_version(version):
    parts = version.split('.')
    if len(parts) != 3 or any(not re.fullmatch(r'0|[1-9][0-9]*', p) or int(p) > 65535 for p in parts):
        raise ValueError('Version must be a three-part stable version within MSIX limits')
    # Store requires a nonzero major and reserves the fourth version component.
    if int(parts[0]) >= 65535:
        raise ValueError('Application major version exceeds the Store mapping limit')
    return f'{int(parts[0]) + 1}.{parts[1]}.{parts[2]}.0'


def manifest(identity, version):
    if not re.fullmatch(r'[A-Za-z0-9.-]{3,50}', identity['name']):
        raise ValueError('Invalid Store package name')
    if not re.fullmatch(r'CN=[0-9A-Fa-f-]{36}', identity['publisher']):
        raise ValueError('Use the exact Partner Center Publisher identity')
    root = ET.Element(f'{{{FOUNDATION}}}Package', IgnorableNamespaces='uap uap5 uap10 rescap')
    def add(parent, tag, **attrs):
        return ET.SubElement(parent, f'{{{FOUNDATION}}}{tag}', attrs)
    add(root, 'Identity', Name=identity['name'], Publisher=identity['publisher'], Version=store_version(version), ProcessorArchitecture='x64')
    props = add(root, 'Properties')
    for tag, value in [('DisplayName', identity['display_name']), ('PublisherDisplayName', identity['publisher_display_name']), ('Description', '直播弹幕接收与语音播报'), ('Logo', 'Assets/StoreLogo.png')]:
        add(props, tag).text = value
    resources = add(root, 'Resources')
    add(resources, 'Resource', Language='zh-CN')
    deps = add(root, 'Dependencies')
    add(deps, 'TargetDeviceFamily', Name='Windows.Desktop', MinVersion='10.0.19041.0', MaxVersionTested='10.0.26100.0')
    apps = add(root, 'Applications')
    app = add(apps, 'Application', Id='App', Executable='DanmakuVoice.exe', **{f'{{{UAP10}}}RuntimeBehavior': 'packagedClassicApp', f'{{{UAP10}}}TrustLevel': 'mediumIL'})
    ET.SubElement(app, f'{{{UAP}}}VisualElements', DisplayName=identity['display_name'], Description='直播弹幕接收与语音播报', Square150x150Logo='Assets/Square150x150Logo.png', Square44x44Logo='Assets/Square44x44Logo.png', BackgroundColor='transparent')
    ext = add(app, 'Extensions')
    startup = ET.SubElement(ext, f'{{{UAP5}}}Extension', Category='windows.startupTask', Executable='DanmakuVoice.exe', EntryPoint='Windows.FullTrustApplication')
    ET.SubElement(startup, f'{{{UAP5}}}StartupTask', TaskId='DanmakuVoiceStartup', Enabled='false', DisplayName=identity['display_name'])
    caps = add(root, 'Capabilities')
    ET.SubElement(caps, f'{{{RESCAP}}}Capability', Name='runFullTrust')
    ET.indent(root)
    return ET.tostring(root, encoding='utf-8', xml_declaration=True)


def safe_member(name):
    path = PurePosixPath(name)
    if not name or '\\' in name or ':' in name or path.is_absolute() or '..' in path.parts:
        raise ValueError(f'Unsafe archive path: {name}')
    return path


def stage(audit, exe, ffmpeg, output, version, commit, source=None, development=False):
    output = Path(output)
    if output.exists():
        raise FileExistsError(f'Refusing to overwrite {output}')
    if not re.fullmatch('[0-9a-f]{40}', commit):
        raise ValueError('Expected a complete Git commit')
    identity = json.loads((ROOT / 'packaging/store-identity.json').read_text(encoding='utf-8'))
    xml = manifest(identity, version)
    binary = Path(exe).read_bytes()
    decoder = Path(ffmpeg).read_bytes()
    if digest(decoder) != FFMPEG_SHA256:
        raise ValueError('FFmpeg differs from the verified build')
    files = {}
    with ZipFile(audit) as archive:
        if archive.read('DanmakuVoice/danmakuvoice.exe') != binary:
            raise ValueError('Application differs from audit package')
        provenance = archive.read('DanmakuVoice/BUILD-SOURCE.txt').decode('utf-8-sig')
        if f'Source Git commit: {commit}' not in provenance:
            raise ValueError('Audit commit mismatch')
        if not development and not re.search(r'(?m)^Checkout clean before build: True\r*$', provenance):
            raise ValueError('Store submissions require clean source provenance')
        for item in archive.infolist():
            if item.is_dir() or not item.filename.startswith('DanmakuVoice/'):
                continue
            name = item.filename.removeprefix('DanmakuVoice/')
            if name in ('LICENSE', 'NOTICE.md', 'BUILD-SOURCE.txt') or name.startswith(('third-party/Rust/', 'third-party/license-supplements/')) or name in ('third-party/FFmpeg/COPYING.LGPLv2.1', 'third-party/FFmpeg/LICENSE.md'):
                safe_member(name)
                if name in files:
                    raise ValueError('Duplicate license material')
                files[name] = archive.read(item)
    required = {'LICENSE', 'NOTICE.md', 'third-party/Rust/Cargo.lock', 'third-party/FFmpeg/COPYING.LGPLv2.1', 'third-party/FFmpeg/LICENSE.md'}
    if not required.issubset(files):
        raise ValueError('Incomplete license materials')
    if not development and source is None:
        raise ValueError('Matching complete source archive is required')
    if source:
        with ZipFile(source) as archive:
            prefix = f'DanmakuVoice-source-{commit[:12]}/'
            if f'DanmakuVoice source commit: {commit}' not in archive.read(prefix+'SOURCE-COMMIT.txt').decode('utf-8-sig'):
                raise ValueError('Source commit mismatch')
            config = tomllib.loads(archive.read(prefix+'Cargo.toml').decode('utf-8-sig'))
            if config['workspace']['package']['version'] != version or archive.read(prefix+'Cargo.lock') != files['third-party/Rust/Cargo.lock']:
                raise ValueError('Source version or dependency lock mismatch')
    for filename, size in [('StoreLogo.png', 50), ('Square44x44Logo.png', 44), ('Square150x150Logo.png', 150)]:
        image = (ROOT / 'packaging/Assets' / filename).read_bytes()
        if image[:8] != b'\x89PNG\r\n\x1a\n' or struct.unpack('>II', image[16:24]) != (size, size):
            raise ValueError(f'Invalid asset dimensions: {filename}')
        files['Assets/'+filename] = image
    files['AppxManifest.xml'] = xml
    files['DanmakuVoice.exe'] = binary
    files['ffmpeg.exe'] = decoder
    files['PRIVACY.md'] = (ROOT/'docs/PRIVACY.md').read_bytes()
    files['SOURCE-AVAILABILITY.txt'] = (
        f'DanmakuVoice {version}\nSource commit: {commit}\n'
        'https://github.com/Ghou133/DanmakuVoice\n'
        f'Matching complete source: https://github.com/Ghou133/DanmakuVoice/releases/download/store-v{store_version(version)}/DanmakuVoice-source.zip\n'
        'Source must be published before Store submission.\n'
        + ('DEVELOPMENT VALIDATION ONLY - NOT FOR SUBMISSION\n' if development else '')
    ).encode()
    output.mkdir(parents=True)
    for name, data in files.items():
        target = output / safe_member(name)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    return files


def verify(msix, stage_dir):
    # MakeAppx adds its block map and content types; every staged file must survive.
    with ZipFile(msix) as archive:
        if archive.testzip() is not None or len(archive.namelist()) != len(set(archive.namelist())):
            raise ValueError('Corrupted or duplicate MSIX entries')
        # MSIX uses OPC part names: MakeAppx percent-encodes '+' and other
        # filename characters. Compare decoded names, rejecting ambiguities.
        entries = {unquote(name): name for name in archive.namelist()}
        if len(entries) != len(archive.namelist()):
            raise ValueError('Ambiguous encoded MSIX entries')
        for path in Path(stage_dir).rglob('*'):
            if path.is_file() and archive.read(entries[path.relative_to(stage_dir).as_posix()]) != path.read_bytes():
                raise ValueError(f'Packaged bytes differ: {path.name}')
        if 'AppxBlockMap.xml' not in archive.namelist():
            raise ValueError('MSIX has no block map')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    build = sub.add_parser('stage')
    for flag in ('audit', 'exe', 'ffmpeg', 'output', 'version', 'commit'):
        build.add_argument('--'+flag, required=True)
    build.add_argument('--source')
    build.add_argument('--development', action='store_true')
    check = sub.add_parser('verify')
    check.add_argument('--msix', required=True)
    check.add_argument('--stage-dir', required=True)
    args = vars(parser.parse_args())
    command = args.pop('command')
    (stage if command == 'stage' else verify)(**args)
