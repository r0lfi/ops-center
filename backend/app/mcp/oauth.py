"""OAuth provider backed by PostgreSQL; the official SDK validates wire requests."""

from datetime import timedelta
from fastapi import HTTPException
from urllib.parse import urlencode
from sqlalchemy import select
from mcp.server.auth.provider import (
    AuthorizationCode,
    RefreshToken,
    AccessToken,
    AuthorizeError,
    TokenError,
    RegistrationError,
)
from mcp.shared.auth import OAuthClientInformationFull, OAuthToken
from app.db.session import async_session_factory
from app.models.mcp import MCPClient, MCPGrant, MCPAuthorization, MCPToken
from app.mcp.common import (
    active,
    now,
    opaque,
    digest,
    public_url,
    origin,
    grant_context,
    audit,
)


def invalid():
    return TokenError(
        error="invalid_grant",
        error_description="Authorization is expired, revoked or already used",
    )


async def issue(db, grant, scopes):
    access, refresh = opaque(), opaque()
    access_expiry = min(now() + timedelta(minutes=10), grant.expires_at)
    for raw, kind, expiry in (
        (access, "access", access_expiry),
        (refresh, "refresh", grant.expires_at),
    ):
        db.add(
            MCPToken(
                digest=digest(raw),
                grant_id=grant.id,
                kind=kind,
                scopes=scopes,
                expires_at=expiry,
            )
        )
    return OAuthToken(
        access_token=access,
        token_type="Bearer",
        expires_in=max(1, int((access_expiry - now()).total_seconds())),
        refresh_token=refresh,
        scope=" ".join(scopes),
    )


