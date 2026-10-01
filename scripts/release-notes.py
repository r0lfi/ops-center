#!/usr/bin/env python3
"""Validate a release tag and write its GitHub Release notes.

    python3 scripts/release-notes.py check v0.1.0
        Prints version=..., prerelease=true|false for $GITHUB_OUTPUT.
    python3 scripts/release-notes.py notes v0.1.0 IMAGE_PREFIX [PREVIOUS_TAG]
        Prints the release notes as Markdown.

A release needs a matching "## [X.Y.Z]" section in CHANGELOG.md, so the notes
always say what changed in words, not only as a commit list. Nothing here reads
credentials or the environment file.
"""
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHANGELOG = ROOT / 'CHANGELOG.md'
TAG = re.compile(r'v(?P<version>(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?P<pre>-[0-9A-Za-z.-]+)?)')
IMAGES = (
    ('api', 'FastAPI backend and database migrations'),
    ('frontend', 'Web interface served by Nginx'),
    ('worker', 'Ansible worker and scheduler'),
    ('ai-worker', 'AI agent worker'),
    ('security-worker', 'Security scanning and Docker operations'),
    ('postgres-ha', 'PostgreSQL 17 + Patroni, only for the optional HA deployment'),
)


def parse_tag(tag):
    match = TAG.fullmatch(tag)
    if not match:
        raise SystemExit(f'{tag!r} is not a release tag; use vMAJOR.MINOR.PATCH or vMAJOR.MINOR.PATCH-PRERELEASE')
    return match['version'], bool(match['pre'])


def changelog_section(version, text):
    """Return the body under "## [version]", without the heading."""
    heading = re.compile(rf'^## \[{re.escape(version)}\][^\n]*\n', re.M)
    match = heading.search(text)
    if not match:
        raise SystemExit(f'CHANGELOG.md has no "## [{version}]" section. Move the Unreleased entries there before tagging.')
    following = re.compile(r'^## \[', re.M).search(text, match.end())
    body = text[match.end():following.start() if following else len(text)]
    # Link reference definitions belong to the whole file, not to one release.
    body = re.sub(r'^\[[^\]]+\]: \S+\s*$', '', body, flags=re.M).strip()
    if not body:
        raise SystemExit(f'The CHANGELOG.md section for {version} is empty.')
    return body


def commits(tag, previous):
    revision_range = f'{previous}..{tag}' if previous else tag
    log = subprocess.run(
        ['git', 'log', '--no-merges', '--format=- %s (%h)', revision_range],
        cwd=ROOT, check=True, capture_output=True, text=True,
    ).stdout.strip()
    return log or '- No commits.'


def notes(tag, prefix, previous=None):
    version, prerelease = parse_tag(tag)
    section = changelog_section(version, CHANGELOG.read_text())
    rows = '\n'.join(f'| `{name}` | `{prefix}/{name}:{version}` | {purpose} |' for name, purpose in IMAGES)
    channel = (
        'This is a **prerelease**. It is published only as its exact version; `latest` and the `X.Y`/`X` aliases are unchanged.'
        if prerelease else
        f'Also tagged `v{version}`, the `MAJOR.MINOR` and `MAJOR` aliases, and `latest`.'
    )
    compare = (
        f'**Full comparison**: https://github.com/r0lfi/ops-center/compare/{previous}...{tag}'
        if previous else 'First release.'
    )
    return f'''{section}

## Container images

Ops Center runs as several services. Every image below is published as `{version}`. {channel}

| Component | Image | Purpose |
| --- | --- | --- |
{rows}

```bash
docker pull {prefix}/api:{version}
```

## Install or upgrade

The installer installs and upgrades with the same command. Re-running it keeps `.env`, the data directory and existing administrators. Back up first when upgrading (`sudo bash scripts/backup/backup.sh`).

```bash
git clone --branch {tag} https://github.com/r0lfi/ops-center.git   # or, in an existing clone: git fetch --tags && git checkout {tag}
cd ops-center
bash scripts/install.sh --ask-become-pass \\
  -e ops_build_images=false \\
  -e ops_image_prefix={prefix} \\
  -e ops_image_tag={version}
```

The API applies database migrations when it starts. Changing the tag back does not undo them; restore a backup to roll back.

## Commits

{commits(tag, previous)}

{compare}
'''


def main(argv):
    if len(argv) >= 2 and argv[0] == 'check':
        version, prerelease = parse_tag(argv[1])
        changelog_section(version, CHANGELOG.read_text())
        print(f'version={version}')
        print(f'prerelease={str(prerelease).lower()}')
    elif len(argv) in (3, 4) and argv[0] == 'notes':
        print(notes(argv[1], argv[2], argv[3] if len(argv) == 4 and argv[3] else None))
    else:
        raise SystemExit(__doc__)


if __name__ == '__main__':
    main(sys.argv[1:])
