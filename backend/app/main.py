"""FastAPI application factory."""

from __future__ import annotations

import logging
import uuid
from contextlib import asynccontextmanager

import redis.asyncio as aioredis
from fastapi import FastAPI, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.common.exceptions import ConflictError, ForbiddenError, NotFoundError
from app.config import settings

logger = logging.getLogger("openbib")

# ---------------------------------------------------------------------------
# Lifespan — startup / shutdown
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    pool = aioredis.from_url(settings.redis_url, decode_responses=True)
    app.state.redis = pool
    logger.info("Redis connected: %s", settings.redis_url)
    yield
    # Shutdown
    await pool.aclose()
    logger.info("Redis pool closed")


def create_app() -> FastAPI:
    app = FastAPI(
        title="OpenBib — Academic Reference Manager",
        version="0.1.0",
        docs_url="/api/docs",
        openapi_url="/api/openapi.json",
        lifespan=lifespan,
    )

    # ------------------------------------------------------------------
    # CORS
    # ------------------------------------------------------------------
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # ------------------------------------------------------------------
    # Request-ID middleware
    # ------------------------------------------------------------------
    @app.middleware("http")
    async def request_id_middleware(request: Request, call_next):
        request_id = request.headers.get("X-Request-ID", str(uuid.uuid4()))
        request.state.request_id = request_id
        response = await call_next(request)
        response.headers["X-Request-ID"] = request_id
        return response

    # ------------------------------------------------------------------
    # Exception handlers
    # ------------------------------------------------------------------
    @app.exception_handler(NotFoundError)
    async def not_found_handler(request: Request, exc: NotFoundError):
        return JSONResponse(
            status_code=status.HTTP_404_NOT_FOUND,
            content={"detail": str(exc)},
        )

    @app.exception_handler(ForbiddenError)
    async def forbidden_handler(request: Request, exc: ForbiddenError):
        return JSONResponse(
            status_code=status.HTTP_403_FORBIDDEN,
            content={"detail": str(exc)},
        )

    @app.exception_handler(ConflictError)
    async def conflict_handler(request: Request, exc: ConflictError):
        return JSONResponse(
            status_code=status.HTTP_409_CONFLICT,
            content={"detail": str(exc)},
        )

    # ------------------------------------------------------------------
    # Routers
    # ------------------------------------------------------------------
    from app.auth.router import router as auth_router
    from app.collections.router import router as collections_router
    from app.graph.router import router as graph_router
    from app.library.router import router as library_router
    from app.notes.router import router as notes_router
    from app.papers.router import router as papers_router
    from app.recommendations.router import router as recommendations_router
    from app.users.router import router as users_router
    from app.zotero.router import router as zotero_router

    app.include_router(auth_router, prefix="/api/v1")
    app.include_router(users_router, prefix="/api/v1")
    app.include_router(collections_router, prefix="/api/v1")
    app.include_router(papers_router, prefix="/api/v1")
    app.include_router(notes_router, prefix="/api/v1")
    app.include_router(graph_router, prefix="/api/v1")
    app.include_router(recommendations_router, prefix="/api/v1")
    app.include_router(library_router, prefix="/api/v1")
    app.include_router(zotero_router, prefix="/api/v1")

    # ------------------------------------------------------------------
    # Health check
    # ------------------------------------------------------------------
    @app.get("/api/health", tags=["health"])
    async def health():
        return {"status": "ok"}

    return app


app = create_app()
