"""Common exceptions and error handlers."""

from fastapi import HTTPException, status


class NotFoundError(HTTPException):
    def __init__(self, detail: str = "Resource not found"):
        super().__init__(status_code=status.HTTP_404_NOT_FOUND, detail=detail)


class ForbiddenError(HTTPException):
    def __init__(self, detail: str = "Forbidden"):
        super().__init__(status_code=status.HTTP_403_FORBIDDEN, detail=detail)


class ConflictError(HTTPException):
    def __init__(self, detail: str = "Conflict"):
        super().__init__(status_code=status.HTTP_409_CONFLICT, detail=detail)


class ApiError(HTTPException):
    """Error with a machine-readable ``detail`` of ``{code, message, **extra}``.

    Deliberately a plain ``HTTPException`` subclass with no handler of its own:
    FastAPI's default handler serializes the dict ``detail`` unchanged, while
    the custom handlers above stringify it.
    """

    def __init__(
        self,
        status_code: int,
        code: str,
        message: str,
        *,
        headers: dict[str, str] | None = None,
        **extra,
    ):
        super().__init__(
            status_code=status_code,
            detail={"code": code, "message": message, **extra},
            headers=headers,
        )
        self.code = code


class InvalidIdentifierError(ApiError):
    def __init__(self, value: str):
        super().__init__(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "invalid_identifier",
            "Enter a DOI (for example 10.1038/nature14539) or a DOI link",
            value=value[:200],
        )
