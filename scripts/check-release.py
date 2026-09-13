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
    "docs/images/features/agents.png": "a11272f511bd0d1f98168b84508215a89c59be3ffea342077d6f740b72ab4c63",
    "docs/images/features/login-events.png": "59f353ff177ab647fe0d1cdc3e467e39009e92adcdfba727f037e69133744250",
    "docs/images/features/automation.png": "60b3de052afd902e75b9efd413a12b5c056c084824b7ee6f337c1693e2a7db95",
    "docs/images/features/cluster.png": "81abbf1d5c8009bc6b48d64d276947703127b7715f9c7ad3d1abd8c9b90b843a",
    "docs/images/features/collaboration-settings.png": "5ceac489335aed205c65ce9fe3de41eeda73513e83a6b20413c1293f7bf1b739",
    "docs/images/features/collaboration.png": "9f93d35f31e39bebdc39165d5c382ab18e45eba3ae9be3de700122e7d14bb50f",
    "docs/images/features/containers.png": "1cc2b8f937a5675b642a67506eb5cce9ef436e2c86507cf11df5d2ef3ad34d03",
    "docs/images/features/disk-expansion.png": "cfa4dafd7875012b5a4ecd4bf2b8cdc6e2a81b1a8284d57f70d593f32914a1bd",
    "docs/images/features/logs.png": "30e49f8bd1147213c4ae0082fe47b500d0b175f0b75745966cb2b66697448386",
    "docs/images/features/monitoring.png": "7ab631c633afbb3d9783d7eacf6a6c0f1d8862bb88712742bc6137f955e53bc4",
    "docs/images/features/overview.png": "6217881b68551d3949b13c30e9aa8c47d5c9d9c37632c8f465132087aefb66a3",
    "docs/images/features/patching.png": "46f256dbd428da5959b91e798e3697461f5bbf8082600684baa4c08c0aa517b5",
    "docs/images/features/pwa-install.png": "1f793e93ed15178b3249d27c17d985efd24803b3978d8c88ad924877e50485ee",
    "docs/images/features/pwa-offline.png": "4bd503a3d6feaa67f529ebb086fd232ccbc04e5cd8a803505379a0434a1d59c8",
    "docs/images/features/security.png": "0523c20441dc2370dea24d666785bba5f671fc6e29e215fb30eb811524614b2b",
    "docs/images/features/servers.png": "455acc6943908374b1822ad2334d6abd30cda179cf446c7431513d80b0744e19",
    "docs/images/features/traffic-map.png": "30005cbf3832f7a972ee2fdf2296eecd814044c71ff3da0ad0d307ea35286ee7",
    "docs/images/features/traffic-settings.png": "1861716f091ab49d8b132e459c50d64bc2109fe40fe6592e1fc267b40bdaf360",
    "docs/images/features/vpn.png": "a2fff03ec8a2685bf34504d66fb5dc61ac26a25db0de2a078751744f70f4e105",
    "frontend/public/icons/apple-touch-icon.png": "8233b978a34ab33c8435512921af34036fe824a394252dc7e2bd6ea36c0b4a6b",
    "frontend/public/icons/favicon-32.png": "dab29e244add883ec8373d90a945131ed4277fd5d649cad639c35a733810e1bc",
    "frontend/public/icons/icon-192.png": "06b465a14660c99a309dbbc71c627555045f65f2ed60d8462f8f33ddfa8da85d",
    "frontend/public/icons/icon-512.png": "6d5e56d76c5bb938e71372b60071c8d4568d7ea4a600ce343afcd6ede2946768",
    "frontend/public/icons/maskable-512.png": "6d5e56d76c5bb938e71372b60071c8d4568d7ea4a600ce343afcd6ede2946768",
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
