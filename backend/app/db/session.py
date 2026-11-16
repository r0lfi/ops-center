from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import get_settings

settings = get_settings()

# Background loops (traffic collectors, IM, Talk, budget) share this pool with API
# requests. Up to 20 per API node (2 nodes) stays well under max_connections=100;
# a 10 s wait fails a request visibly instead of hanging it for the default 30 s.
engine = create_async_engine(
    settings.database_url,
    pool_pre_ping=True,
    future=True,
    pool_size=10,
    max_overflow=10,
    pool_timeout=10,
)
async_session_factory = async_sessionmaker(engine, expire_on_commit=False)


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with async_session_factory() as session:
        yield session
