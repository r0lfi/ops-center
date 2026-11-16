"""Persistent incident management and single-attempt Talk delivery."""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "0043"
down_revision = "0042"
branch_labels = None
depends_on = None


def dt(name, nullable=False):
    return sa.Column(name, sa.DateTime(timezone=True), nullable=nullable)


def st(name, length, nullable=False):
    return sa.Column(name, sa.String(length), nullable=nullable)


def upgrade():
    op.create_table(
        "im_settings",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("value", JSONB(), nullable=False),
        sa.Column(
            "started_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.execute("INSERT INTO im_settings (id, revision, value) VALUES (1, 0, '{}')")
    op.create_table(
        "im_incidents",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        st("fingerprint", 64),
        st("category", 32),
        st("rule", 100),
        st("resource", 500),
        st("title", 250),
        st("severity", 16),
        st("status", 20),
        st("source_state", 16),
        sa.Column("details", JSONB(), nullable=False),
        sa.Column("observations", sa.Integer(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        dt("created_at"),
        dt("last_seen"),
        dt("completed_at", True),
        st("updated_by", 100, True),
        st("talk_policy", 24),
    )
    op.create_index("ix_im_incidents_fingerprint", "im_incidents", ["fingerprint"])
    op.create_index("ix_im_incidents_status", "im_incidents", ["status"])
    op.create_table(
        "im_conditions",
        st("fingerprint", 64),
        st("source", 80),
        sa.Column(
            "incident_id",
            sa.BigInteger(),
            sa.ForeignKey("im_incidents.id"),
            nullable=False,
        ),
        dt("healthy_since", True),
        dt("last_checked"),
        sa.PrimaryKeyConstraint("fingerprint"),
    )
    op.create_index("ix_im_conditions_source", "im_conditions", ["source"])
    op.create_table(
        "im_events",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column(
            "incident_id",
            sa.BigInteger(),
            sa.ForeignKey("im_incidents.id"),
            nullable=False,
        ),
        st("actor", 100),
        st("status", 20),
        sa.Column("note", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index("ix_im_events_incident_id", "im_events", ["incident_id"])
    op.create_table(
        "im_deliveries",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column(
            "incident_id",
            sa.BigInteger(),
            sa.ForeignKey("im_incidents.id"),
            nullable=False,
        ),
        st("room_digest", 64),
        st("status", 20),
        dt("claimed_at", True),
        dt("sent_at", True),
        sa.UniqueConstraint("incident_id", "room_digest"),
    )
    op.create_index("ix_im_deliveries_incident_id", "im_deliveries", ["incident_id"])


def downgrade():
    for table in (
        "im_deliveries",
        "im_events",
        "im_conditions",
        "im_incidents",
        "im_settings",
    ):
        op.drop_table(table)
