"""Link recorded usage to its original priced reservation."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

revision = "0047"
down_revision = "0046"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("ai_usage", sa.Column("reservation_id", UUID(as_uuid=True), nullable=True))
    op.create_foreign_key("fk_ai_usage_reservation", "ai_usage", "ai_budget_reservations", ["reservation_id"], ["id"], ondelete="RESTRICT")
    op.create_index("ix_ai_usage_reservation_id", "ai_usage", ["reservation_id"], unique=True)


def downgrade():
    if op.get_bind().execute(sa.text("SELECT EXISTS (SELECT 1 FROM ai_usage WHERE reservation_id IS NOT NULL)")).scalar():
        raise RuntimeError("Preserve recorded usage accounting provenance; fix forward while linked usage exists.")
    op.drop_index("ix_ai_usage_reservation_id", table_name="ai_usage")
    op.drop_constraint("fk_ai_usage_reservation", "ai_usage", type_="foreignkey")
    op.drop_column("ai_usage", "reservation_id")
