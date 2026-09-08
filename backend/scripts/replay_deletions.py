"""Replay off-site deletion receipts before reopening a restored database."""

import argparse
import asyncio
import uuid
from datetime import datetime

from app.auth.service import utcnow
from app.common.deletion_journal import read_receipts
from app.database import async_session_factory
from app.users.models import User
from app.users.service import delete_user_account


async def replay(apply: bool) -> int:
    receipts = await asyncio.to_thread(read_receipts)
    count = 0
    async with async_session_factory() as db:
        for receipt in receipts:
            if datetime.fromisoformat(receipt["expires_at"]) <= utcnow():
                continue
            user = await db.get(User, uuid.UUID(receipt["user_id"]))
            if user is not None:
                count += 1
                if apply:
                    await delete_user_account(db, user, record_receipt=False)
        if apply:
            await db.commit()
    return count


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Apply to the isolated restore target; default is a dry run",
    )
    args = parser.parse_args()
    print(f"Deletion receipts matched: {asyncio.run(replay(args.apply))}; applied={args.apply}")
