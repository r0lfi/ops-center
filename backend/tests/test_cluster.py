from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import HTTPException

from app.api.routes import cluster
from app.schemas.cluster import PatroniNodeStatus, SwitchoverRequest


@pytest.mark.asyncio
async def test_sentinel_uses_typed_parser_configured_port_and_closes(monkeypatch):
    client = SimpleNamespace(sentinel_master=AsyncMock(return_value={'ip': '192.0.2.1'}), aclose=AsyncMock())
    params = {}
    def factory(**kwargs):
        params.update(kwargs)
        return client
    monkeypatch.setattr(cluster.redis_lib, 'Redis', factory)
    result = await cluster._sentinel_view('192.0.2.3', 'ops-center-redis', 26400)
    assert result.reachable and result.master_host == '192.0.2.1'
    assert params['port'] == 26400
    client.aclose.assert_awaited_once()
    client.sentinel_master.side_effect = cluster.redis_lib.ConnectionError('offline')
    result = await cluster._sentinel_view('192.0.2.3', 'ops-center-redis')
    assert not result.reachable
    assert client.aclose.await_count == 2


@pytest.fixture
def switch(monkeypatch):
    settings = SimpleNamespace(patroni_nodes='192.0.2.1,192.0.2.2', patroni_rest_port=8008,
                               patroni_restapi_username='patroni_admin', patroni_restapi_password='synthetic-test-only')
    monkeypatch.setattr(cluster, 'get_settings', lambda: settings)
    nodes = [PatroniNodeStatus(name='node-1', host='192.0.2.1', reachable=True, role='primary'),
             PatroniNodeStatus(name='node-2', host='192.0.2.2', reachable=True, role='replica')]
    monkeypatch.setattr(cluster, '_all_patroni_statuses', AsyncMock(return_value=nodes))
    client = AsyncMock()
    client.__aenter__.return_value = client
    client.post.return_value = httpx.Response(200, text='private upstream output')
    monkeypatch.setattr(cluster.httpx, 'AsyncClient', lambda **kwargs: client)
    return settings, nodes, client


@pytest.mark.asyncio
async def test_unconfigured_and_invalid_candidate_never_call_patroni(switch):
    settings, nodes, client = switch
    for candidate in ['foreign-node', 'node-1']:
        with pytest.raises(HTTPException) as caught:
            await cluster.trigger_switchover(SwitchoverRequest(candidate=candidate))
        assert caught.value.status_code == 400
    settings.patroni_restapi_password = ''
    with pytest.raises(HTTPException) as caught:
        await cluster.trigger_switchover(SwitchoverRequest())
    assert caught.value.status_code == 503
    client.post.assert_not_awaited()


@pytest.mark.asyncio
async def test_switchover_only_once_without_upstream_leak(switch):
    settings, nodes, client = switch
    response = await cluster.trigger_switchover(SwitchoverRequest(candidate='node-2'))
    assert response.ok and 'private' not in response.message
    client.post.assert_awaited_once()
    assert client.post.call_args.kwargs['json'] == {'leader': 'node-1', 'candidate': 'node-2'}
    client.post.side_effect = httpx.ReadTimeout('sensitive upstream error')
    with pytest.raises(HTTPException) as caught:
        await cluster.trigger_switchover(SwitchoverRequest())
    assert caught.value.status_code == 502
    assert 'sensitive' not in caught.value.detail
    assert client.post.await_count == 2


@pytest.mark.asyncio
@pytest.mark.parametrize('role', ['viewer', 'operator'])
async def test_non_admin_switchover_is_denied_before_upstream(switch, role):
    from fastapi import FastAPI
    from app.api.deps import get_current_user
    settings, nodes, upstream = switch
    app = FastAPI()
    app.include_router(cluster.router)
    async def current_user():
        return SimpleNamespace(role=role)
    app.dependency_overrides[get_current_user] = current_user
    # switch replaces AsyncClient for the upstream call, so use an unpatched class.
    from httpx._client import AsyncClient
    async with AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        response = await client.post('/cluster/postgres/switchover', json={})
    assert response.status_code == 403
    upstream.post.assert_not_awaited()
