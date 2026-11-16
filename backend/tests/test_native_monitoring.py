"""Identity boundaries, honest source states and bounded log history."""
import asyncio
import json
import time
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.deps import get_current_user
from app.api.routes import logs, monitoring as routes
from app.db.session import get_db
from app.models.container import Container
from app.models.host import Host
from app.services import monitoring as service
from app.services.container_inventory import monitoring_metadata


class Rows:
    def __init__(self, rows): self.rows = rows
    def scalars(self): return self
    def all(self): return self.rows


class DB:
    def __init__(self, hosts, containers): self.hosts, self.containers = hosts, containers
    async def get(self, model, id):
        return next((row for row in (self.hosts if model is Host else self.containers) if row.id == id), None)
    async def execute(self, query):
        model = query.column_descriptions[0]['entity']
        rows = self.hosts if model is Host else self.containers if model is Container else []
        params = query.compile().params
        if 'hostname_1' in params: rows = [h for h in rows if h.hostname == params['hostname_1']]
        return Rows(rows)


@pytest.fixture
def setup(monkeypatch):
    hosts = [Host(id=uuid4(), hostname=name, ip_address=f'10.100.0.{i}', monitoring_enabled=True,
                  log_collection_enabled=True, is_docker_host=True, container_inventory_at=None)
             for i,name in enumerate(['alpha','beta'],1)]
    containers = [Container(id=uuid4(), hostname=h.hostname, name='same-name', image='test:1', status='running',
                            health=None, restart_count=0, runtime_id=str(i)*64, monitoring_metadata={}, last_seen=None)
                  for i,h in enumerate(hosts,1)]
    db = DB(hosts, containers)
    app = FastAPI(); app.include_router(routes.router); app.include_router(logs.router)
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(role='viewer')
    app.dependency_overrides[get_db] = lambda: db
    return TestClient(app), hosts, containers, db, app


def test_identity_mapping_never_uses_container_name(setup, monkeypatch):
    _,hosts,containers,_,_ = setup
    monkeypatch.setattr(service, 'get_settings', lambda: SimpleNamespace(monitoring_container_targets={'collector-a':str(hosts[0].id),'collector-b':str(hosts[1].id)}))
    batch = {'series': {'cpu': [
        {'metric': {'instance':'collector-a', 'id':'/docker/'+containers[0].runtime_id, 'name':'same-name'}, 'values':[[10,'225']]},
        {'metric': {'instance':'collector-b', 'id':'/docker/'+containers[1].runtime_id, 'name':'same-name'}, 'values':[[10,'45']]},
        {'metric': {'instance':'collector-a', 'id':'/docker/'+containers[1].runtime_id, 'name':'same-name'}, 'values':[[10,'999']]},
        {'metric': {'instance':'unmapped', 'id':'/docker/'+containers[0].runtime_id}, 'values':[[10,'888']]},
    ]}}
    result = service.bind_containers(batch,hosts,containers)
    assert result[str(containers[0].id)]['cpu'][0]['points'] == [[10,225]]
    assert result[str(containers[1].id)]['cpu'][0]['points'] == [[10,45]]
    containers[0].runtime_id = 'f'*64
    assert not service.bind_containers(batch,hosts,containers)[str(containers[0].id)]


def test_host_labels_fail_closed_on_unknown_id_and_ambiguous_names(setup):
    _,hosts,_,_,_ = setup
    assert service.host_for_labels({'host_id':str(uuid4()),'instance':'alpha'},hosts) is None
    assert service.host_for_labels({'instance':'alpha'},hosts) is hosts[0]
    hosts[1].hostname = 'alpha'
    assert service.host_for_labels({'instance':'alpha'},hosts) is None
    assert service.host_for_labels({'host_id':str(hosts[0].id)},hosts) is hosts[0]


def test_no_zero_or_nan_points_and_inventory_secrets_are_excluded():
    assert service.points({'values': [[1,'NaN'],[2,'+Inf'],[3,'0'],[4,'12.5']]}) == [[3,0],[4,12.5]]
    data = monitoring_metadata({'Config':{'Env':['TOKEN=private'],'Cmd':['secret-command'],'Labels':{'token':'secret','com.docker.compose.project':'app'}},
                                'State':{'Health':{'Log':[{'Output':'secret'}]},'ExitCode':0},'HostConfig':{'Memory':0}})
    assert 'secret' not in json.dumps(data) and 'private' not in json.dumps(data)
    assert data['memory_limit'] is None and data['stack'] == 'app'


