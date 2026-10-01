import importlib.util
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]

def module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / f'{name}.py')
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded

notes = module('release-notes')

CHANGELOG = '''# Changelog

## [Unreleased]

- Not released yet.

## [0.2.0-rc.1] - 2026-10-20

- Candidate.

## [0.1.0] - 2026-10-02

### Added

- First release.

[0.1.0]: https://github.com/r0lfi/ops-center/releases/tag/v0.1.0
'''

def test_tags_must_be_semantic_versions():
    assert notes.parse_tag('v0.1.0') == ('0.1.0', False)
    assert notes.parse_tag('v1.2.3-rc.1') == ('1.2.3-rc.1', True)
    for tag in ('0.1.0', 'v1', 'v1.2', 'v01.2.3', 'v1.2.3-', 'release-1.0.0', 'v1.2.3\n'):
        with pytest.raises(SystemExit):
            notes.parse_tag(tag)

def test_changelog_section_is_exact_and_bounded():
    assert notes.changelog_section('0.1.0', CHANGELOG) == '### Added\n\n- First release.'
    assert notes.changelog_section('0.2.0-rc.1', CHANGELOG) == '- Candidate.'
    # Unreleased entries and partial version matches never count as a release.
    for version in ('0.2.0', '0.1', '1.0.0'):
        with pytest.raises(SystemExit):
            notes.changelog_section(version, CHANGELOG)
    with pytest.raises(SystemExit):
        notes.changelog_section('0.3.0', CHANGELOG + '\n## [0.3.0] - 2026-11-01\n\n')

def test_notes_name_every_image_and_only_promise_latest_for_stable(monkeypatch, tmp_path):
    changelog = tmp_path / 'CHANGELOG.md'
    changelog.write_text(CHANGELOG)
    monkeypatch.setattr(notes, 'CHANGELOG', changelog)
    monkeypatch.setattr(notes, 'commits', lambda tag, previous: '- Example commit (abc1234)')
    stable = notes.notes('v0.1.0', 'ghcr.io/r0lfi/ops-center')
    for image in ('api', 'frontend', 'worker', 'ai-worker', 'security-worker', 'postgres-ha'):
        assert f'ghcr.io/r0lfi/ops-center/{image}:0.1.0' in stable
    assert '`latest`' in stable and 'First release.' in stable
    assert 'ops_image_tag=0.1.0' in stable and '--branch v0.1.0' in stable
    candidate = notes.notes('v0.2.0-rc.1', 'ghcr.io/r0lfi/ops-center', 'v0.1.0')
    assert 'prerelease' in candidate and 'compare/v0.1.0...v0.2.0-rc.1' in candidate
    # Shell continuations must survive into the published Markdown.
    assert re.search(r'--ask-become-pass \\\n', stable)
