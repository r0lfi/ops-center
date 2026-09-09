import asyncio
import json
import uuid

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import require_role
from app.db.session import get_db
from app.models.job import AnsibleJob
from app.schemas.job import AnsibleJobRead
from app.services.redis_client import get_redis_client

router = APIRouter()

STREAM_IDLE_TIMEOUT_SECONDS = 300


async def _get_job_or_404(db: AsyncSession, job_id: uuid.UUID) -> AnsibleJob:
    result = await db.execute(
        select(AnsibleJob).where(AnsibleJob.id == job_id).options(selectinload(AnsibleJob.events))
    )
    job = result.scalar_one_or_none()
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    return job


@router.get("/jobs", response_model=list[AnsibleJobRead])
async def list_jobs(status: str | None = None, db: AsyncSession = Depends(get_db)) -> list[AnsibleJob]:
    query = select(AnsibleJob).options(selectinload(AnsibleJob.events)).order_by(AnsibleJob.created_at.desc())
    if status is not None:
        query = query.where(AnsibleJob.status == status)
    result = await db.execute(query.limit(200))
    return list(result.scalars().unique().all())


@router.get("/jobs/{job_id}", response_model=AnsibleJobRead)
async def get_job(job_id: uuid.UUID, db: AsyncSession = Depends(get_db)) -> AnsibleJob:
    return await _get_job_or_404(db, job_id)


@router.post("/jobs/{job_id}/cancel", response_model=AnsibleJobRead, dependencies=[Depends(require_role("operator"))])
async def cancel_job(job_id: uuid.UUID, db: AsyncSession = Depends(get_db)) -> AnsibleJob:
    job = await _get_job_or_404(db, job_id)
    if job.status not in ("queued", "running"):
        raise HTTPException(status_code=409, detail=f"job is already {job.status}, cannot cancel")

    redis_client = get_redis_client()
    # Polled by worker.tasks.run_playbook's cancel_callback; the worker
    # clears this key itself once the run actually stops.
    await redis_client.set(f"ansible_job:{job_id}:cancel", "1", ex=3600)
    await redis_client.aclose()

    return job


@router.get("/jobs/{job_id}/stream")
async def stream_job(job_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    job = await _get_job_or_404(db, job_id)

    async def event_source():
        # Replay what's already happened before the client subscribed.
        for event in job.events:
            yield f"data: {json.dumps({'sequence': event.sequence, 'event_type': event.event_type, 'host': event.host, 'task': event.task, 'message': event.message}, default=str)}\n\n"

        if job.status in ("successful", "failed", "cancelled"):
            yield f"data: {json.dumps({'event_type': 'job_complete', 'status': job.status})}\n\n"
            return

        redis_client = get_redis_client()
        pubsub = redis_client.pubsub()
        await pubsub.subscribe(f"ansible_job:{job_id}")
        try:
            while True:
                message = await asyncio.wait_for(
                    pubsub.get_message(ignore_subscribe_messages=True, timeout=30),
                    timeout=STREAM_IDLE_TIMEOUT_SECONDS,
                )
                if message is None:
                    yield ": keepalive\n\n"
                    continue
                data = message["data"]
                yield f"data: {data.decode() if isinstance(data, bytes) else data}\n\n"
                if '"event_type": "job_complete"' in (data.decode() if isinstance(data, bytes) else data):
                    break
        except asyncio.TimeoutError:
            yield f"data: {json.dumps({'event_type': 'stream_timeout'})}\n\n"
        finally:
            await pubsub.unsubscribe(f"ansible_job:{job_id}")
            await redis_client.aclose()

    return StreamingResponse(
        event_source(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