def test_api_auth_and_identity_validation_precede_sources(setup, monkeypatch):
    client,hosts,containers,_,app = setup
    async def unexpected(*args,**kwargs): raise AssertionError('should not query source')
    monkeypatch.setattr(routes,'range_batch',unexpected)
    assert client.get('/monitoring/fleet',params={'host_id':str(uuid4())}).status_code == 404
    assert client.get('/logs',params={'container_id':str(containers[0].id),'host_id':str(hosts[1].id)}).status_code == 404
    assert client.get('/logs',params={'host':'unmanaged'}).status_code == 404
    assert client.get('/logs',params={'container_id':str(uuid4())}).status_code == 404
    assert client.get('/monitoring/fleet',params={'minutes':10081}).status_code == 422
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(role='invalid')
    assert client.get('/logs').status_code == 403
    app.dependency_overrides.pop(get_current_user)
    assert client.get('/monitoring/fleet').status_code == 401
    assert client.get('/logs').status_code == 401


def test_source_failure_is_not_offline_and_missing_samples_not_healthy(setup, monkeypatch):
    client,_,_,_,_ = setup
    async def batch(queries,*args): return {'series':{key:[] for key in queries},'errors':{'cpu':'failed'}}
    async def alerts(): return {'available':False,'alerts':[]}
    monkeypatch.setattr(routes,'range_batch',batch); monkeypatch.setattr(routes,'list_alerts',alerts)
    response = client.get('/monitoring/fleet').json()
    assert all(h['status'] == 'No data' and h['last_sample'] is None and h['alerts'] is None for h in response['hosts'])
    assert all(not c['metrics'] and c['health'] is None for c in response['containers'])
    async def unavailable(queries,*args): return {'series':{},'errors':{'up':'failed'}}
    monkeypatch.setattr(routes,'range_batch',unavailable)
    assert all(h['status'] == 'Source unavailable' for h in client.get('/monitoring/fleet').json()['hosts'])


def test_last_measurement_uses_sample_value_not_ui_refresh(setup,monkeypatch):
    client,hosts,_,_,_ = setup
    now = time.time(); sample = now-900
    async def batch(queries,*args):
        if 'up' not in queries: return {'series':{},'errors':{}}
        return {'series':{'up':[{'metric':{'instance':'alpha'},'values':[[now,'1']]}],
                          'last_sample':[{'metric':{'instance':'alpha'},'values':[[now,str(sample)]]}]},'errors':{}}
    async def alerts(): return {'available':True,'alerts':[]}
    monkeypatch.setattr(routes,'range_batch',batch); monkeypatch.setattr(routes,'list_alerts',alerts)
    host = client.get('/monitoring/fleet',params={'host_id':str(hosts[0].id)}).json()['hosts'][0]
    assert host['last_sample'] == sample and host['status'] == 'Stale'


def test_logql_is_escaped_and_never_falls_back_on_disabled_host(setup,monkeypatch):
    client,hosts,_,_,_ = setup
    hosts[0].log_collection_enabled = False
    result = client.get('/logs',params={'host_id':str(hosts[0].id)}).json()
    assert result['state'] == 'not_configured' and not result['lines']
    host = 'name"} |= "injected'
    assert logs._build_logql(host,None) == '{host='+json.dumps(host)+'}'


def test_docker_logs_use_exact_id_timestamps_window_and_cursor(setup,monkeypatch):
    from app.api.routes import containers as container_routes
    client,hosts,containers,_,_ = setup
    calls=[]
    start=1_700_000_000; stop=start+60
    async def read(host,name,tail,db,options=None):
        calls.append((host,name,tail,options))
        upper = logs._docker_line(options['until']+' bound',host,name)['timestamp']
        lines = [f'{logs._rfc3339((start+i)*logs.NS)} message {i}' for i in [3,2,1] if (start+i)*logs.NS < int(upper)]
        return {'ok':True,'lines':lines[-tail:]}
    monkeypatch.setattr(container_routes,'_docker_container_logs',read)
    params={'container_id':str(containers[0].id),'host_id':str(hosts[0].id),'minutes':15,'limit':2,'end':stop}
    first=client.get('/logs',params=params).json()
    assert [line['line'] for line in first['lines']] == ['message 3','message 2']
    assert calls[0][0:2] == ('alpha','1'*64) and first['next_cursor']
    second=client.get('/logs',params={**params,'cursor':first['next_cursor']}).json()
    assert [line['line'] for line in second['lines']] == ['message 1']
    assert client.get('/logs',params={**params,'cursor':'bad'}).status_code == 422


def test_loki_failure_and_inventory_only_query(setup,monkeypatch):
    client,_,_,_,_ = setup
    seen=[]
    def transport(request):
        seen.append(request.url.params['query'])
        return httpx.Response(503)
    original=httpx.AsyncClient
    monkeypatch.setattr(logs.httpx,'AsyncClient',lambda **kwargs: original(transport=httpx.MockTransport(transport),**kwargs))
    response=client.get('/logs',params={'search':'a"b'}).json()
    assert response['state'] == 'unavailable'
    assert seen[0].startswith('{host=~"alpha|beta"}') and '|= "a\\"b"' in seen[0]


