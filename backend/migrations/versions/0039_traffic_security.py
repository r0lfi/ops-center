"""Traffic security signals, durable alerts and review state."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB
revision="0039"
down_revision="0038"
branch_labels=None
depends_on=None

def upgrade():
    op.add_column("traffic_events",sa.Column("signal",sa.String(24),nullable=True))
    op.create_index("ix_traffic_events_signal_ts","traffic_events",["signal","ts"])
    op.create_index("ix_traffic_events_origin","traffic_events",["domain","ip","id"])
    op.create_table("traffic_security_alerts",
        sa.Column("id",sa.BigInteger(),primary_key=True,autoincrement=True),
        sa.Column("rule",sa.String(40),nullable=False),
        sa.Column("severity",sa.String(16),nullable=False),
        sa.Column("domain",sa.String(253),nullable=False),
        sa.Column("ip",sa.String(45),nullable=False),
        sa.Column("count",sa.Integer(),nullable=False),
        sa.Column("created_at",sa.Float(),nullable=False),
        sa.Column("last_seen",sa.Float(),nullable=False),
        sa.Column("evidence",JSONB(),nullable=False),
        sa.Column("reviewed_at",sa.Float()),
        sa.Column("reviewed_by",sa.String(100)),
        sa.Column("notified_at",sa.Float()))
    op.create_index("ix_traffic_security_alerts_created","traffic_security_alerts",["created_at"])
    op.create_index("ix_traffic_security_alerts_group","traffic_security_alerts",["rule","domain","ip","created_at"])

def downgrade():
    op.drop_table("traffic_security_alerts")
    op.drop_index("ix_traffic_events_signal_ts",table_name="traffic_events")
    op.drop_index("ix_traffic_events_origin",table_name="traffic_events")
    op.drop_column("traffic_events","signal")
