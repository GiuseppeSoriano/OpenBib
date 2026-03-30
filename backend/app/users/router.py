"""User profile router."""

from fastapi import APIRouter

from app.dependencies import DB, CurrentUser
from app.users.schemas import UserRead, UserUpdate

router = APIRouter(prefix="/users", tags=["users"])


@router.get("/me", response_model=UserRead)
async def get_me(user: CurrentUser):
    return user


@router.patch("/me", response_model=UserRead)
async def update_me(body: UserUpdate, user: CurrentUser, db: DB):
    if body.display_name is not None:
        user.display_name = body.display_name
    if body.email is not None:
        user.email = body.email
    db.add(user)
    await db.flush()
    return user


@router.delete("/me", status_code=204)
async def delete_me(user: CurrentUser, db: DB):
    await db.delete(user)
