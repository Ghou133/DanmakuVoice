"""Identify a curated working-tree snapshot without exporting user data."""
import argparse
import hashlib
import json
import re
import stat
import subprocess
from pathlib import Path, PurePosixPath
from zipfile import ZipFile

ROOT_FILES = {'.gitignore', '.gitattributes', 'AGENTS.md', 'ARCHITECTURE.md',
              'Cargo.toml', 'Cargo.lock', 'LICENSE', 'NOTICE.md', 'MIGRATION.md',
              'PROGRESS.md', 'README.md', 'rust-toolchain.toml'}
PREFIXES = ('crates/', 'docs/', 'scripts/', 'packaging/', '.github/workflows/')
PRIVATE = re.compile(r'(?i)(^|/)(cookies\.json|session\.json|\.env(?:\..*)?|[^/]+\.(?:sqlite(?:3)?|db|pem|key|p12|pfx|kdbx))$')


def safe_path(name):
    path = PurePosixPath(name)
    if (not name or '\\' in name or ':' in name or path.is_absolute()
            or any(part in ('', '.', '..') for part in name.split('/'))):
        raise ValueError(f'Unsafe source path: {name}')
    return path


def digest(path, root):
    # Derive the lexical suffix before resolving the root. Windows may expand
    # an 8.3 TEMP path only during resolve(), otherwise the same directory
    # appears outside itself. Check every suffix component for links below.
    root = Path(root).absolute()
    path = Path(path).absolute()
    try:
        relative = path.relative_to(root)
    except ValueError as error:
        raise ValueError('Source path is outside the snapshot root') from error
    root = root.resolve()
    path = root / relative
    current = root
    for part in relative.parts:
        current /= part
        info = current.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
            raise ValueError(f'Source path contains a link or reparse point: {relative.as_posix()}')
    if not path.resolve().is_relative_to(root):
        raise ValueError('Resolved source path is outside the snapshot root')
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
        raise ValueError(f'Source must be an ordinary file: {path.name}')
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def snapshot_id(files):
    return hashlib.sha256(''.join(f"{item['sha256']}  {item['path']}\n"
                                  for item in files).encode('utf-8')).hexdigest()


def inventory(root):
    root = Path(root).resolve()
    commit = subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD']).decode().strip()
    if not re.fullmatch('[0-9a-f]{40}', commit):
        raise ValueError('Expected a full base Git commit')
    supplements = {'third-party/license-supplements/manifest.json'}
    manifest = json.loads((root / next(iter(supplements))).read_text(encoding='utf-8-sig'))
    if manifest['schemaVersion'] != 1:
        raise ValueError('Unsupported license supplement manifest')
    for entry in manifest['entries']:
        for item in entry['files']:
            if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', item['path']):
                raise ValueError('Unsafe license supplement path')
            supplements.add('third-party/license-supplements/' + item['path'])
    names = subprocess.check_output(['git', '-C', str(root), 'ls-files', '--cached',
                                     '--others', '--exclude-standard', '-z']).decode('utf-8').split('\0')
    files = []
    seen = set()
    for name in sorted(set(names) - {''}):
        if name not in ROOT_FILES and name not in supplements and not name.startswith(PREFIXES):
            continue
        path = safe_path(name)
        if PRIVATE.search(name):
            raise ValueError(f'Refusing credential or database path: {name}')
        if any(part in ('target', 'dist', 'node_modules', '__pycache__', '.git') for part in path.parts) or name.endswith(('.pyc', '.pyo')):
            continue
        file = root / path
        # A tracked deletion is part of the snapshot, not a missing source file.
        if not file.exists() and not file.is_symlink():
            continue
        if name.casefold() in seen:
            raise ValueError(f'Case-ambiguous source path: {name}')
        seen.add(name.casefold())
        files.append({'path': name, 'sha256': digest(file, root)})
    included = {item['path'] for item in files}
    required = {'Cargo.toml', 'Cargo.lock', 'LICENSE', 'NOTICE.md', 'README.md',
                'crates/desktop/embedded/ffmpeg.exe', *supplements}
    if not required.issubset(included):
        raise ValueError('Required working-tree sources or license supplements are missing')
    return {'schemaVersion': 1, 'baseCommit': commit, 'development': True,
            'snapshotSha256': snapshot_id(files), 'files': files}


def validate_manifest(manifest):
    if manifest.get('schemaVersion') != 1 or manifest.get('development') is not True:
        raise ValueError('Unsupported development snapshot manifest')
    if not re.fullmatch('[0-9a-f]{40}', manifest.get('baseCommit', '')):
        raise ValueError('Invalid development base commit')
    files = manifest.get('files', [])
    seen = set()
    for item in files:
        name = item['path']
        safe_path(name)
        if (name not in ROOT_FILES and not name.startswith(PREFIXES)
                and not re.fullmatch(r'third-party/license-supplements/[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)?', name)):
            raise ValueError('Development manifest contains an unlisted source path')
        if any(part in ('target', 'dist', 'node_modules', '__pycache__', '.git') for part in PurePosixPath(name).parts):
            raise ValueError('Development manifest contains a generated path')
        if PRIVATE.search(name) or name.casefold() in seen or not re.fullmatch('[0-9a-f]{64}', item['sha256']):
            raise ValueError('Invalid or duplicate development source record')
        seen.add(name.casefold())
    if not files or files != sorted(files, key=lambda item: item['path']) or snapshot_id(files) != manifest.get('snapshotSha256'):
        raise ValueError('Development snapshot identity mismatch')
    return files


