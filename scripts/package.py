#!/usr/bin/env python3
"""Package only indexed release files; require a clean tracked working tree."""
import subprocess
import sys
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def release_files():
    result = subprocess.run(['git', 'ls-files', '-z'], cwd=ROOT, check=True, capture_output=True)
    names = result.stdout.decode().split('\0')
    return [ROOT / n for n in names if n]

def main():
    subprocess.run([sys.executable, str(ROOT / 'scripts/check-release.py')], check=True)
    subprocess.run(['git', 'diff', '--exit-code', '--quiet'], cwd=ROOT, check=True)
    files = release_files()
    if not files:
        raise SystemExit('No indexed release files. Follow the README before packaging.')
    target = Path(sys.argv[1]).resolve()
    if ROOT in target.parents:
        raise SystemExit('Write archives outside the source repository.')
    with tarfile.open(target, 'w:gz') as archive:
        for path in files:
            archive.add(path, arcname=str(path.relative_to(ROOT)), recursive=False)
    print(f'Packaged {len(files)} files; Git history and local runtime files excluded.')

if __name__ == '__main__':
    main()
