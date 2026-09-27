"""FastAPI application factory with production security boundaries."""

from __future__ import annotations

import asyncio
import logging
import re
import time
import uuid
from contextlib import asynccontextmanager

import redis.asyncio as aioredis
from fastapi import FastAPI, HTTPException, Request, Response, status
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import JSONResponse, RedirectResponse
from sqlalchemy import text

from app.common.body_limit import BodyLimitMiddleware
from app.common.exceptions import ConflictError, ForbiddenError, NotFoundError
from app.common.logging_config import configure_logging
from app.common.rate_limit import client_ip, enforce_rate_limit, pseudonymize
from app.config import settings
from app.database import async_session_factory, engine
from app.legal import get_legal_config

configure_logging(settings.environment == "production")
logger = logging.getLogger("openbib")
_REQUEST_ID = re.compile(r"^[A-Za-z0-9._:-]{1,64}$")
_ACCOUNT_ACTION_PREFIXES = ("/api/v1/auth/", "/api/v1/users/me/")
_COOKIE_MUTATION_PATHS = {
    "/api/v1/auth/verify-email",
    "/api/v1/auth/login",
    "/api/v1/auth/refresh",
    "/api/v1/auth/logout",
    "/api/v1/auth/logout-all",
    "/api/v1/auth/password/reset",
    "/api/v1/auth/email/confirm",
    "/api/v1/users/me/password",
    "/api/v1/users/me/delete",
}


@asynccontextmanager
async def lifespan(app: FastAPI):
    get_legal_config()
    if settings.environment == "production" and not settings.backups_enabled:
        logger.warning("Backups are disabled; database loss may be irreversible")
    pool = app.state.redis
    logger.info("Redis pool initialized")
    yield
    from app.providers.registry import close_providers

    await close_providers()
    await pool.aclose()
    await engine.dispose()
    logger.info("Application resources closed")


