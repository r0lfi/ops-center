import importlib.util
import json
import os
import stat
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / f'{name}.py')
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded

def test_rejects_runtime_files_and_private_networks():
    check = module('check-release').check_file
    for name in ('.env', 'backend/.env.local', 'secrets/token', 'deploy/inventory.ini', 'backup.tar.gz', 'data/state.db'):
        assert check(name, b'example')
    # Construct the private address so this negative test is itself publishable.
    assert check('config.py', ('192.' + '168.' + '1.23').encode())
    assert not check('.env.example', b'API_SECRET_KEY=\n')
    assert not check('README.md', b'Use ops.example.org or 192.0.2.10')

def test_secrets_are_unique_private_and_preserved(tmp_path):
    generator = module('generate-env')
    a, b = tmp_path/'a', tmp_path/'b'
    assert generator.create_env(a, {'TZ':'UTC'})
    assert generator.create_env(b, {'TZ':'UTC'})
    assert a.read_text() != b.read_text()
    assert stat.S_IMODE(a.stat().st_mode) == 0o600
    before = a.read_bytes()
    assert not generator.create_env(a, {'TZ':'UTC'})
    assert a.read_bytes() == before

def test_environment_injection_is_rejected(tmp_path):
    generator = module('generate-env')
    import pytest
    for unsafe in ('UTC\nEVIL=yes', '$(id)', 'bad value'):
        with pytest.raises(ValueError):
            generator.create_env(tmp_path/'env', {'TZ':unsafe})
        assert not (tmp_path/'env').exists()


def test_generated_ha_data_and_external_screenshots_are_rejected():
    checker = module('check-release')
    assert checker.check_file('ha-runtime/node-1/patroni.yml', b'config')
    assert checker.check_file('ha-inventory.json', b'{}')
    url = 'https://github.com/' + 'user-attachments/assets/example'
    assert checker.check_file('README.md', url.encode())
