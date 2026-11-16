"""Existing collector batches resources and preserves recreation identity."""
from types import SimpleNamespace
from uuid import uuid4
from unittest.mock import MagicMock


def load_tasks(monkeypatch):
    for key,value in {'API_SECRET_KEY':'test-only','DATABASE_URL':'postgresql+asyncpg://test:test@localhost/test',
                      'DATABASE_URL_SYNC':'postgresql+psycopg://test:test@localhost/test','REDIS_URL':'redis://localhost:6379/0'}.items():
        monkeypatch.setenv(key,value)
    from security import tasks
    return tasks


class Rows:
    def __init__(self,rows):self.rows=rows
    def scalar_one_or_none(self):return self.rows[0] if self.rows else None
    def scalars(self):return self
    def all(self):return self.rows


def test_collector_calls_one_stats_batch_and_rekeys_recreated_container(monkeypatch):
    tasks=load_tasks(monkeypatch)
    from app.models.container import Container
    from app.models.host import Host
    original=uuid4();row=Container(id=original,hostname=tasks.LOCAL_HOSTNAME,name='app',runtime_id='a'*64)
    host=Host(id=uuid4(),hostname=tasks.LOCAL_HOSTNAME)
    db=MagicMock();db.execute.side_effect=[Rows([row]),Rows([]),Rows([host])]
    client=MagicMock();container=SimpleNamespace(name='app',status='running',image=SimpleNamespace(tags=['app:1']),reload=lambda:None,
      attrs={'Id':'b'*64,'Config':{},'State':{'Status':'running'}})
    client.containers.list.return_value=[container]
    batch=MagicMock(return_value=[{'ID':'b'*12,'CPUPerc':'210%','MemUsage':'1MiB / 2GiB'}])
    monkeypatch.setattr(tasks,'_docker',lambda:client);monkeypatch.setattr(tasks,'SessionLocal',lambda:db)
    monkeypatch.setattr(tasks.docker_control,'inventory_stats',batch)
    tasks.sync_container_status.run()
    assert row.id!=original and row.runtime_id=='b'*64
    assert row.health is None and row.monitoring_metadata['runtime_stats']['cpu_percent']==210
    assert host.container_inventory_at
    batch.assert_called_once();db.commit.assert_called_once();db.close.assert_called_once()


def test_empty_successful_local_inventory_removes_stale_rows(monkeypatch):
    tasks=load_tasks(monkeypatch)
    row=SimpleNamespace(name='old');host=SimpleNamespace(container_inventory_at=None)
    db=MagicMock();db.execute.side_effect=[Rows([row]),Rows([host])]
    client=MagicMock();client.containers.list.return_value=[]
    monkeypatch.setattr(tasks,'_docker',lambda:client);monkeypatch.setattr(tasks,'SessionLocal',lambda:db)
    monkeypatch.setattr(tasks.docker_control,'inventory_stats',lambda:[])
    tasks.sync_container_status.run()
    db.delete.assert_called_once_with(row);assert host.container_inventory_at
