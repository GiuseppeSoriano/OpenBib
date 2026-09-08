"""User Pydantic schemas."""

import uuid
from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, Field, StringConstraints


class UserRead(BaseModel):
    id: uuid.UUID
    email: str
    display_name: str
    created_at: datetime
    email_verified: bool = False
    legal_acceptance_required: bool = False

    model_config = {"from_attributes": True}


class UserUpdate(BaseModel):
    display_name: (
        Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
        | None
    ) = None


class ReauthenticatedRequest(BaseModel):
    password: str = Field(min_length=1, max_length=128)


class DeleteAccountRequest(ReauthenticatedRequest):
    confirmation: str = Field(max_length=20)
