import json
from uuid import uuid4
from types import SimpleNamespace

from app.models.host import Host
from app.models.container import Container
from worker.tasks import _store_container_inventory


class Rows:
    def __init__(self,rows):self.rows=rows
    def scalars(self):return self
    def all(self):return self.rows
    def scalar_one_or_none(self):return self.rows[0] if self.rows else None


class DB:
    def __init__(self):
        self.host=Host(id=uuid4(),hostname='alpha',container_inventory_at=None)
        self.rows=[Container(id=uuid4(),hostname='alpha',name='same-name',runtime_id='a'*64)]
        self.deleted=[]
    def execute(self,query):
        if query.column_descriptions[0]['entity'] is Host:return Rows([self.host])
        params=query.compile().params
        rows=[r for r in self.rows if r.hostname==params.get('hostname_1')]
        if 'name_1' in params:
            names=params['name_1']
            rows=[r for r in rows if r.name not in names] if isinstance(names,set) or isinstance(names,list) else [r for r in rows if r.name==names]
        return Rows(rows)
    def add(self,row):self.rows.append(row)
    def delete(self,row):self.deleted.append(row);self.rows.remove(row)
    def commit(self):pass


def test_failed_and_malformed_discovery_preserve_rows_and_collection_time():
    db=DB()
    _store_container_inventory(db,{'alpha':{'ok':False,'containers':[]}})
    assert len(db.rows)==1 and db.host.container_inventory_at is None
    _store_container_inventory(db,{'alpha':{'ok':True,'containers':['not json']}})
    assert len(db.rows)==1 and db.host.container_inventory_at is None


def test_successful_empty_inventory_clears_only_that_host():
    db=DB();db.rows.append(Container(id=uuid4(),hostname='beta',name='same-name',runtime_id='b'*64))
    _store_container_inventory(db,{'alpha':{'ok':True,'containers':[]}})
    assert len(db.rows)==1 and db.rows[0].hostname=='beta'
    assert db.host.container_inventory_at


def test_recreated_runtime_gets_new_identity_and_real_snapshot():
    db=DB();old_id=db.rows[0].id
    inspect={'Name':'/same-name','Id':'c'*64,'Config':{'Image':'app:1'},'State':{'Status':'running'}}
    stats={'ID':'c'*12,'CPUPerc':'234%','MemUsage':'12MiB / 8GiB'}
    _store_container_inventory(db,{'alpha':{'ok':True,'containers':[json.dumps(inspect)],'stats':[json.dumps(stats)]}})
    assert len(db.rows)==1 and db.rows[0].id!=old_id and db.rows[0].runtime_id=='c'*64
    assert db.rows[0].monitoring_metadata['runtime_stats']['cpu_percent']==234
    assert db.rows[0].health is None