class OpsOAuthProvider:
    async def get_client(self, client_id):
        async with async_session_factory() as db:
            row = await db.get(MCPClient, client_id)
            if not row or not row.enabled or row.id.startswith("internal:"):
                return None
            return OAuthClientInformationFull(
                client_id=row.id,
                client_name=row.name,
                redirect_uris=row.redirect_uris,
                token_endpoint_auth_method="none",
                grant_types=["authorization_code", "refresh_token"],
                response_types=["code"],
                scope=" ".join(row.scopes),
            )

    async def register_client(self, client_info):
        raise RegistrationError(
            error="invalid_client_metadata",
            error_description="An administrator must register MCP clients in Ops Center",
        )

    async def authorize(self, client, params):
        async with async_session_factory() as db:
            await active(db)
            row = await db.get(MCPClient, client.client_id)
            if not row or not row.enabled:
                raise AuthorizeError(
                    error="unauthorized_client", error_description="Client is disabled"
                )
            if params.resource != public_url():
                raise AuthorizeError(
                    error="invalid_target",
                    error_description="Use the advertised MCP resource URL",
                )
            if str(params.redirect_uri) not in row.redirect_uris:
                raise AuthorizeError(
                    error="invalid_request",
                    error_description="Redirect URI must exactly match registration",
                )
            if (
                not params.scopes
                or "ops:connect" not in params.scopes
                or not set(params.scopes) <= set(row.scopes)
            ):
                raise AuthorizeError(
                    error="invalid_scope",
                    error_description="Requested scope is not permitted",
                )
            if params.state and len(params.state) > 2048:
                raise AuthorizeError(
                    error="invalid_request", error_description="State is too large"
                )
            request_id = opaque()
            db.add(
                MCPAuthorization(
                    id=request_id,
                    client_id=row.id,
                    parameters=params.model_dump(mode="json"),
                    expires_at=now() + timedelta(minutes=5),
                )
            )
            await db.commit()
            return origin() + "/mcp/consent?request=" + request_id

    async def load_authorization_code(self, client, authorization_code):
        async with async_session_factory() as db:
            row = (
                await db.execute(
                    select(MCPAuthorization).where(
                        MCPAuthorization.code_hash == digest(authorization_code),
                        MCPAuthorization.client_id == client.client_id,
                    )
                )
            ).scalar_one_or_none()
            if (
                not row
                or row.consumed_at
                or row.expires_at <= now()
                or not row.grant_id
            ):
                return None
            try:
                grant, _, _ = await grant_context(db, row.grant_id)
            except (HTTPException, ValueError):
                return None
            p = row.parameters
            return AuthorizationCode(
                code=authorization_code,
                scopes=grant.scopes,
                expires_at=row.expires_at.timestamp(),
                client_id=row.client_id,
                code_challenge=p["code_challenge"],
                redirect_uri=p["redirect_uri"],
                redirect_uri_provided_explicitly=p["redirect_uri_provided_explicitly"],
                resource=grant.resource,
                subject=str(grant.user_id),
            )

    async def exchange_authorization_code(self, client, authorization_code):
        async with async_session_factory() as db:
            row = (
                await db.execute(
                    select(MCPAuthorization)
                    .where(
                        MCPAuthorization.code_hash == digest(authorization_code.code),
                        MCPAuthorization.client_id == client.client_id,
                    )
                    .with_for_update()
                )
            ).scalar_one_or_none()
            if (
                not row
                or row.consumed_at
                or row.expires_at <= now()
                or not row.grant_id
            ):
                raise invalid()
            try:
                grant, current_client, user = await grant_context(db, row.grant_id)
            except (HTTPException, ValueError):
                raise invalid()
            if not set(grant.scopes) <= set(current_client.scopes):
                raise invalid()
            row.consumed_at = now()
            token = await issue(db, grant, grant.scopes)
            await audit(db, "oauth.code.exchange", "issued", grant=grant, user=user)
            await db.commit()
            return token

    async def load_refresh_token(self, client, refresh_token):
        async with async_session_factory() as db:
            row = await db.get(MCPToken, digest(refresh_token))
            if not row or row.kind != "refresh" or row.expires_at <= now():
                return None
            grant = await db.get(MCPGrant, row.grant_id)
            if not grant or grant.client_id != client.client_id or grant.revoked_at:
                return None
            # Used refresh tokens must reach exchange so replay revokes the family.
            return RefreshToken(
                token=refresh_token,
                client_id=grant.client_id,
                scopes=row.scopes,
                expires_at=int(row.expires_at.timestamp()),
                resource=grant.resource,
                subject=str(grant.user_id),
            )

    async def exchange_refresh_token(self, client, refresh_token, scopes):
        async with async_session_factory() as db:
            row = (
                await db.execute(
                    select(MCPToken)
                    .where(MCPToken.digest == digest(refresh_token.token))
                    .with_for_update()
                )
            ).scalar_one_or_none()
            if not row or row.kind != "refresh" or row.expires_at <= now():
                raise invalid()
            grant = await db.get(MCPGrant, row.grant_id, with_for_update=True)
            if not grant or grant.client_id != client.client_id:
                raise invalid()
            if row.consumed_at:
                grant.revoked_at = now()
                await audit(db, "oauth.refresh", "replay-revoked", grant=grant)
                await db.commit()
                raise invalid()
            try:
                grant, current_client, user = await grant_context(db, grant.id)
            except (HTTPException, ValueError):
                raise invalid()
            if not set(scopes) <= set(row.scopes) & set(grant.scopes) & set(
                current_client.scopes
            ):
                raise invalid()
            row.consumed_at = now()
            token = await issue(db, grant, scopes)
            await audit(db, "oauth.refresh", "rotated", grant=grant, user=user)
            await db.commit()
            return token

    async def load_access_token(self, token):
        from fastapi import HTTPException

        if len(token) > 256:
            return None
        async with async_session_factory() as db:
            row = await db.get(MCPToken, digest(token))
            if (
                not row
                or row.kind != "access"
                or row.consumed_at
                or row.expires_at <= now()
            ):
                return None
            try:
                grant, client, user = await grant_context(db, row.grant_id)
            except (HTTPException, ValueError):
                return None
            scopes = sorted(set(row.scopes) & set(grant.scopes) & set(client.scopes))
            if "ops:connect" not in scopes:
                return None
            return AccessToken(
                token=token,
                client_id=client.id,
                scopes=scopes,
                expires_at=int(row.expires_at.timestamp()),
                resource=grant.resource,
                subject=str(user.id),
                claims={
                    "grant_id": str(grant.id),
                    "user_id": str(user.id),
                    "task_id": str(row.task_id) if row.task_id else None,
                },
            )

    async def revoke_token(self, token):
        async with async_session_factory() as db:
            row = await db.get(MCPToken, digest(token.token))
            if row:
                grant = await db.get(MCPGrant, row.grant_id, with_for_update=True)
                if grant and grant.client_id == token.client_id:
                    grant.revoked_at = now()
                    await audit(db, "oauth.revoke", "revoked", grant=grant)
                    await db.commit()

    async def exchange_identity_assertion(self, client, params):
        raise TokenError(
            error="unsupported_grant_type",
            error_description="Only authorization_code and refresh_token are supported",
        )
