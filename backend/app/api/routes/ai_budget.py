"""Shared weekly AI allowance. Authentication is enforced by main; changing the limit needs a confirmed admin."""
from decimal import Decimal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_recent_auth
from app.db.session import get_db
from app.models.ai_budget import AIBudgetSettings
from app.models.user import User
from app.services.ai_budget import MAX_LIMIT_USD, MIN_LIMIT_USD, budget_status

router = APIRouter()
require_budget_auth = require_recent_auth("admin")


class BudgetLimitUpdate(BaseModel):
    limit_usd: Decimal = Field(ge=MIN_LIMIT_USD, le=MAX_LIMIT_USD, decimal_places=2)


@router.get("/ai/budget")
async def get_ai_budget(db: AsyncSession = Depends(get_db)) -> dict:
    return await budget_status(db)


@router.put("/ai/budget")
async def set_ai_budget(payload: BudgetLimitUpdate, db: AsyncSession = Depends(get_db),
                        user: User = Depends(require_budget_auth)) -> dict:
    # Admission reads this row on every paid request, so the change applies to the next call.
    row = await db.get(AIBudgetSettings, 1) or AIBudgetSettings(id=1)
    row.limit_usd, row.updated_by = payload.limit_usd, user.username
    db.add(row)
    await db.commit()
    return await budget_status(db)
