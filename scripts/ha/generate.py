#!/usr/bin/env python3
"""Generate a fresh three-host HA installation; never read live deployment data.

Requires PyYAML (already included in the installer's Ansible environment).
Generated files contain credentials: keep the output outside the source tree.
"""
import argparse
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets

import yaml

ROOT = Path(__file__).resolve().parents[2]


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with path.open('x') as f:
        os.chmod(path, 0o600)
        f.write(value if isinstance(value, str) else yaml.safe_dump(value, sort_keys=False))


def validate(config):
    if set(config) != {'nodes', 'install_dir', 'data_root'}:
        raise ValueError('Expected nodes, install_dir and data_root only')
    nodes = config['nodes']
    if len(nodes) != 3:
        raise ValueError('Exactly two application/database nodes and one witness are required')
    names, ips = set(), set()
    for node in nodes:
        if set(node) != {'name', 'ip'} or not re.fullmatch(r'[a-z][a-z0-9-]{0,31}', node['name']):
            raise ValueError('Each node needs a safe unique name and IPv4 address')
        ip = ipaddress.IPv4Address(node['ip'])
        if ip.is_multicast or ip.is_unspecified or ip.is_loopback or ip == ipaddress.IPv4Address('255.255.255.255'):
            raise ValueError('Use reachable unicast host addresses')
        names.add(node['name']); ips.add(str(ip))
    if len(names) != 3 or len(ips) != 3:
        raise ValueError('Node names and addresses must be unique')
    for key in ['install_dir', 'data_root']:
        if not re.fullmatch(r'/[A-Za-z0-9_-]+(?:/[A-Za-z0-9_-]+)+', config[key]):
            raise ValueError(f'{key} must be a dedicated absolute directory')
    return nodes


