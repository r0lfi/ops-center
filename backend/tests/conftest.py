import os

# Settings() (app.core.config) requires these with no defaults, since a
# missing DB/secret URL in a real deployment should fail loudly rather than
# silently fall back to something. Tests that only exercise pure logic
# (auth helpers, priority scoring, patch parsing) still import modules that
# reference get_settings() lazily, so these need to be present before
# collection - not real credentials, just well-formed enough to construct
# Settings() without hitting a network.
os.environ.setdefault("API_SECRET_KEY", "test-secret-key-not-for-production")
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@localhost/test")
os.environ.setdefault("DATABASE_URL_SYNC", "postgresql+psycopg://test:test@localhost/test")
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")
