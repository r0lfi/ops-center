#!/usr/bin/env python3
"""Sync Claude Code's memory directory into one user's shared agent notes.

Run inside the ops-api container (it has the app package and DATABASE_URL):

    docker compose cp ~/.claude/projects/<project>/memory ops-api:/tmp/claude-memory
    docker compose cp scripts/admin/import-claude-memory.py ops-api:/tmp/
    docker compose exec ops-api python3 /tmp/import-claude-memory.py --owner admin --dir /tmp/claude-memory --dry-run
    docker compose exec ops-api python3 /tmp/import-claude-memory.py --owner admin --dir /tmp/claude-memory
    docker compose exec ops-api rm -rf /tmp/claude-memory /tmp/import-claude-memory.py

Re-running is safe: only changed notes are written, and claude.* notes whose
source file disappeared are removed. See app/services/claude_memory_import.py.
"""
import argparse
import json
import os
from pathlib import Path

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.models.user import User
from app.services.claude_memory_import import build_notes, read_directory, sync_notes


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--owner", required=True, help="Ops Center username that owns the notes")
    parser.add_argument("--dir", required=True, type=Path, help="Claude Code memory directory")
    parser.add_argument("--dry-run", action="store_true", help="report changes without writing")
    args = parser.parse_args()

    files = read_directory(args.dir)
    if not files:
        raise SystemExit(f"no .md files in {args.dir}")
    notes, dropped = build_notes(files)

    url = os.environ["DATABASE_URL"].replace("+asyncpg", "+psycopg")
    with Session(create_engine(url)) as db:
        owner = db.scalar(select(User).where(User.username == args.owner, User.is_active.is_(True)))
        if owner is None:
            raise SystemExit(f"no active user {args.owner!r}")
        summary = sync_notes(db, owner.id, notes, dry_run=args.dry_run)
        if not args.dry_run:
            db.commit()
    print(json.dumps({"files": len(files), "dropped_secret_lines": dropped, "dry_run": args.dry_run, **summary}))


if __name__ == "__main__":
    main()
