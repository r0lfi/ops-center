"""Bounded retention; no cleanup job can execute a pending operation."""

import asyncio
import logging
from datetime import timedelta
from sqlalchemy import delete, update, select, text
from app.db.session import async_session_factory
from app.models.mcp import MCPAuthorization, MCPToken, MCPRequest, MCPAudit
from app.mcp.common import now

log = logging.getLogger(__name__)


async def prune():
    async with async_session_factory() as db:
        # One replica cleans at a time, with a transaction-scoped advisory lock.
        if not await db.scalar(text("SELECT pg_try_advisory_xact_lock(7342042)")):
            return
        stamp = now()
        await db.execute(
            delete(MCPAuthorization).where(
                MCPAuthorization.expires_at < stamp - timedelta(days=1)
            )
        )
        await db.execute(
            delete(MCPToken).where(MCPToken.expires_at < stamp - timedelta(days=1))
        )
        await db.execute(
            update(MCPRequest)
            .where(MCPRequest.status == "pending", MCPRequest.expires_at < stamp)
            .values(status="expired", encrypted_arguments=None)
        )
        # A process may stop after admission. Preserve the uncertain state,
        # never retry it and never describe it as a confirmed failure.
        await db.execute(
            update(MCPRequest)
            .where(
                MCPRequest.status == "executing",
                MCPRequest.expires_at < stamp - timedelta(hours=1),
            )
            .values(
                status="unknown",
                encrypted_arguments=None,
                result={
                    "message": "Execution outcome is unknown. Inspect before retrying."
                },
            )
        )
        await db.execute(
            update(MCPRequest)
            .where(MCPRequest.created_at < stamp - timedelta(days=7))
            .values(result=None, encrypted_arguments=None)
        )
        await db.execute(
            delete(MCPRequest).where(MCPRequest.created_at < stamp - timedelta(days=90))
        )
        await db.execute(
            delete(MCPAudit).where(MCPAudit.created_at < stamp - timedelta(days=90))
        )
        await db.commit()


async def run():
    while True:
        try:
            await prune()
        except Exception:
            log.error("MCP retention maintenance failed")
        await asyncio.sleep(3600)
