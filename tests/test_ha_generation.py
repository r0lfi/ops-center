import importlib.util
import json
from pathlib import Path
import stat

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('ha_generate', ROOT / 'scripts/ha/generate.py')
ha = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ha)


def config():
    return {'nodes': [{'name': f'node-{i}', 'ip': f'192.0.2.{i}'} for i in (1, 2, 3)],
            'install_dir': '/opt/ops-center', 'data_root': '/var/lib/ops-center'}


def test_fresh_cluster_is_connected_and_private(tmp_path):
    out = ha.generate(config(), tmp_path / 'cluster')
    app = yaml.safe_load((out / 'node-1/compose.app.yml').read_text())
    assert 'postgres' not in app['services'] and 'redis' not in app['services']
    assert app['services']['pg-router']['networks'] == ['database']
    for service in app['services'].values():
        assert not ({'postgres', 'redis'} & set(service.get('depends_on', {})))
    assert app['services']['ops-api']['build']['context'] == '/opt/ops-center/backend'
    assert app['services']['ops-worker']['build']['context'] == '/opt/ops-center'
    assert len([s for s in app['services'].values() if 'REDIS_SENTINELS' in s.get('environment', {})]) == 5
    witness = yaml.safe_load((out / 'node-3/compose.ha.yml').read_text())
    assert set(witness['services']) == {'etcd', 'sentinel'}
    assert 'API_SECRET_KEY' not in (out / 'node-3/.env').read_text()
    envs = [dict(line.split('=', 1) for line in (out / f'node-{i}/.env').read_text().splitlines()) for i in (1, 2)]
    assert envs[0]['API_SECRET_KEY'] == envs[1]['API_SECRET_KEY']
    assert envs[0]['OPS_LOCAL_HOSTNAME'] != envs[1]['OPS_LOCAL_HOSTNAME']
    assert 'replicaof 192.0.2.1 6379' in (out / 'node-2/redis.conf').read_text()
    assert 'replicaof' not in (out / 'node-1/redis.conf').read_text()
    assert 'maxmemory-policy noeviction' in (out / 'node-1/redis.conf').read_text()
    pg = yaml.safe_load((out / 'node-1/patroni.yml').read_text())
    assert len(pg['etcd3']['hosts']) == 3
    assert all('0.0.0.0/0' not in row for row in pg['postgresql']['pg_hba'])
    for f in out.rglob('*'):
        assert stat.S_IMODE(f.stat().st_mode) == (0o700 if f.is_dir() else 0o600)
    before = (out / 'node-1/.env').read_bytes()
    with pytest.raises(FileExistsError):
        ha.generate(config(), out)
    assert (out / 'node-1/.env').read_bytes() == before
    other = ha.generate(config(), tmp_path / 'other')
    assert before != (other / 'node-1/.env').read_bytes()


@pytest.mark.parametrize('bad', ['$(id)', 'node\nattack', '../secret'])
def test_invalid_names_do_not_create_output(tmp_path, bad):
    cfg = config(); cfg['nodes'][0]['name'] = bad
    with pytest.raises(ValueError):
        ha.generate(cfg, tmp_path / 'out')
    assert not (tmp_path / 'out').exists()


def test_duplicate_addresses_and_repository_output_rejected(tmp_path):
    cfg = config(); cfg['nodes'][1]['ip'] = cfg['nodes'][0]['ip']
    with pytest.raises(ValueError):
        ha.generate(cfg, tmp_path / 'out')
    with pytest.raises(ValueError):
        ha.generate(config(), ROOT / 'ha-runtime')
