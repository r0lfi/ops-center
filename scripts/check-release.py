#!/usr/bin/env python3
"""Reject private files in Git's index. Print paths/rules, never secret values.

This complements Gitleaks; it is not a substitute for a secret scanner or review.
Untracked local runtime files are not release inputs and are never packaged.
"""
import hashlib
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PRIVATE_DIRS = {'ha-runtime', 'secrets', 'data', 'backups', 'artifacts', '.venv', '.venv-installer', 'node_modules', '__pycache__', '.pytest_cache'}
PRIVATE_EXTENSIONS = {'.pem', '.key', '.p12', '.pfx', '.db', '.sqlite', '.sqlite3', '.dump', '.zip', '.tar', '.gz'}

# Visually reviewed public artwork. Pin bytes so replacements require a new review.
REVIEWED_ARTWORK = {
    "docs/images/ops-floor.gif": "3662d8036bbaba70e95627baa4adf634df4d56e291a251ec02951084d6695385",
}

def check_file(name, data):
    p = Path(name)
    issues = []
    if PRIVATE_DIRS.intersection(p.parts) or any(x.startswith('.venv') for x in p.parts):
        issues.append('private/runtime directory')
    if (p.name.startswith('.env') and p.name != '.env.example') or p.suffix == '.env':
        issues.append('environment file')
    if p.suffix in PRIVATE_EXTENSIONS or p.name.startswith(('id_rsa', 'id_ed25519')):
        issues.append('credential/data/archive file')
    if name in ('deploy/inventory.ini', 'deploy/vars.yml', 'ansible/inventory/hosts.yml', 'ha-inventory.json', 'ha-hosts.ini'):
        issues.append('private installation configuration')
    if name in REVIEWED_ARTWORK:
        if hashlib.sha256(data).hexdigest() != REVIEWED_ARTWORK[name]:
            issues.append("reviewed artwork changed; visual review required")
        return issues
    try:
        text = data.decode('utf-8')
    except UnicodeDecodeError:
        return issues + ['unreviewed binary file']
    if re.search(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----', text):
        issues.append('private key material')
    # Public examples should use RFC 5737 documentation ranges, not real LANs.
    if re.search(r'\b(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b', text):
        issues.append('private-network address; replace with a configurable value/documentation example')
    if re.search(r'https://github[.]com/user-attachments/', text):
        issues.append('unreviewed external screenshot; use reviewed synthetic public artwork')
    return issues

def main():
    result = subprocess.run(['git', 'ls-files', '-z'], cwd=ROOT, capture_output=True, check=True)
    names = [n for n in result.stdout.decode().split('\0') if n]
    if not names:
        raise SystemExit('No indexed release files. Stage the reviewed source first.')
    failures = []
    for name in names:
        path = ROOT / name
        if path.is_symlink() or not path.is_file():
            failures.append((name, 'missing/non-regular release file'))
            continue
        # Check both staged content and working copy: neither may hide a secret.
        staged = subprocess.run(['git', 'show', ':' + name], cwd=ROOT, capture_output=True, check=True).stdout
        for issue in set(check_file(name, staged) + check_file(name, path.read_bytes())):
            failures.append((name, issue))
    for name, issue in failures:
        print(f'{name}: {issue}', file=sys.stderr)
    if failures:
        raise SystemExit(1)
    print(f'Release file policy passed ({len(names)} indexed files). Run Gitleaks before publishing.')

if __name__ == '__main__':
    main()
