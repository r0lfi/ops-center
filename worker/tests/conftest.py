import os

# worker.celery_app / worker.db construct settings and a (lazy) SQLAlchemy
# engine at import time - see backend/tests/conftest.py for why these need
# to be present, not real, before collection.
os.environ.setdefault("API_SECRET_KEY", "test-secret-key-not-for-production")
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@localhost/test")
os.environ.setdefault("DATABASE_URL_SYNC", "postgresql+psycopg://test:test@localhost/test")
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")
