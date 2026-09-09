"""Installer-only administrator creation. JSON is read from stdin, never argv."""
import asyncio
import json
import sys

from sqlalchemy import select
from app.db.session import async_session_factory
from app.models.user import User
from app.services.auth import hash_password

async def main():
    payload = json.load(sys.stdin)
    username, password = payload['username'].strip(), payload['password']
    if not username or len(password) < 12:
        raise ValueError('Username and a password of at least 12 characters are required')
    async with async_session_factory() as db:
        existing = (await db.execute(select(User).where(User.username == username))).scalar_one_or_none()
        if existing:
            if existing.role != 'admin':
                raise ValueError('Existing account is not an administrator')
            print('Administrator already exists; credentials preserved')
            return
        db.add(User(username=username, password_hash=hash_password(password), role='admin'))
        await db.commit()
    print('Administrator created')

if __name__ == '__main__':
    asyncio.run(main())
