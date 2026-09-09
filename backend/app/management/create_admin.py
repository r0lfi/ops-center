"""
Creates an admin user. Deliberately CLI-only - there is no HTTP endpoint
that can create the first (or any) admin account, so there is no network-
reachable way to mint credentials. Run it via:

    docker compose exec ops-api python -m app.management.create_admin

Prompts interactively so a plaintext password never needs to appear in
shell history or a compose command line.
"""

import asyncio
import getpass
import sys

from sqlalchemy import select

from app.db.session import async_session_factory
from app.models.user import User
from app.services.auth import hash_password


async def main() -> None:
    username = input("Username: ").strip()
    if not username:
        print("Username cannot be empty.", file=sys.stderr)
        sys.exit(1)

    password = getpass.getpass("Password (min 12 characters): ")
    confirm = getpass.getpass("Confirm password: ")
    if password != confirm:
        print("Passwords did not match.", file=sys.stderr)
        sys.exit(1)
    if len(password) < 12:
        print("Password must be at least 12 characters.", file=sys.stderr)
        sys.exit(1)

    async with async_session_factory() as db:
        existing = await db.execute(select(User).where(User.username == username))
        if existing.scalar_one_or_none() is not None:
            print(f"A user named '{username}' already exists.", file=sys.stderr)
            sys.exit(1)

        user = User(username=username, password_hash=hash_password(password), role="admin")
        db.add(user)
        await db.commit()

    print(f"Created admin user '{username}'.")


if __name__ == "__main__":
    asyncio.run(main())
