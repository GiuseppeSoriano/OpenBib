FROM python:3.12-slim AS base

WORKDIR /app
ENV PYTHONPATH=/app

RUN adduser --disabled-password --gecos "" appuser

COPY pyproject.toml .
RUN pip install --no-cache-dir ".[dev]"

COPY . .
RUN chown -R appuser:appuser /app

USER appuser

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
