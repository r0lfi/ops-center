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
    "docs/images/mcp-clients.png": "7781b5ff3256ccf509027ee77a54e13a3d899f83c216312ec4c0b39ba2740e98",
    "docs/images/mcp-agents.png": "ec0c9121910d0bdc4af59cd965473504696f6d961acc568186ab67085fb8c611",
    "docs/images/mcp-approvals.png": "6526596a8ec74a4ade191c9b685ce22f1a5072ff615bfd4a87e7d8ed106d6235",
    "docs/images/mcp-consent.png": "b303ca231208faa7c34f0059749a89dd8d9b06310526061c7466b0a4270fa743",

    "docs/images/features/agents.png": "d22093d80d2775fee6a90024cb48a7954b6cdd60a300856b8486067a107ef6a6",
    "docs/images/features/ai-overview.png": "02975d35e8cb4b6e3830a636f6bbc5ee641ef551766168c34b9b0f13b2c14efd",
    "docs/images/features/ai-traffic.png": "252d50730a34f24751140900f18f07d18b9e859a6315f064a4db045bc52b2f33",
    "docs/images/features/automation.png": "271778e9dbdec4395cc3e01b98d9d1cf30f68c65fb5c87d7b4b9c10b3a93f37a",
    "docs/images/features/cluster.png": "3e85e92f0be29571b98864145eeaa5efbc52e7b4f20660a2478cdcd75fe539cd",
    "docs/images/features/collaboration-settings.png": "0d19a6b10bc7b67ad29c4f3aa34aa21482fc00b4c3775bf31ab316416ab97d52",
    "docs/images/features/collaboration.png": "3cc48032a667e2f6498361772eccf65c0b568d9db118936734b908a9b9f7c943",
    "docs/images/features/command-palette.png": "910da8022409e7a7b3665aff1fa7e773ba72cbefb1a15790e6d382c8eec937d9",
    "docs/images/features/containers.png": "2f7b09a55fe386f9c24e382d7596bc7ff47aca943858413f0401ae7b20fea63d",
    "docs/images/features/developer-agent.png": "3e85adf71642d24a251091afad04f4aeb06e7ce4f557141a54466e93ee4005fb",
    "docs/images/features/disk-expansion.png": "055a14faed3152bff4a77c5aea3bb526efac126fe586ae88cdb8fef0e1bf2638",
    "docs/images/features/incidents.png": "e6bd69a9bc39da1512fb21e114ead01077c9782b7a82a7c6acf442f835e9f69e",
    "docs/images/features/login-events.png": "a16c808a4495af57f16d1de2684ce99bb78f9698a357ccb3e4737130796da209",
    "docs/images/features/logs.png": "dddd7cffae7c8cab0b44b1ca925c5624e0249c707a50073c400ffdd78c98951d",
    "docs/images/features/mobile.png": "67f986bb6a1c08ad5069826100cb2dfc1e22c0433e52fa287c56899ac5383ff4",
    "docs/images/features/monitoring.png": "39b75d3a488ea712acbdf91738adf3befc55706d9f09096c59aa08de2a3e297b",
    "docs/images/features/ops-floor-3d.png": "661f8908ad59704a92397af3f4ae634007b0247c7554225c16a115cd94332a3f",
    "docs/images/features/ops-floor.png": "2d216c5f4634bb3053f28d9709c34c6c3097949972217611a51bba0042877fc5",
    "docs/images/features/overview.png": "14d829a5a9becdeedcd60962afb46c86c342c189ea7d917c1c7948b6f25d9185",
    "docs/images/features/patching.png": "3eb44f654544f398ab5386e048be206eec36f7b7953fcab8e3cd3dd3f704981a",
    "docs/images/features/personal-agent.png": "e0cdb2217364993e11fcb3a21f96eaa80482281e6af9ef28188f3d33e80ba401",
    "docs/images/features/pwa-install.png": "a336903e3203d1660f1317b73d957068e9c05ac96c5496146a5fce496a4ffbaf",
    "docs/images/features/pwa-offline.png": "a931d8e2d413e0344f4cba59dda335738ded16d39b4cbf92a6e6f03cdb8259e2",
    "docs/images/features/security.png": "3afa4de893581e236a159307288fce4fa63e1771b0ad26f63ee1ce66ab62bec1",
    "docs/images/features/servers.png": "982e0b3c5e65eb1282c2948982fff689a9cef25d526fc049d929616dff7ad72c",
    "docs/images/features/traffic-map.png": "d334cf0759b5d0afbc99df0f55e495148bcbd35ba142c148a9a26cdf7e55c59e",
    "docs/images/features/traffic-settings.png": "287355dbdd7319c8f95bd5874ff90451ab3103f8a799e2f7de0668ce2eee6f5d",
    "docs/images/features/vpn.png": "5cf8204e18fa4c988bed0899ae24a58c54fe6e43da3fde4d76c950dc7c48109e",

    "frontend/public/icons/apple-touch-icon.png": "8233b978a34ab33c8435512921af34036fe824a394252dc7e2bd6ea36c0b4a6b",
    "frontend/public/icons/favicon-32.png": "dab29e244add883ec8373d90a945131ed4277fd5d649cad639c35a733810e1bc",
    "frontend/public/icons/icon-192.png": "06b465a14660c99a309dbbc71c627555045f65f2ed60d8462f8f33ddfa8da85d",
    "frontend/public/icons/icon-512.png": "6d5e56d76c5bb938e71372b60071c8d4568d7ea4a600ce343afcd6ede2946768",
    "frontend/public/icons/maskable-512.png": "6d5e56d76c5bb938e71372b60071c8d4568d7ea4a600ce343afcd6ede2946768",
    # Silkscreen 5.1.0 from @fontsource/silkscreen (OFL-1.1, see fonts/OFL.txt).
    "frontend/src/components/ops-floor/fonts/silkscreen-latin-400-normal.woff2": "11111c0d26af329a7cd21413d84956a8a0d93f543b14fba47a7d4181a66f5556",
    "frontend/src/components/ops-floor/fonts/silkscreen-latin-700-normal.woff2": "023d7c8fa71ccc0d83dad107fad75b6c9aedd3c1b4717aabbb68fdc39df0e683",
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
