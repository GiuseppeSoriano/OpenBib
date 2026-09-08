"""Validated authentication and account-lifecycle contracts."""

from typing import Annotated, Literal

from pydantic import BaseModel, EmailStr, Field, StringConstraints, field_validator


def _normalize_email(value: str) -> str:
    if not isinstance(value, str):
        raise ValueError("Email must be a string")
    return value.strip().lower()


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=15, max_length=128)
    display_name: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)
    ]
    locale: Literal["en", "it"] = "en"
    accept_terms: Literal[True]
    terms_version: str = Field(min_length=1, max_length=50)
    privacy_version: str = Field(min_length=1, max_length=50)
    _email = field_validator("email", mode="before")(_normalize_email)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=128)
    _email = field_validator("email", mode="before")(_normalize_email)


class EmailRequest(BaseModel):
    email: EmailStr
    locale: Literal["en", "it"] = "en"
    _email = field_validator("email", mode="before")(_normalize_email)


class TokenRequest(BaseModel):
    token: str = Field(min_length=32, max_length=256)


class PasswordResetRequest(TokenRequest):
    new_password: str = Field(min_length=15, max_length=128)


class VerifyEmailRequest(PasswordResetRequest):
    """Mailbox possession authorizes the final password, preventing account pre-claiming."""


class EmailChangeRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=128)
    locale: Literal["en", "it"] = "en"
    _email = field_validator("email", mode="before")(_normalize_email)


class PasswordChangeRequest(BaseModel):
    current_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=15, max_length=128)


class LegalAcceptanceRequest(BaseModel):
    accept_terms: Literal[True]
    terms_version: str = Field(min_length=1, max_length=50)
    privacy_version: str = Field(min_length=1, max_length=50)


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int
    legal_acceptance_required: bool = False


class MessageResponse(BaseModel):
    message: str = "If the request is valid, further instructions will be sent."