def test_range_queries_cached_bounded_and_errors_partial(monkeypatch):
    calls=[]
    def transport(request):
        calls.append(request)
        if request.url.params['query'] == 'bad': return httpx.Response(500)
        return httpx.Response(200,json={'status':'success','data':{'result':[]}})
    original=httpx.AsyncClient
    monkeypatch.setattr(service.httpx,'AsyncClient',lambda **kwargs: original(transport=httpx.MockTransport(transport),**kwargs))
    service._CACHE.clear()
    async def run():
        first,second=await asyncio.gather(service.range_batch({'cpu':'ok','memory':'bad'},10080,1000),service.range_batch({'cpu':'ok','memory':'bad'},10080,1000))
        assert first == second and first['errors'] == {'memory':'Metrics source unavailable or query failed'}
    asyncio.run(run())
    assert len(calls)==2 and all(float(r.url.params['step']) >= 1260 for r in calls)


def test_runtime_snapshot_is_allowlisted_id_bound_and_not_cpu_capped():
    from app.services.container_inventory import runtime_stats
    full_id='a'*64
    snapshot=runtime_stats(full_id,[{'ID':'a'*12,'CPUPerc':'234.5%','MemUsage':'128MiB / 8GiB','NetIO':'2MB / 3MB','secret':'private'}])
    assert snapshot['cpu_percent']==234.5 and snapshot['memory_bytes']==128*1024**2
    assert 'secret' not in snapshot and snapshot['captured_at']
    assert runtime_stats('b'*64,[{'ID':'a'*12}]) is None
    assert runtime_stats(full_id,[{'ID':'a'*12},{'ID':'a'*12}]) is None
    host=SimpleNamespace(id=uuid4(),hostname='alpha')
    container=SimpleNamespace(id=uuid4(),name='app',image='app:1',status='running',health=None,restart_count=0,last_seen=None,runtime_id=full_id,monitoring_metadata={'runtime_stats':snapshot})
    assert 'runtime_stats' not in service.container_record(container,host,historical=True)['metadata']


def test_container_logging_disabled_and_duplicate_host_labels_fail_closed(setup):
    client,hosts,containers,_,_=setup
    containers[0].monitoring_metadata={'log_driver':'none'}
    response=client.get('/logs',params={'container_id':str(containers[0].id)}).json()
    assert response['state']=='not_configured' and not response['lines']
    hosts[1].hostname=hosts[0].hostname
    assert client.get('/logs',params={'host_id':str(hosts[0].id)}).status_code==409


def test_equal_timestamp_log_cursor_keeps_remaining_entries(setup,monkeypatch):
    client,hosts,_,_,_=setup
    ts=1_700_000_001*logs.NS
    def transport(request):
        return httpx.Response(200,json={'status':'success','data':{'result':[{'stream':{'host':'alpha'},'values':[[str(ts),text] for text in ['c','b','a']]}]}})
    original=httpx.AsyncClient
    monkeypatch.setattr(logs.httpx,'AsyncClient',lambda **kwargs: original(transport=httpx.MockTransport(transport),**kwargs))
    params={'host_id':str(hosts[0].id),'minutes':15,'end':1_700_000_100,'limit':2}
    first=client.get('/logs',params=params).json()
    second=client.get('/logs',params={**params,'cursor':first['next_cursor']}).json()
    assert [x['line'] for x in first['lines']]==['c','b']
    assert [x['line'] for x in second['lines']]==['a']


def test_container_history_distinguishes_mapping_missing_data_source_failure_and_staleness(setup,monkeypatch):
    _,hosts,_,_,_=setup
    mapping={}
    monkeypatch.setattr(service,'get_settings',lambda:SimpleNamespace(monitoring_container_targets=mapping))
    batch={'series':{},'errors':{}}
    assert service.container_metrics_state(hosts[0],{},batch)=='Not configured'
    mapping['collector']=str(hosts[0].id)
    assert service.container_metrics_state(hosts[0],{},batch)=='No data'
    batch['errors']={'cpu':'source failed'}
    assert service.container_metrics_state(hosts[0],{},batch)=='Source unavailable'
    assert service.container_metrics_state(hosts[0],{'memory':[]},batch)=='Partial data'
    batch['errors']={}
    assert service.container_metrics_state(hosts[0],{'last_sample':[{'points':[[time.time(),time.time()-600]]}]},batch)=='Stale'
def test_shared_source_configuration_applies_to_native_and_existing_routes():
    import os
    import subprocess
    import sys
    code = """
from app.services.monitoring import PROMETHEUS_URL
from app.api.routes.metrics import PROMETHEUS_URL as legacy
from app.api.routes.logs import LOKI_URL
assert PROMETHEUS_URL == legacy == 'http://shared-metrics.example:9090'
assert LOKI_URL == 'http://shared-logs.example:3100'
"""
    subprocess.run([sys.executable, "-c", code], check=True, capture_output=True,
                   env={**os.environ, "PROMETHEUS_QUERY_URL": "http://shared-metrics.example:9090/",
                        "LOKI_URL": "http://shared-logs.example:3100/ready/"})