def verify(root, manifest):
    for item in validate_manifest(manifest):
        if digest(Path(root) / safe_path(item['path']), root) != item['sha256']:
            raise ValueError(f"Development source changed: {item['path']}")


def verify_development_pair(audit, source, commit):
    prefix = f'DanmakuVoice-source-{commit[:12]}/'
    for archive in (audit, source):
        names = archive.namelist()
        if len(names) != len(set(names)):
            raise ValueError('Duplicate source or audit archive member')
    audit_manifest = json.loads(audit.read('DanmakuVoice/WORKTREE-SOURCE.json').decode('utf-8-sig'))
    source_manifest = json.loads(source.read(prefix + 'WORKTREE-SOURCE.json').decode('utf-8-sig'))
    files = validate_manifest(source_manifest)
    if audit_manifest != source_manifest or source_manifest['baseCommit'] != commit:
        raise ValueError('Development audit/source snapshot mismatch')
    for archive, name in ((audit, 'DanmakuVoice/BUILD-SOURCE.txt'),
                          (source, prefix + 'SOURCE-COMMIT.txt')):
        provenance = archive.read(name).decode('utf-8-sig')
        for claim in ('Development snapshot: True',
                      f"Working-tree snapshot SHA-256: {source_manifest['snapshotSha256']}"):
            if not re.search(r'(?m)^' + re.escape(claim) + r'\r*$', provenance):
                raise ValueError('Development snapshot provenance is incomplete')
    for item in files:
        if hashlib.sha256(source.read(prefix + item['path'])).hexdigest() != item['sha256']:
            raise ValueError(f"Development source bytes differ: {item['path']}")
    # Generated matching-source materials are the only files outside the
    # captured tree. An unlisted private file cannot hide behind valid hashes.
    expected = {item['path'] for item in files} | {'SOURCE-COMMIT.txt', 'WORKTREE-SOURCE.json',
                'third-party/Rust/CRATE-ARCHIVES.json', 'third-party/Rust/CRATE-RESOLVER-ARCHIVES.json',
                'third-party/FFmpeg/ffmpeg-9.0.2.tar.xz', 'third-party/FFmpeg/COPYING.LGPLv2.1',
                'third-party/FFmpeg/LICENSE.md'}
    resolver_path = prefix + 'third-party/Rust/CRATE-RESOLVER-ARCHIVES.json'
    if resolver_path in source.namelist():
        resolver = json.loads(source.read(resolver_path).decode('utf-8-sig'))
        for item in resolver['archives']:
            name = item['archive']
            if not re.fullmatch(r'[A-Za-z0-9_-]+-[0-9A-Za-z.+-]+\.crate', name):
                raise ValueError('Invalid generated Rust source path')
            expected.add('third-party/Rust/crate-archives/' + name)
    seen = set()
    for name in source.namelist():
        if name.endswith('/'):
            continue
        if not name.startswith(prefix):
            raise ValueError('Unexpected source archive root')
        relative = name.removeprefix(prefix)
        safe_path(relative)
        if relative not in expected or relative.casefold() in seen:
            raise ValueError(f'Unlisted or ambiguous development archive path: {relative}')
        seen.add(relative.casefold())
    return source_manifest['snapshotSha256']


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('inventory', 'verify', 'pair'))
    parser.add_argument('--root')
    parser.add_argument('--manifest')
    parser.add_argument('--audit')
    parser.add_argument('--source')
    parser.add_argument('--commit')
    args = parser.parse_args()
    if args.command == 'inventory':
        if not args.root:
            parser.error('inventory requires --root')
        # ASCII JSON survives Python/native PowerShell code-page differences;
        # json parsing restores Unicode paths before copying/hashing files.
        print(json.dumps(inventory(args.root), ensure_ascii=True, indent=2))
    elif args.command == 'verify':
        if not args.manifest or not args.root:
            parser.error('verify requires --root and --manifest')
        verify(args.root, json.loads(Path(args.manifest).read_text(encoding='utf-8-sig')))
        print('Verified development working-tree source bytes')
    else:
        if not args.audit or not args.source or not args.commit:
            parser.error('pair requires --audit, --source and --commit')
        with ZipFile(args.audit) as audit, ZipFile(args.source) as source:
            print('Verified development source snapshot: ' + verify_development_pair(audit, source, args.commit))
