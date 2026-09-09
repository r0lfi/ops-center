from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import get_settings

settings = get_settings()

# Celery tasks are synchronous, same reasoning as worker/db.py - a plain
# sync engine (DATABASE_URL_SYNC / psycopg) rather than the async engine
# ops-api uses.
engine = create_engine(settings.database_url_sync, pool_pre_ping=True, future=True)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False, class_=Session)
