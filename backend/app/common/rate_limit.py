"""Redis-backed token-bucket limits with privacy-preserving identities."""

from __future__ import annotations

import hashlib
import hmac
import logging
import math
import time

from fastapi import HTTPException, Request, Response, status

from app.config import settings

logger = logging.getLogger("openbib.rate_limit")

_TOKEN_BUCKET = """
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_per_ms = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])
local values = redis.call('HMGET', key, 'tokens', 'timestamp')
local tokens = tonumber(values[1]) or capacity
local timestamp = tonumber(values[2]) or now
tokens = math.min(capacity, tokens + math.max(0, now - timestamp) * refill_per_ms)
local allowed = 0
local retry_ms = 0
if tokens >= 1 then
  allowed = 1
  tokens = tokens - 1
else
  retry_ms = math.ceil((1 - tokens) / refill_per_ms)
end
redis.call('HMSET', key, 'tokens', tokens, 'timestamp', now)
redis.call('PEXPIRE', key, ttl)
return {allowed, math.floor(tokens), retry_ms}
"""


def pseudonymize(value: str) -> str:
    return hmac.new(
        settings.rate_limit_hmac_key.encode(), value.encode(), hashlib.sha256
    ).hexdigest()


def client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


async def enforce_rate_limit(
    redis,
    request: Request,
    response: Response | None,
    *,
    scope: str,
    identity: str,
    limit: int,
    window_seconds: int,
    fail_closed: bool,
) -> None:
    key = f"rate:{scope}:{pseudonymize(identity)}"
    now_ms = int(time.time() * 1000)
    try:
        allowed, remaining, retry_ms = await redis.eval(
            _TOKEN_BUCKET,
            1,
            key,
            limit,
            limit / (window_seconds * 1000),
            now_ms,
            window_seconds * 2000,
        )
    except Exception:
        logger.warning("Rate limiter unavailable", extra={"scope": scope})
        if fail_closed:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Protection service temporarily unavailable",
                headers={"Retry-After": "30"},
            ) from None
        return
    retry_after = max(1, math.ceil(int(retry_ms) / 1000))
    headers = {
        "X-RateLimit-Limit": str(limit),
        "X-RateLimit-Remaining": str(max(0, int(remaining))),
    }
    if response is not None:
        for name, value in headers.items():
            response.headers[name] = value
    if not int(allowed):
        headers["Retry-After"] = str(retry_after)
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Rate limit exceeded",
            headers=headers,
        )
