"""Persistent traffic observations and shared collector checkpoints."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB
revision = "0038"
down_revision = "0037"
branch_labels = None
depends_on = None

def upgrade():
    op.create_table("traffic_events",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("event_key", sa.String(64), nullable=False, unique=True),
        sa.Column("ts", sa.Float(), nullable=False),
        sa.Column("ip", sa.String(45), nullable=False),
        sa.Column("lat", sa.Float()), sa.Column("lon", sa.Float()),
        sa.Column("city", sa.String(160)), sa.Column("country", sa.String(160)),
        sa.Column("domain", sa.String(253), nullable=False),
        sa.Column("status", sa.Integer()), sa.Column("source", sa.String(32), nullable=False),
        sa.Column("kind", sa.String(24), nullable=False),
        sa.Column("suspicious", sa.Boolean(), nullable=False))
    for suffix, columns in [("ts",["ts"]),("domain_ts",["domain","ts"]),("kind_ts",["kind","ts"])]:
        op.create_index("ix_traffic_events_"+suffix,"traffic_events",columns)
    op.create_table("traffic_collectors",
        sa.Column("name",sa.String(32),primary_key=True),
        sa.Column("checkpoint",JSONB(),nullable=False),
        sa.Column("last_success",sa.Float()),sa.Column("last_error",sa.String(120)))

def downgrade():
    op.drop_table("traffic_collectors")
    op.drop_table("traffic_events")
