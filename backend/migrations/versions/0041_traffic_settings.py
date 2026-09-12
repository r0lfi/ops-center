"""Configurable traffic sources; fresh installations monitor no hosts."""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "0041"
down_revision = "0040"
branch_labels = None
depends_on = None


def upgrade():
    op.create_index("ix_traffic_events_source_ts", "traffic_events", ["source", "ts"])
    op.create_table(
        "traffic_settings",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("revision", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("value", JSONB(), nullable=False, server_default="{}"),
    )
    op.execute("INSERT INTO traffic_settings(id,revision,value) VALUES(1,0,'{}')")
    op.add_column(
        "traffic_security_alerts", sa.Column("source", sa.String(32), nullable=True)
    )
    op.create_index(
        "ix_traffic_security_alerts_source", "traffic_security_alerts", ["source"]
    )


def downgrade():
    op.drop_index("ix_traffic_events_source_ts", table_name="traffic_events")
    op.drop_index(
        "ix_traffic_security_alerts_source", table_name="traffic_security_alerts"
    )
    op.drop_column("traffic_security_alerts", "source")
    op.drop_table("traffic_settings")