def generate(config, output):
    nodes = validate(config)
    output = Path(output).resolve()
    if output == ROOT or ROOT in output.parents:
        raise ValueError('Runtime output must be outside the source repository')
    if output.exists():
        raise FileExistsError('Output exists; refusing to rotate secrets or overwrite cluster configuration')
    install, data = config['install_dir'], config['data_root']
    credentials = {key: secrets.token_hex(32) for key in [
        'POSTGRES_PASSWORD', 'REDIS_PASSWORD', 'API_SECRET_KEY',
        'GRAFANA_ADMIN_PASSWORD', 'PATRONI_RESTAPI_PASSWORD', 'REPLICATION_PASSWORD']}
    common = dict(credentials, POSTGRES_USER='opscenter', POSTGRES_DB='opscenter',
                  DATA_ROOT=data, DATABASE_HOST='pg-router',
                  PATRONI_NODES=','.join(n['ip'] for n in nodes[:2]),
                  REDIS_NODES=','.join(n['ip'] for n in nodes[:2]),
                  REDIS_SENTINELS=','.join(n['ip'] + ':26379' for n in nodes),
                  REDIS_MASTER_NAME='ops-center-redis', POSTGRES_VIP='pg-router',
                  BIND_ADDRESS='127.0.0.1', PROXY_HTTP_PORT='8080', TZ='UTC',
                  IMAGE_PREFIX='ops-center', IMAGE_TAG='local')
    cluster = ','.join(f"{n['name']}=http://{n['ip']}:2380" for n in nodes)
    output.mkdir(mode=0o700, parents=True)
    for index, node in enumerate(nodes):
        dest = output / node['name']; ip = node['ip']
        environment = dict(common, OPS_LOCAL_HOSTNAME=node['name'], HOST_IP=ip)
        # The witness does not receive database, application or provider credentials.
        if index == 2:
            environment = {'REDIS_PASSWORD': credentials['REDIS_PASSWORD']}
        write(dest / '.env', ''.join(f'{k}={v}\n' for k, v in environment.items()))
        services = {
            'etcd': {
                'image': 'gcr.io/etcd-development/etcd:v3.5.17',
                'network_mode': 'host', 'restart': 'unless-stopped',
                'environment': {
                    'ETCD_NAME': node['name'], 'ETCD_INITIAL_CLUSTER': cluster,
                    'ETCD_INITIAL_CLUSTER_STATE': 'new', 'ETCD_INITIAL_CLUSTER_TOKEN': 'ops-center-ha',
                    'ETCD_INITIAL_ADVERTISE_PEER_URLS': f'http://{ip}:2380',
                    'ETCD_LISTEN_PEER_URLS': f'http://{ip}:2380',
                    'ETCD_LISTEN_CLIENT_URLS': f'http://{ip}:2379',
                    'ETCD_ADVERTISE_CLIENT_URLS': f'http://{ip}:2379', 'ETCD_DATA_DIR': '/etcd-data'},
                'volumes': ['etcd-data:/etcd-data'],
            },
        }
        if index < 2:
            patroni = {
                'scope': 'ops-center-postgres', 'name': node['name'],
                'restapi': {'listen': f'{ip}:8008', 'connect_address': f'{ip}:8008',
                            'authentication': {'username': 'patroni_admin', 'password': credentials['PATRONI_RESTAPI_PASSWORD']}},
                'etcd3': {'hosts': [f"{n['ip']}:2379" for n in nodes]},
                'bootstrap': {'dcs': {'ttl': 30, 'loop_wait': 10, 'retry_timeout': 10,
                    'maximum_lag_on_failover': 1048576,
                    'postgresql': {'use_pg_rewind': True, 'use_slots': True,
                        'parameters': {'password_encryption': 'scram-sha-256'}}},
                    'initdb': ['data-checksums', {'encoding': 'UTF8'}]},
                'postgresql': {'listen': f'{ip}:5432', 'connect_address': f'{ip}:5432',
                    'data_dir': '/var/lib/postgresql/data', 'pgpass': '/tmp/pgpass',
                    'authentication': {
                        'superuser': {'username': 'opscenter', 'password': credentials['POSTGRES_PASSWORD']},
                        'replication': {'username': 'replicator', 'password': credentials['REPLICATION_PASSWORD']}},
                    'pg_hba': ['local all all trust'] + [
                        f"host {db} {user} {n['ip']}/32 scram-sha-256"
                        for n in nodes[:2] for db, user in [('all', 'all'), ('replication', 'replicator')]]},
            }
            write(dest / 'patroni.yml', patroni)
            services['patroni'] = {
                'image': '${IMAGE_PREFIX:-ops-center}/postgres-ha:${IMAGE_TAG:-local}',
                'build': {'context': f'{install}/ha/postgres'},
                'network_mode': 'host', 'restart': 'unless-stopped',
                'volumes': ['./patroni.yml:/etc/patroni-bootstrap.yml:ro,Z', 'postgres-data:/var/lib/postgresql/data'],
            }
            redis_config = (f'bind {ip} 127.0.0.1\nprotected-mode yes\nport 6379\ndir /data\n'
                            f"requirepass {credentials['REDIS_PASSWORD']}\nmasterauth {credentials['REDIS_PASSWORD']}\n"
                            'appendonly yes\nmaxmemory 256mb\nmaxmemory-policy noeviction\n')
            if index == 1:
                redis_config += f"replicaof {nodes[0]['ip']} 6379\n"
            write(dest / 'redis.conf', redis_config)
            services['redis'] = redis_service('redis', ip)
        sentinel = (f'bind {ip} 127.0.0.1\nprotected-mode no\nport 26379\ndir /data\n'
                    f"sentinel monitor ops-center-redis {nodes[0]['ip']} 6379 2\n"
                    f"sentinel auth-pass ops-center-redis {credentials['REDIS_PASSWORD']}\n"
                    f'sentinel announce-ip {ip}\nsentinel down-after-milliseconds ops-center-redis 5000\n'
                    'sentinel failover-timeout ops-center-redis 60000\nsentinel parallel-syncs ops-center-redis 1\n')
        write(dest / 'sentinel.conf', sentinel)
        services['sentinel'] = redis_service('sentinel', ip)
        for service in services.values():
            service['security_opt'] = ['no-new-privileges:true']
        volumes = {'etcd-data': {}, 'sentinel-data': {}}
        if index < 2:
            volumes.update({'postgres-data': {}, 'redis-data': {}})
        write(dest / 'compose.ha.yml', {'name': 'ops-center-ha', 'services': services, 'volumes': volumes})
        if index < 2:
            app = yaml.safe_load((ROOT / 'compose.yml').read_text())
            app['services'].pop('postgres'); app['services'].pop('redis')
            for service in app['services'].values():
                deps = service.get('depends_on', {})
                deps.pop('postgres', None); deps.pop('redis', None)
                if 'environment' in service and 'REDIS_URL' in service['environment']:
                    # All consumers use Sentinel; fallback remains a valid configured host.
                    service['environment']['REDIS_URL'] = f"redis://:${{REDIS_PASSWORD}}@{nodes[0]['ip']}:6379/0"
                # Generated compose lives in ha-runtime; source-relative mounts/builds must stay in the checkout.
                if isinstance(service.get('build'), dict):
                    context = service['build']['context']
                    service['build']['context'] = str(Path(install) / context)
                service['volumes'] = [v.replace('./', install + '/', 1) if v.startswith('./') else v
                                      for v in service.get('volumes', [])]
            app['services']['pg-router'] = {
                'image': 'haproxy:3.0.11-alpine', 'restart': 'unless-stopped',
                'networks': ['database'], 'security_opt': ['no-new-privileges:true'],
                'volumes': ['./haproxy.cfg:/usr/local/etc/haproxy/haproxy.cfg:ro,Z'],
                'user': '0:0',
            }
            write(dest / 'compose.app.yml', app)
            write(dest / 'haproxy.cfg', 'global\n  log stdout format raw local0\n  user haproxy\n  group haproxy\n'
                  'defaults\n  mode tcp\n  timeout connect 5s\n  timeout client 1m\n  timeout server 1m\n'
                  'listen postgres\n  bind :5432\n  option httpchk GET /primary\n  http-check expect status 200\n'
                  + ''.join(f"  server {n['name']} {n['ip']}:5432 check port 8008 inter 2s fall 3 rise 2 on-marked-down shutdown-sessions\n" for n in nodes[:2]))
    return output


def redis_service(kind, ip):
    # Copy only once. CONFIG REWRITE and Sentinel's learned topology survive restarts.
    # No credential is placed in process arguments or baked into an image.
    script = ('if [ ! -f /data/runtime.conf ]; then cp /seed/config /data/runtime.conf; '
              'chown redis:redis /data/runtime.conf; chmod 600 /data/runtime.conf; fi; '
              'exec /usr/local/bin/docker-entrypoint.sh redis-server /data/runtime.conf')
    if kind == 'sentinel':
        script += ' --sentinel'
    return {'image': 'redis:7.4.2-bookworm', 'network_mode': 'host',
            'restart': 'unless-stopped', 'entrypoint': ['/bin/sh', '-ec', script],
            'volumes': [f'./{kind}.conf:/seed/config:ro,Z', f'{kind}-data:/data']}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('config', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    try:
        generate(json.loads(args.config.read_text()), args.output)
    except (ValueError, OSError) as exc:
        parser.exit(1, f'HA generation failed: {exc}\n')
    print('Fresh HA configuration created. Treat the entire output as secret; see docs/ha.md.')
