"""Minimal structured logging that never serializes request payloads or query strings."""

import json
import logging
from datetime import UTC, datetime
from logging.handlers import TimedRotatingFileHandler
from pathlib import Path


class JsonFormatter(logging.Formatter):
    _fields = (
        "request_id",
        "method",
        "path",
        "status",
        "duration_ms",
        "actor",
        "scope",
        "outbox_id",
        "attempt",
    )

    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "timestamp": datetime.now(UTC).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": str(record.msg)
            if record.name.startswith(("openbib", "app."))
            else "External library event",
        }
        for field in self._fields:
            value = getattr(record, field, None)
            if value is not None:
                payload[field] = value
        if record.exc_info:
            payload["exception"] = record.exc_info[0].__name__
        return json.dumps(payload, ensure_ascii=False)


def configure_logging(production: bool) -> None:
    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(logging.INFO)
    for name in ("uvicorn", "uvicorn.error", "sqlalchemy.engine", "httpx", "httpcore"):
        external = logging.getLogger(name)
        external.handlers.clear()
        external.propagate = True
    if production:
        from app.config import settings

        directory = Path(settings.log_directory)
        directory.mkdir(parents=True, exist_ok=True)
        for name, days in (("openbib.access", 14), ("openbib.security", 90)):
            target = logging.getLogger(name)
            target.propagate = False
            target.handlers.clear()
            file_handler = TimedRotatingFileHandler(
                directory / f"{name}.jsonl", when="midnight", backupCount=days - 1, utc=True
            )
            file_handler.setFormatter(JsonFormatter())
            target.addHandler(file_handler)
