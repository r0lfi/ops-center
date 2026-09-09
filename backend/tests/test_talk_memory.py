import hashlib
import hmac
import json
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
import asyncio
from starlette.requests import Request
from app.core.config import TalkMemoryBinding
from app.core.talk_memory import bound_user_id, task_binding_valid
from app.api.routes.integrations import talk_webhook
from fastapi import HTTPException

OWNER = uuid.uuid4()
BINDING = TalkMemoryBinding(actor_id='users/example-user',room_token='private',user_id=OWNER)


def test_binding_requires_exact_signed_identity_and_room():
    with patch('app.core.talk_memory.get_settings',return_value=SimpleNamespace(talk_memory_bindings=[BINDING])):
        assert bound_user_id('users/example-user','private') == OWNER
        assert bound_user_id('guests/example-user','private') is None
        assert bound_user_id('users/other','private') is None
        assert bound_user_id('users/example-user','other') is None
        task=SimpleNamespace(owner_user_id=OWNER,requested_by='talk:users/example-user',conversation_key='talk:private')
        assert task_binding_valid(task)
        task.owner_user_id=uuid.uuid4(); assert not task_binding_valid(task)
    with patch('app.core.talk_memory.get_settings',return_value=SimpleNamespace(talk_memory_bindings=[])):
        assert bound_user_id('users/example-user','private') is None


def test_signed_webhook_binds_owner_but_never_display_name():
    async def run(actor,room,valid=True):
        payload={'type':'Create','actor':{'id':actor,'name':'Example User'},'target':{'id':room},
                 'object':{'id':'1','name':'message','content':json.dumps({'message':'hello'})}}
        body=json.dumps(payload).encode();random='test-random'
        sig=hmac.new(b'test-only',random.encode()+body,hashlib.sha256).hexdigest() if valid else 'bad'
        async def receive():return {'type':'http.request','body':body}
        request=Request({'type':'http','headers':[(b'x-nextcloud-talk-random',random.encode()),(b'x-nextcloud-talk-signature',sig.encode()),(b'x-nextcloud-talk-backend',b'https://test')]},receive)
        db=MagicMock();db.execute=AsyncMock(return_value=SimpleNamespace(scalar_one_or_none=lambda:SimpleNamespace(id=uuid.uuid4(),enabled=True)))
        db.get=AsyncMock(return_value=SimpleNamespace(id=OWNER,is_active=True));db.commit=AsyncMock();db.refresh=AsyncMock()
        with patch('app.core.talk_memory.get_settings',return_value=SimpleNamespace(talk_memory_bindings=[BINDING])),patch('app.api.routes.integrations._talk_secret',return_value='test-only'),patch('app.api.routes.integrations.get_celery_client'):
            if not valid:
                try: await talk_webhook(request,db)
                except HTTPException as exc: assert exc.status_code==401
                else: raise AssertionError('Invalid signature accepted')
                db.add.assert_not_called();return
            await talk_webhook(request,db)
            task=db.add.call_args.args[0]
            assert task.owner_user_id==(OWNER if actor=='users/example-user' and room=='private' else None)
            assert task.requested_by=='talk:'+actor
            assert task.source=='talk'
    for actor,room,valid in [('users/example-user','private',True),('users/other','private',True),('users/example-user','other',True),('users/example-user','private',False)]:
        asyncio.run(run(actor,room,valid))