def create_app() -> FastAPI:
    app = FastAPI(
        title="OpenBib — Academic Reference Manager",
        version="0.2.0",
        docs_url=None,
        redoc_url=None,
        openapi_url="/api/openapi.json",
        lifespan=lifespan,
    )
    app.add_middleware(BodyLimitMiddleware)
    app.state.redis = aioredis.from_url(
        settings.redis_url, decode_responses=True, socket_connect_timeout=1, socket_timeout=1
    )
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=settings.allowed_hosts)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "X-Request-ID"],
    )

    @app.middleware("http")
    async def security_middleware(request: Request, call_next):
        request_id_header = request.headers.get("X-Request-ID", "")
        request_id = (
            request_id_header if _REQUEST_ID.fullmatch(request_id_header) else str(uuid.uuid4())
        )
        request.state.request_id = request_id
        max_body = 5 * 1024 * 1024 if "/import/" in request.url.path else 1024 * 1024
        content_length = request.headers.get("content-length")
        if content_length:
            try:
                if int(content_length) > max_body:
                    return JSONResponse(
                        status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                        content={"detail": "Request body too large"},
                        headers={"X-Request-ID": request_id},
                    )
            except ValueError:
                return JSONResponse(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    content={"detail": "Invalid Content-Length"},
                    headers={"X-Request-ID": request_id},
                )
        if (
            settings.environment == "production"
            and request.method not in ("GET", "HEAD", "OPTIONS")
            and request.url.path in _COOKIE_MUTATION_PATHS
            and request.headers.get("origin") != settings.app_public_url.rstrip("/")
        ):
            return JSONResponse(
                status_code=status.HTTP_403_FORBIDDEN,
                content={"detail": "Invalid request origin"},
                headers={"X-Request-ID": request_id},
            )

        identity = client_ip(request)
        capacity = 100
        authorization = request.headers.get("authorization", "")
        if authorization.lower().startswith("bearer "):
            from app.auth.service import verify_access_token

            payload = verify_access_token(authorization[7:])
            if payload:
                identity = f"user:{payload['sub']}"
                capacity = 300
        header_sink = Response()
        try:
            await enforce_rate_limit(
                app.state.redis,
                request,
                header_sink,
                scope="global",
                identity=identity,
                limit=capacity,
                window_seconds=60,
                fail_closed=request.url.path.startswith("/api/v1/auth/")
                or (
                    capacity == 100
                    and not request.url.path.startswith(
                        ("/api/health", "/api/docs", "/api/openapi.json")
                    )
                ),
            )
        except HTTPException as exc:
            return JSONResponse(
                status_code=exc.status_code,
                content={"detail": exc.detail},
                headers={**(exc.headers or {}), "X-Request-ID": request_id},
            )

        started = time.monotonic()
        response_status = 500
        try:
            response = await call_next(request)
            response_status = response.status_code
        finally:
            actor_id = getattr(request.state, "actor_id", None)
            logging.getLogger("openbib.access").info(
                "request",
                extra={
                    "request_id": request_id,
                    "method": request.method,
                    "path": getattr(request.scope.get("route"), "path", "<unmatched>"),
                    "status": response_status,
                    "duration_ms": round((time.monotonic() - started) * 1000, 2),
                    "actor": pseudonymize(actor_id) if actor_id else None,
                },
            )
        if request.url.path.startswith(_ACCOUNT_ACTION_PREFIXES) and request.method not in (
            "GET",
            "HEAD",
            "OPTIONS",
        ):
            logging.getLogger("openbib.security").info(
                "account action",
                extra={
                    "request_id": request_id,
                    "path": getattr(request.scope.get("route"), "path", "<unmatched>"),
                    "status": response_status,
                    "actor": pseudonymize(
                        getattr(request.state, "actor_id", None) or client_ip(request)
                    ),
                },
            )
        response.headers["X-Request-ID"] = request_id
        for name, value in header_sink.headers.items():
            if name.lower().startswith("x-ratelimit") and name not in response.headers:
                response.headers[name] = value
        response.headers["Cache-Control"] = (
            "no-store"
            if request.url.path.startswith("/api/v1/auth")
            else response.headers.get("Cache-Control", "no-cache")
        )
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        return response

    @app.exception_handler(RequestValidationError)
    async def validation_error_handler(_request: Request, exc: RequestValidationError):
        return JSONResponse(
            status_code=422,
            content={
                "detail": [
                    {
                        "loc": list(error["loc"]),
                        "type": error["type"],
                        "msg": "Invalid request field",
                    }
                    for error in exc.errors()
                ]
            },
        )

    @app.exception_handler(NotFoundError)
    async def not_found_handler(_request: Request, exc: NotFoundError):
        return JSONResponse(status_code=status.HTTP_404_NOT_FOUND, content={"detail": str(exc)})

    @app.exception_handler(ForbiddenError)
    async def forbidden_handler(_request: Request, exc: ForbiddenError):
        return JSONResponse(status_code=status.HTTP_403_FORBIDDEN, content={"detail": str(exc)})

    @app.exception_handler(ConflictError)
    async def conflict_handler(_request: Request, exc: ConflictError):
        return JSONResponse(status_code=status.HTTP_409_CONFLICT, content={"detail": str(exc)})

    from app.auth.router import router as auth_router
    from app.collections.router import router as collections_router
    from app.graph.router import router as graph_router
    from app.library.router import router as library_router
    from app.notes.router import router as notes_router
    from app.papers.router import router as papers_router
    from app.recommendations.router import router as recommendations_router
    from app.users.router import router as users_router
    from app.zotero.router import router as zotero_router

    for router in (
        auth_router,
        users_router,
        collections_router,
        papers_router,
        notes_router,
        graph_router,
        recommendations_router,
        library_router,
        zotero_router,
    ):
        app.include_router(router, prefix="/api/v1")

    @app.get("/api/docs", include_in_schema=False)
    async def api_docs():
        return RedirectResponse(settings.app_public_url.rstrip("/") + "/api-docs.html")

    @app.get("/api/health/live", tags=["health"])
    async def live():
        return {"status": "ok"}

    async def readiness():
        result = {"status": "ok", "db": "ok", "cache": "ok"}
        try:
            async with asyncio.timeout(1):
                async with async_session_factory() as db:
                    await db.execute(text("SELECT 1"))
        except Exception:
            result["status"] = "degraded"
            result["db"] = "unavailable"
        try:
            async with asyncio.timeout(1):
                await app.state.redis.ping()
        except Exception:
            result["status"] = "degraded"
            result["cache"] = "unavailable"
        return JSONResponse(status_code=200 if result["status"] == "ok" else 503, content=result)

    app.get("/api/health/ready", tags=["health"])(readiness)
    app.get("/api/health", tags=["health"])(readiness)
    return app


app = create_app()
