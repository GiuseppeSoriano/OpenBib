"""Thin async client for the Zotero Web API v3.

Only the write operations the one-way sync needs:
- key verification (GET /keys/current)
- collection creation (POST /users/{uid}/collections)
- item creation in batches of <=50 with a Zotero-Write-Token
- adding an existing item to a collection (GET + PATCH with
  If-Unmodified-Since-Version, one retry on 412)
"""

from __future__ import annotations

import uuid

import httpx

BASE_URL = "https://api.zotero.org"
MAX_BATCH = 50


class ZoteroError(Exception):
    """Zotero API returned an unexpected response."""


class ZoteroAuthError(ZoteroError):
    """The API key is invalid or lacks the required access."""


class ZoteroClient:
    def __init__(self, api_key: str, timeout: float = 20.0):
        self._headers = {
            "Zotero-API-Version": "3",
            "Zotero-API-Key": api_key,
        }
        self._timeout = timeout

    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(base_url=BASE_URL, headers=self._headers, timeout=self._timeout)

    async def verify_key(self) -> dict:
        """Return the key metadata ({"userID": ..., "access": {...}})."""
        async with self._client() as client:
            response = await client.get("/keys/current")
        if response.status_code in (401, 403):
            raise ZoteroAuthError("Invalid Zotero API key")
        if response.status_code != 200:
            raise ZoteroError(f"Zotero key verification failed ({response.status_code})")
        return response.json()

    async def create_collection(self, zotero_user_id: str, name: str) -> str:
        """Create a collection and return its Zotero key."""
        async with self._client() as client:
            response = await client.post(
                f"/users/{zotero_user_id}/collections", json=[{"name": name}]
            )
        if response.status_code != 200:
            raise ZoteroError(f"Zotero collection creation failed ({response.status_code})")
        payload = response.json()
        success: dict = payload.get("success", {})
        if "0" not in success:
            raise ZoteroError("Zotero collection creation rejected")
        return success["0"]

    async def create_items(self, zotero_user_id: str, items: list[dict]) -> dict:
        """Create up to MAX_BATCH items. Returns the raw response payload with
        'success' (index → itemKey), 'unchanged', and 'failed' maps."""
        if len(items) > MAX_BATCH:
            raise ValueError(f"Zotero item batches are limited to {MAX_BATCH}")
        async with self._client() as client:
            response = await client.post(
                f"/users/{zotero_user_id}/items",
                json=items,
                headers={"Zotero-Write-Token": uuid.uuid4().hex},
            )
        if response.status_code != 200:
            raise ZoteroError(f"Zotero item creation failed ({response.status_code})")
        return response.json()

    async def get_item(self, zotero_user_id: str, item_key: str) -> dict:
        async with self._client() as client:
            response = await client.get(f"/users/{zotero_user_id}/items/{item_key}")
        if response.status_code != 200:
            raise ZoteroError(f"Zotero item fetch failed ({response.status_code})")
        return response.json()

    async def add_item_to_collection(
        self, zotero_user_id: str, item_key: str, collection_key: str
    ) -> str:
        """Ensure an existing item is a member of the collection.

        Returns "updated" when membership was added, "unchanged" when the
        item was already in the collection. Retries once on a 412 version
        conflict."""
        for attempt in range(2):
            item = await self.get_item(zotero_user_id, item_key)
            data = item.get("data", {})
            collections = list(data.get("collections", []))
            if collection_key in collections:
                return "unchanged"
            collections.append(collection_key)
            version = item.get("version") or data.get("version") or 0
            async with self._client() as client:
                response = await client.patch(
                    f"/users/{zotero_user_id}/items/{item_key}",
                    json={"collections": collections},
                    headers={"If-Unmodified-Since-Version": str(version)},
                )
            if response.status_code in (200, 204):
                return "updated"
            if response.status_code == 412 and attempt == 0:
                continue  # somebody moved the item — re-read and retry once
            raise ZoteroError(f"Zotero item update failed ({response.status_code})")
        raise ZoteroError("Zotero item update failed (version conflict)")
