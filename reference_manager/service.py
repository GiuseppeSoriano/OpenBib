from __future__ import annotations

import hashlib
import json
import secrets
import sqlite3
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from .config import AppConfig
from .providers import ProviderRegistry


VALID_STATES = {
    "non_visto",
    "visto",
    "salvato",
    "da_leggere",
    "in_lettura",
    "letto",
    "importante",
    "ignorato",
    "escluso",
}

GRAPH_MODES = {"references", "citations"}
GRAPH_RELATION_TYPE = "cites"


def utcnow() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def iso_after_now(value: Optional[str]) -> bool:
    if not value:
        return False
    try:
        return datetime.fromisoformat(value) > datetime.now(timezone.utc)
    except ValueError:
        return False


def iso_plus_seconds(seconds: int) -> str:
    return (datetime.now(timezone.utc) + timedelta(seconds=seconds)).replace(microsecond=0).isoformat()


def json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=True, sort_keys=True)


def json_loads(value: Optional[str], default: Any) -> Any:
    if not value:
        return default
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return default


def normalize_text(value: str) -> str:
    sanitized = "".join(character.lower() if character.isalnum() else " " for character in value)
    return " ".join(sanitized.split())


def normalize_doi(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    return value.strip().lower().replace("https://doi.org/", "").replace("doi:", "")


def canonical_key(metadata: Dict[str, Any]) -> str:
    doi = normalize_doi(metadata.get("doi"))
    if doi:
        return f"doi:{doi}"
    title = normalize_text(metadata.get("title", "manual-record"))
    year = str(metadata.get("year") or "unknown")
    return f"title:{title}:{year}"


def parse_authors(raw: Any) -> List[str]:
    if isinstance(raw, list):
        return [str(item).strip() for item in raw if str(item).strip()]
    if not raw:
        return []
    parts = [part.strip() for part in str(raw).replace(" and ", ";").split(";")]
    return [part for part in parts if part]


def password_hash(password: str, salt: Optional[str] = None) -> str:
    salt = salt or secrets.token_hex(16)
    derived = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), 120000)
    return f"{salt}${derived.hex()}"


def verify_password(password: str, encoded: str) -> bool:
    salt, _separator, _digest = encoded.partition("$")
    if not salt:
        return False
    return password_hash(password, salt) == encoded


class ServiceError(Exception):
    def __init__(self, message: str, *, status: int = 400, details: Optional[Dict[str, Any]] = None) -> None:
        super().__init__(message)
        self.message = message
        self.status = status
        self.details = details or {}


class ReferenceManagerService:
    def __init__(self, db_path: str, *, config: Optional[AppConfig] = None, providers: Optional[ProviderRegistry] = None) -> None:
        self.db_path = db_path
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        self.config = config or AppConfig.from_env()
        self.providers = providers or ProviderRegistry(self.config)
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    email TEXT UNIQUE NOT NULL,
                    password_hash TEXT NOT NULL,
                    display_name TEXT NOT NULL,
                    is_verified INTEGER NOT NULL DEFAULT 1,
                    disabled INTEGER NOT NULL DEFAULT 0,
                    profile_json TEXT NOT NULL DEFAULT '{}',
                    preferences_json TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL,
                    deleted_at TEXT
                );
                CREATE TABLE IF NOT EXISTS identity_links (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    provider TEXT NOT NULL,
                    external_id TEXT NOT NULL,
                    merged_from_user_id INTEGER,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS sessions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    token TEXT UNIQUE NOT NULL,
                    expires_at TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS collections (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    owner_id INTEGER REFERENCES users(id),
                    name TEXT NOT NULL,
                    description TEXT NOT NULL DEFAULT '',
                    visibility TEXT NOT NULL DEFAULT 'private',
                    status TEXT NOT NULL DEFAULT 'active',
                    tags_json TEXT NOT NULL DEFAULT '[]',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS collection_members (
                    collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    role TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    PRIMARY KEY (collection_id, user_id)
                );
                CREATE TABLE IF NOT EXISTS papers (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    canonical_key TEXT NOT NULL UNIQUE,
                    merged_into_paper_id INTEGER REFERENCES papers(id),
                    doi TEXT,
                    title TEXT NOT NULL,
                    subtitle TEXT,
                    abstract TEXT,
                    venue TEXT,
                    year INTEGER,
                    published_at TEXT,
                    publication_type TEXT,
                    language TEXT,
                    canonical_url TEXT,
                    pdf_url TEXT,
                    metadata_json TEXT NOT NULL DEFAULT '{}',
                    quality_state TEXT NOT NULL DEFAULT 'manuale',
                    reliability_state TEXT NOT NULL DEFAULT 'da_verificare',
                    retraction_state TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS authors (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    canonical_name TEXT NOT NULL,
                    aliases_json TEXT NOT NULL DEFAULT '[]',
                    external_ids_json TEXT NOT NULL DEFAULT '{}',
                    affiliations_json TEXT NOT NULL DEFAULT '[]',
                    topics_json TEXT NOT NULL DEFAULT '[]',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS paper_authors (
                    paper_id INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
                    author_id INTEGER NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
                    author_position INTEGER NOT NULL,
                    PRIMARY KEY (paper_id, author_id)
                );
                CREATE TABLE IF NOT EXISTS paper_relationships (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    source_paper_id INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
                    target_paper_id INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
                    relation_type TEXT NOT NULL,
                    confidence REAL NOT NULL DEFAULT 1.0,
                    explanation TEXT NOT NULL DEFAULT '',
                    metadata_json TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL
                );
                CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_paper_relationship
                ON paper_relationships(source_paper_id, target_paper_id, relation_type);
                CREATE INDEX IF NOT EXISTS idx_paper_relationship_target
                ON paper_relationships(target_paper_id, relation_type);
                CREATE TABLE IF NOT EXISTS collection_papers (
                    collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
                    paper_id INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
                    added_by_user_id INTEGER REFERENCES users(id),
                    added_at TEXT NOT NULL,
                    PRIMARY KEY (collection_id, paper_id)
                );
                CREATE TABLE IF NOT EXISTS notes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    target_type TEXT NOT NULL,
                    target_id INTEGER NOT NULL,
                    collection_id INTEGER REFERENCES collections(id),
                    author_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    visibility TEXT NOT NULL DEFAULT 'private',
                    body TEXT NOT NULL,
                    version INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS note_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
                    version INTEGER NOT NULL,
                    body TEXT NOT NULL,
                    edited_at TEXT NOT NULL,
                    edited_by_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS user_paper_state (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    paper_id INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
                    collection_id INTEGER REFERENCES collections(id),
                    status TEXT NOT NULL,
                    tags_json TEXT NOT NULL DEFAULT '[]',
                    is_important INTEGER NOT NULL DEFAULT 0,
                    is_favorite INTEGER NOT NULL DEFAULT 0,
                    is_hidden INTEGER NOT NULL DEFAULT 0,
                    is_excluded INTEGER NOT NULL DEFAULT 0,
                    is_ignored INTEGER NOT NULL DEFAULT 0,
                    last_action_at TEXT NOT NULL,
                    source TEXT NOT NULL DEFAULT 'manual',
                    UNIQUE (user_id, paper_id, collection_id)
                );
                CREATE TABLE IF NOT EXISTS feedback (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    target_type TEXT NOT NULL,
                    target_id INTEGER NOT NULL,
                    feedback_type TEXT NOT NULL,
                    details_json TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS audit_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    actor_user_id INTEGER REFERENCES users(id),
                    event_type TEXT NOT NULL,
                    target_type TEXT NOT NULL,
                    target_id INTEGER,
                    is_automatic INTEGER NOT NULL DEFAULT 0,
                    summary TEXT NOT NULL,
                    details_json TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS merge_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    winner_paper_id INTEGER NOT NULL REFERENCES papers(id),
                    loser_paper_id INTEGER NOT NULL,
                    reason TEXT NOT NULL DEFAULT '',
                    is_automatic INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    reverted_at TEXT
                );
                CREATE TABLE IF NOT EXISTS provider_credentials (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                    provider TEXT NOT NULL,
                    credential_type TEXT NOT NULL,
                    scope TEXT NOT NULL,
                    state TEXT NOT NULL,
                    secret_hint TEXT NOT NULL DEFAULT '',
                    expires_at TEXT,
                    quota_reset_at TEXT,
                    metadata_json TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE (user_id, provider)
                );
                CREATE TABLE IF NOT EXISTS external_mappings (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    provider TEXT NOT NULL,
                    external_id TEXT NOT NULL,
                    entity_type TEXT NOT NULL,
                    entity_id INTEGER NOT NULL,
                    external_library_id TEXT,
                    last_synced_at TEXT,
                    source_payload_json TEXT NOT NULL DEFAULT '{}'
                );
                CREATE TABLE IF NOT EXISTS paper_sources (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    paper_id INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
                    provider TEXT NOT NULL,
                    provider_paper_id TEXT,
                    source_url TEXT,
                    is_primary INTEGER NOT NULL DEFAULT 0,
                    payload_json TEXT NOT NULL DEFAULT '{}',
                    retrieved_at TEXT NOT NULL,
                    UNIQUE (paper_id, provider, provider_paper_id)
                );
                CREATE TABLE IF NOT EXISTS provider_cache (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    operation TEXT NOT NULL,
                    cache_key TEXT NOT NULL UNIQUE,
                    request_json TEXT NOT NULL DEFAULT '{}',
                    response_json TEXT NOT NULL DEFAULT '{}',
                    expires_at TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS paper_relation_snapshots (
                    paper_id INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
                    direction TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'fresh',
                    items_json TEXT NOT NULL DEFAULT '[]',
                    summary_json TEXT NOT NULL DEFAULT '{}',
                    source_summary_json TEXT NOT NULL DEFAULT '[]',
                    degraded_json TEXT NOT NULL DEFAULT '[]',
                    fetched_at TEXT NOT NULL,
                    expires_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (paper_id, direction)
                );
                CREATE TABLE IF NOT EXISTS retrieval_runs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                    paper_id INTEGER REFERENCES papers(id) ON DELETE SET NULL,
                    operation TEXT NOT NULL,
                    status TEXT NOT NULL,
                    cache_hit INTEGER NOT NULL DEFAULT 0,
                    request_json TEXT NOT NULL DEFAULT '{}',
                    stats_json TEXT NOT NULL DEFAULT '{}',
                    degraded_json TEXT NOT NULL DEFAULT '[]',
                    started_at TEXT NOT NULL,
                    completed_at TEXT
                );
                CREATE TABLE IF NOT EXISTS collection_snapshots (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
                    name TEXT NOT NULL,
                    view_type TEXT NOT NULL,
                    state_json TEXT NOT NULL DEFAULT '{}',
                    created_by_user_id INTEGER NOT NULL REFERENCES users(id),
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS followed_entities (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    entity_type TEXT NOT NULL,
                    entity_id INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    UNIQUE (user_id, entity_type, entity_id)
                );
                CREATE TABLE IF NOT EXISTS notifications (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    kind TEXT NOT NULL,
                    title TEXT NOT NULL,
                    message TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'unread',
                    payload_json TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS shared_invites (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
                    email TEXT NOT NULL,
                    role TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending',
                    created_at TEXT NOT NULL,
                    responded_at TEXT
                );
                CREATE TABLE IF NOT EXISTS imports (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    source_type TEXT NOT NULL,
                    status TEXT NOT NULL,
                    summary_json TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS import_items (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    import_id INTEGER NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
                    raw_identifier TEXT NOT NULL,
                    status TEXT NOT NULL,
                    message TEXT NOT NULL DEFAULT '',
                    entity_type TEXT,
                    entity_id INTEGER,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS linked_libraries (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    provider TEXT NOT NULL,
                    external_library_id TEXT NOT NULL,
                    name TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'connected',
                    last_synced_at TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE (user_id, provider, external_library_id)
                );
                CREATE TABLE IF NOT EXISTS topic_assignments (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    entity_type TEXT NOT NULL,
                    entity_id INTEGER NOT NULL,
                    topic TEXT NOT NULL,
                    label TEXT NOT NULL DEFAULT '',
                    confidence REAL NOT NULL DEFAULT 1.0,
                    source TEXT NOT NULL DEFAULT 'provider'
                );
                """
            )
            self._migrate_legacy_relationships(connection)
            connection.commit()

    def _migrate_legacy_relationships(self, connection: sqlite3.Connection) -> None:
        legacy_rows = connection.execute(
            """
            SELECT * FROM paper_relationships
            WHERE relation_type = 'cited_by'
            """
        ).fetchall()
        for row in legacy_rows:
            metadata = json_loads(row["metadata_json"], {})
            metadata.setdefault("evidence", [])
            metadata["evidence"] = [
                {
                    "discovered_from_paper_id": row["source_paper_id"],
                    "observed_as": "citation",
                    "provider": metadata.get("source_provider"),
                    "providers": [metadata.get("source_provider")] if metadata.get("source_provider") else [],
                    "retrieved_at": metadata.get("retrieved_at") or row["created_at"],
                    "edge_state": metadata.get("edge_state", "retrieved"),
                    "record_identifier_state": metadata.get("record_identifier_state", "resolved"),
                }
            ]
            finalized = self._finalize_edge_metadata(metadata)
            connection.execute(
                """
                INSERT OR IGNORE INTO paper_relationships (
                    source_paper_id, target_paper_id, relation_type, confidence, explanation, metadata_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    row["target_paper_id"],
                    row["source_paper_id"],
                    GRAPH_RELATION_TYPE,
                    row["confidence"],
                    row["explanation"],
                    json_dumps(finalized),
                    row["created_at"],
                ),
            )
            connection.execute("DELETE FROM paper_relationships WHERE id = ?", (row["id"],))

    def bootstrap(self, token: Optional[str]) -> Dict[str, Any]:
        user = self.get_user_from_token(token) if token else None
        payload = {
            "me": user,
            "providers": self.list_provider_statuses(user["id"]) if user else self.providers.docs(),
        }
        if user:
            payload["collections"] = self.list_collections(user["id"])
            payload["notifications"] = self.list_notifications(user["id"])
            payload["feed"] = self.get_feed(user["id"])
        return payload

    def _row_to_user(self, row: sqlite3.Row) -> Dict[str, Any]:
        return {
            "id": row["id"],
            "email": row["email"],
            "display_name": row["display_name"],
            "is_verified": bool(row["is_verified"]),
            "disabled": bool(row["disabled"]),
            "profile": json_loads(row["profile_json"], {}),
            "preferences": json_loads(row["preferences_json"], {}),
            "created_at": row["created_at"],
        }

    def register_user(self, email: str, password: str, display_name: Optional[str] = None) -> Dict[str, Any]:
        if not email or "@" not in email:
            raise ServiceError("Email non valida.", status=422)
        if len(password) < 6:
            raise ServiceError("La password deve contenere almeno 6 caratteri.", status=422)
        now = utcnow()
        display_name = display_name or email.split("@", 1)[0]
        with self._connect() as connection:
            existing = connection.execute("SELECT id FROM users WHERE email = ?", (email.lower(),)).fetchone()
            if existing:
                raise ServiceError("Email gia registrata.", status=409)
            cursor = connection.execute(
                """
                INSERT INTO users (email, password_hash, display_name, created_at)
                VALUES (?, ?, ?, ?)
                """,
                (email.lower(), password_hash(password), display_name, now),
            )
            user_id = cursor.lastrowid
        token = self.create_session(user_id)
        self._audit(user_id, "user_registered", "user", user_id, "Nuovo utente registrato.")
        return {"user": self.get_user(user_id), "token": token}

    def create_session(self, user_id: int) -> str:
        token = secrets.token_urlsafe(32)
        expires_at = (datetime.now(timezone.utc) + timedelta(days=7)).replace(microsecond=0).isoformat()
        with self._connect() as connection:
            connection.execute(
                "INSERT INTO sessions (user_id, token, expires_at, created_at) VALUES (?, ?, ?, ?)",
                (user_id, token, expires_at, utcnow()),
            )
        return token

    def login(self, email: str, password: str) -> Dict[str, Any]:
        with self._connect() as connection:
            row = connection.execute("SELECT * FROM users WHERE email = ?", (email.lower(),)).fetchone()
            if not row:
                raise ServiceError("Credenziali errate.", status=401)
            if row["disabled"]:
                raise ServiceError("Utente disabilitato.", status=403)
            if not verify_password(password, row["password_hash"]):
                raise ServiceError("Credenziali errate.", status=401)
        token = self.create_session(row["id"])
        self._audit(row["id"], "user_login", "user", row["id"], "Login effettuato.")
        return {"user": self._row_to_user(row), "token": token}

    def logout(self, token: str) -> None:
        with self._connect() as connection:
            connection.execute("DELETE FROM sessions WHERE token = ?", (token,))

    def recover_access(self, email: str) -> Dict[str, Any]:
        if not email:
            raise ServiceError("Email richiesta.", status=422)
        with self._connect() as connection:
            row = connection.execute("SELECT id FROM users WHERE email = ?", (email.lower(),)).fetchone()
        if not row:
            raise ServiceError("Nessun account trovato per questa email.", status=404)
        recovery_token = secrets.token_urlsafe(16)
        self._audit(row["id"], "user_recovery_requested", "user", row["id"], "Recupero accesso richiesto.")
        return {"recovery_token": recovery_token, "message": "Token di recupero generato per il flusso demo."}

    def get_user(self, user_id: int) -> Dict[str, Any]:
        with self._connect() as connection:
            row = connection.execute("SELECT * FROM users WHERE id = ? AND deleted_at IS NULL", (user_id,)).fetchone()
        if not row:
            raise ServiceError("Utente non trovato.", status=404)
        return self._row_to_user(row)

    def get_user_from_token(self, token: str) -> Optional[Dict[str, Any]]:
        if not token:
            return None
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT users.*
                FROM sessions
                JOIN users ON users.id = sessions.user_id
                WHERE sessions.token = ? AND users.deleted_at IS NULL
                """,
                (token,),
            ).fetchone()
        if not row:
            return None
        return self._row_to_user(row)

    def require_user(self, token: Optional[str]) -> Dict[str, Any]:
        user = self.get_user_from_token(token or "")
        if not user:
            raise ServiceError("Autenticazione richiesta.", status=401)
        return user

    def update_profile(self, user_id: int, payload: Dict[str, Any]) -> Dict[str, Any]:
        profile = payload.get("profile", {})
        preferences = payload.get("preferences", {})
        display_name = payload.get("display_name")
        with self._connect() as connection:
            current = connection.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
            if not current:
                raise ServiceError("Utente non trovato.", status=404)
            connection.execute(
                """
                UPDATE users
                SET display_name = ?, profile_json = ?, preferences_json = ?
                WHERE id = ?
                """,
                (
                    display_name or current["display_name"],
                    json_dumps(profile or json_loads(current["profile_json"], {})),
                    json_dumps({**json_loads(current["preferences_json"], {}), **preferences}),
                    user_id,
                ),
            )
        self._audit(user_id, "user_profile_updated", "user", user_id, "Profilo aggiornato.")
        return self.get_user(user_id)

    def _require_collection_access(self, user_id: int, collection_id: int, *, minimum_role: str = "viewer") -> Dict[str, Any]:
        allowed = {"viewer": 1, "editor": 2, "owner": 3}
        with self._connect() as connection:
            collection = connection.execute("SELECT * FROM collections WHERE id = ?", (collection_id,)).fetchone()
            if not collection:
                raise ServiceError("Collezione non trovata.", status=404)
            if collection["owner_id"] == user_id:
                role = "owner"
            else:
                membership = connection.execute(
                    "SELECT role FROM collection_members WHERE collection_id = ? AND user_id = ?",
                    (collection_id, user_id),
                ).fetchone()
                role = membership["role"] if membership else None
                if not role and collection["visibility"] == "public":
                    role = "viewer"
            if not role or allowed[role] < allowed[minimum_role]:
                raise ServiceError("Permessi insufficienti sulla collezione.", status=403)
        return dict(collection)

    def create_collection(
        self,
        user_id: int,
        name: str,
        description: str = "",
        visibility: str = "private",
        seed_paper_ids: Optional[Sequence[int]] = None,
    ) -> Dict[str, Any]:
        now = utcnow()
        with self._connect() as connection:
            cursor = connection.execute(
                """
                INSERT INTO collections (owner_id, name, description, visibility, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (user_id, name or "Nuova collezione", description, visibility, now, now),
            )
            collection_id = cursor.lastrowid
            connection.execute(
                "INSERT INTO collection_members (collection_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)",
                (collection_id, user_id, now),
            )
            for paper_id in seed_paper_ids or []:
                connection.execute(
                    """
                    INSERT OR IGNORE INTO collection_papers (collection_id, paper_id, added_by_user_id, added_at)
                    VALUES (?, ?, ?, ?)
                    """,
                    (collection_id, paper_id, user_id, now),
                )
        self._audit(user_id, "collection_created", "collection", collection_id, f"Creata collezione {name}.")
        return self.get_collection(user_id, collection_id)

    def get_collection(self, user_id: int, collection_id: int) -> Dict[str, Any]:
        collection = self._require_collection_access(user_id, collection_id)
        with self._connect() as connection:
            papers = connection.execute(
                """
                SELECT papers.*
                FROM collection_papers
                JOIN papers ON papers.id = collection_papers.paper_id
                WHERE collection_papers.collection_id = ? AND papers.merged_into_paper_id IS NULL
                ORDER BY papers.year DESC, papers.title ASC
                """,
                (collection_id,),
            ).fetchall()
            notes = connection.execute(
                """
                SELECT * FROM notes
                WHERE target_type = 'collection' AND target_id = ?
                ORDER BY updated_at DESC
                """,
                (collection_id,),
            ).fetchall()
            members = connection.execute(
                """
                SELECT users.id, users.email, users.display_name, collection_members.role
                FROM collection_members
                JOIN users ON users.id = collection_members.user_id
                WHERE collection_members.collection_id = ?
                ORDER BY collection_members.role DESC, users.display_name ASC
                """,
                (collection_id,),
            ).fetchall()
            snapshots = connection.execute(
                "SELECT * FROM collection_snapshots WHERE collection_id = ? ORDER BY created_at DESC",
                (collection_id,),
            ).fetchall()
        return {
            "id": collection["id"],
            "name": collection["name"],
            "description": collection["description"],
            "visibility": collection["visibility"],
            "status": collection["status"],
            "tags": json_loads(collection["tags_json"], []),
            "papers": [self._row_to_paper(row) for row in papers],
            "notes": [self._row_to_note(row) for row in notes],
            "members": [dict(row) for row in members],
            "snapshots": [dict(row) for row in snapshots],
        }

    def list_collections(self, user_id: int) -> List[Dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT DISTINCT collections.*
                FROM collections
                LEFT JOIN collection_members ON collection_members.collection_id = collections.id
                WHERE collections.owner_id = ? OR collection_members.user_id = ?
                ORDER BY collections.updated_at DESC
                """,
                (user_id, user_id),
            ).fetchall()
        return [
            {
                "id": row["id"],
                "name": row["name"],
                "description": row["description"],
                "visibility": row["visibility"],
                "status": row["status"],
                "tags": json_loads(row["tags_json"], []),
                "updated_at": row["updated_at"],
            }
            for row in rows
        ]

    def list_workspace_papers(self, user_id: int, collection_id: Optional[int] = None) -> List[Dict[str, Any]]:
        with self._connect() as connection:
            if collection_id is not None:
                self._require_collection_access(user_id, collection_id)
                rows = connection.execute(
                    """
                    SELECT papers.*
                    FROM collection_papers
                    JOIN papers ON papers.id = collection_papers.paper_id
                    WHERE collection_papers.collection_id = ? AND papers.merged_into_paper_id IS NULL
                    ORDER BY COALESCE(papers.published_at, printf('%04d-01-01', papers.year)) DESC, papers.title ASC
                    """,
                    (collection_id,),
                ).fetchall()
            else:
                rows = connection.execute(
                    """
                    SELECT papers.*
                    FROM papers
                    WHERE papers.merged_into_paper_id IS NULL
                    ORDER BY COALESCE(papers.published_at, printf('%04d-01-01', papers.year)) DESC, papers.title ASC
                    """
                ).fetchall()
        return [self._row_to_paper(row) for row in rows]

    def update_collection(self, user_id: int, collection_id: int, payload: Dict[str, Any]) -> Dict[str, Any]:
        collection = self._require_collection_access(user_id, collection_id, minimum_role="editor")
        name = payload.get("name", collection["name"])
        description = payload.get("description", collection["description"])
        visibility = payload.get("visibility", collection["visibility"])
        status = payload.get("status", collection["status"])
        tags = payload.get("tags", json_loads(collection["tags_json"], []))
        with self._connect() as connection:
            connection.execute(
                """
                UPDATE collections
                SET name = ?, description = ?, visibility = ?, status = ?, tags_json = ?, updated_at = ?
                WHERE id = ?
                """,
                (name, description, visibility, status, json_dumps(tags), utcnow(), collection_id),
            )
        self._audit(user_id, "collection_updated", "collection", collection_id, f"Aggiornata collezione {name}.")
        return self.get_collection(user_id, collection_id)

    def duplicate_collection(self, user_id: int, collection_id: int) -> Dict[str, Any]:
        source = self.get_collection(user_id, collection_id)
        duplicate = self.create_collection(
            user_id,
            f"{source['name']} (copy)",
            source["description"],
            source["visibility"],
            [paper["id"] for paper in source["papers"]],
        )
        self.update_collection(user_id, duplicate["id"], {"tags": source["tags"]})
        return self.get_collection(user_id, duplicate["id"])

    def merge_collections(self, user_id: int, target_id: int, source_ids: Sequence[int]) -> Dict[str, Any]:
        self._require_collection_access(user_id, target_id, minimum_role="owner")
        with self._connect() as connection:
            for source_id in source_ids:
                self._require_collection_access(user_id, source_id, minimum_role="owner")
                source = connection.execute("SELECT * FROM collections WHERE id = ?", (source_id,)).fetchone()
                if not source:
                    continue
                source_tags = json_loads(source["tags_json"], [])
                target = connection.execute("SELECT * FROM collections WHERE id = ?", (target_id,)).fetchone()
                target_tags = sorted(set(json_loads(target["tags_json"], []) + source_tags))
                connection.execute(
                    "UPDATE collections SET tags_json = ?, updated_at = ? WHERE id = ?",
                    (json_dumps(target_tags), utcnow(), target_id),
                )
                connection.execute(
                    """
                    INSERT OR IGNORE INTO collection_papers (collection_id, paper_id, added_by_user_id, added_at)
                    SELECT ?, paper_id, ?, ?
                    FROM collection_papers WHERE collection_id = ?
                    """,
                    (target_id, user_id, utcnow(), source_id),
                )
                connection.execute(
                    """
                    UPDATE notes
                    SET target_id = ?
                    WHERE target_type = 'collection' AND target_id = ?
                    """,
                    (target_id, source_id),
                )
                connection.execute("UPDATE collections SET status = 'archived', updated_at = ? WHERE id = ?", (utcnow(), source_id))
        self._audit(user_id, "collection_merged", "collection", target_id, "Merge di collezioni completato.")
        return self.get_collection(user_id, target_id)

    def save_snapshot(self, user_id: int, collection_id: int, name: str, view_type: str, state: Dict[str, Any]) -> Dict[str, Any]:
        self._require_collection_access(user_id, collection_id, minimum_role="editor")
        with self._connect() as connection:
            cursor = connection.execute(
                """
                INSERT INTO collection_snapshots (collection_id, name, view_type, state_json, created_by_user_id, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (collection_id, name, view_type, json_dumps(state), user_id, utcnow()),
            )
        self._audit(user_id, "collection_snapshot_saved", "collection", collection_id, f"Snapshot {name} salvata.")
        return {"id": cursor.lastrowid, "collection_id": collection_id, "name": name, "view_type": view_type, "state": state}

    def _credential_states(self, user_id: Optional[int]) -> Dict[str, str]:
        if not user_id:
            return {}
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT provider, state FROM provider_credentials WHERE user_id = ?",
                (user_id,),
            ).fetchall()
        return {row["provider"]: row["state"] for row in rows}

    def _cache_key(self, operation: str, payload: Dict[str, Any]) -> str:
        digest = hashlib.sha256(json_dumps({"operation": operation, "payload": payload}).encode("utf-8")).hexdigest()
        return f"{operation}:{digest}"

    def _cache_get(self, operation: str, payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT response_json, expires_at FROM provider_cache WHERE cache_key = ? AND operation = ?",
                (self._cache_key(operation, payload), operation),
            ).fetchone()
        if not row or not iso_after_now(row["expires_at"]):
            return None
        return json_loads(row["response_json"], {})

    def _cache_set(self, operation: str, payload: Dict[str, Any], response: Dict[str, Any], ttl_seconds: int) -> None:
        now = utcnow()
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO provider_cache (operation, cache_key, request_json, response_json, expires_at, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (cache_key) DO UPDATE SET
                    request_json = excluded.request_json,
                    response_json = excluded.response_json,
                    expires_at = excluded.expires_at,
                    updated_at = excluded.updated_at
                """,
                (
                    operation,
                    self._cache_key(operation, payload),
                    json_dumps(payload),
                    json_dumps(response),
                    iso_plus_seconds(ttl_seconds),
                    now,
                    now,
                ),
            )

    def _cached_provider_lookup(self, identifier_type: str, value: str, credential_states: Dict[str, str], *, force_refresh: bool = False) -> Dict[str, Any]:
        payload = {"identifier_type": identifier_type, "value": value}
        if not force_refresh:
            cached = self._cache_get("lookup", payload)
            if cached:
                return {**cached, "cache_hit": True}
        response = self.providers.lookup(identifier_type, value, credential_states)
        self._cache_set("lookup", payload, response, self.config.provider_cache_ttl_seconds)
        return {**response, "cache_hit": False}

    def _cached_provider_search(self, query: str, credential_states: Dict[str, str], *, force_refresh: bool = False) -> Dict[str, Any]:
        payload = {"query": query}
        if not force_refresh:
            cached = self._cache_get("search", payload)
            if cached:
                return {**cached, "cache_hit": True}
        response = self.providers.search(query, credential_states)
        self._cache_set("search", payload, response, self.config.search_cache_ttl_seconds)
        return {**response, "cache_hit": False}

    def _cached_provider_relations(self, seed_record: Dict[str, Any], credential_states: Dict[str, str], *, force_refresh: bool = False) -> Dict[str, Any]:
        payload = {
            "doi": seed_record.get("doi"),
            "title": seed_record.get("title"),
            "external_ids": seed_record.get("external_ids", {}),
            "graph_hints": seed_record.get("graph_hints", {}),
        }
        if not force_refresh:
            cached = self._cache_get("relations", payload)
            if cached:
                return {**cached, "cache_hit": True}
        response = self.providers.relations(seed_record, credential_states)
        self._cache_set("relations", payload, response, self.config.provider_cache_ttl_seconds)
        return {**response, "cache_hit": False}

    def _start_retrieval_run(self, user_id: Optional[int], paper_id: Optional[int], operation: str, request_payload: Dict[str, Any]) -> int:
        with self._connect() as connection:
            cursor = connection.execute(
                """
                INSERT INTO retrieval_runs (user_id, paper_id, operation, status, request_json, started_at)
                VALUES (?, ?, ?, 'running', ?, ?)
                """,
                (user_id, paper_id, operation, json_dumps(request_payload), utcnow()),
            )
        return cursor.lastrowid

    def _finish_retrieval_run(
        self,
        run_id: int,
        *,
        status: str,
        stats: Optional[Dict[str, Any]] = None,
        degraded: Optional[List[str]] = None,
        cache_hit: bool = False,
        paper_id: Optional[int] = None,
    ) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                UPDATE retrieval_runs
                SET paper_id = COALESCE(?, paper_id),
                    status = ?,
                    cache_hit = ?,
                    stats_json = ?,
                    degraded_json = ?,
                    completed_at = ?
                WHERE id = ?
                """,
                (
                    paper_id,
                    status,
                    int(cache_hit),
                    json_dumps(stats or {}),
                    json_dumps(degraded or []),
                    utcnow(),
                    run_id,
                ),
            )

    def list_provider_statuses(self, user_id: Optional[int]) -> List[Dict[str, Any]]:
        states = self._credential_states(user_id)
        result = []
        for doc in self.providers.docs():
            default_state = "valid"
            if doc["requires_credentials"]:
                if doc["name"] == "openalex" and self.config.openalex_api_key:
                    default_state = "configured"
                else:
                    default_state = "assente"
            result.append({**doc, "credential_state": states.get(doc["name"], default_state)})
        return result

    def upsert_provider_credential(self, user_id: int, payload: Dict[str, Any]) -> Dict[str, Any]:
        provider = payload["provider"]
        state = payload.get("state", "valid")
        now = utcnow()
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO provider_credentials (
                    user_id, provider, credential_type, scope, state, secret_hint, expires_at, quota_reset_at,
                    metadata_json, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (user_id, provider) DO UPDATE SET
                    credential_type = excluded.credential_type,
                    scope = excluded.scope,
                    state = excluded.state,
                    secret_hint = excluded.secret_hint,
                    expires_at = excluded.expires_at,
                    quota_reset_at = excluded.quota_reset_at,
                    metadata_json = excluded.metadata_json,
                    updated_at = excluded.updated_at
                """,
                (
                    user_id,
                    provider,
                    payload.get("credential_type", "api_key"),
                    payload.get("scope", "user"),
                    state,
                    payload.get("secret_hint", ""),
                    payload.get("expires_at"),
                    payload.get("quota_reset_at"),
                    json_dumps(payload.get("metadata", {})),
                    now,
                    now,
                ),
            )
        self._audit(user_id, "provider_credential_updated", "provider", None, f"Credenziale aggiornata per {provider}.")
        return {"provider": provider, "state": state}

    def _classify_quality(self, metadata: Dict[str, Any]) -> Tuple[str, str]:
        missing = []
        for field in ("title", "authors", "year"):
            if not metadata.get(field):
                missing.append(field)
        quality = "completo"
        reliability = "affidabile"
        if metadata.get("manual"):
            quality = "manuale"
            reliability = "da_verificare"
        elif missing:
            quality = "parziale"
            reliability = "da_verificare"
        if metadata.get("ambiguous"):
            quality = "ambiguo"
            reliability = "da_verificare"
        if metadata.get("retraction_state"):
            quality = "corretto_ritirato"
            reliability = "da_verificare"
        return quality, reliability

    def _find_existing_paper(self, connection: sqlite3.Connection, metadata: Dict[str, Any]) -> Optional[sqlite3.Row]:
        doi = normalize_doi(metadata.get("doi"))
        if doi:
            row = connection.execute(
                "SELECT * FROM papers WHERE doi = ? AND merged_into_paper_id IS NULL",
                (doi,),
            ).fetchone()
            if row:
                return row
        row = connection.execute(
            "SELECT * FROM papers WHERE canonical_key = ? AND merged_into_paper_id IS NULL",
            (canonical_key(metadata),),
        ).fetchone()
        return row

    def _ensure_author(self, connection: sqlite3.Connection, name: str, metadata: Dict[str, Any]) -> int:
        normalized = normalize_text(name)
        row = connection.execute("SELECT * FROM authors").fetchall()
        for candidate in row:
            if normalize_text(candidate["canonical_name"]) == normalized:
                return candidate["id"]
            aliases = json_loads(candidate["aliases_json"], [])
            if normalized in {normalize_text(alias) for alias in aliases}:
                return candidate["id"]
        cursor = connection.execute(
            """
            INSERT INTO authors (canonical_name, aliases_json, external_ids_json, affiliations_json, topics_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                name,
                json_dumps([]),
                json_dumps({}),
                json_dumps(metadata.get("affiliations", [])),
                json_dumps(metadata.get("topics", [])),
                utcnow(),
                utcnow(),
            ),
        )
        return cursor.lastrowid

    def _upsert_paper_sources(self, connection: sqlite3.Connection, paper_id: int, metadata: Dict[str, Any]) -> None:
        for source in metadata.get("raw_sources", []):
            connection.execute(
                """
                INSERT INTO paper_sources (paper_id, provider, provider_paper_id, source_url, is_primary, payload_json, retrieved_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (paper_id, provider, provider_paper_id) DO UPDATE SET
                    source_url = excluded.source_url,
                    is_primary = excluded.is_primary,
                    payload_json = excluded.payload_json,
                    retrieved_at = excluded.retrieved_at
                """,
                (
                    paper_id,
                    source.get("provider"),
                    source.get("provider_id"),
                    source.get("source_url"),
                    int(bool(source.get("is_primary"))),
                    json_dumps(source.get("payload", {})),
                    source.get("retrieved_at", utcnow()),
                ),
            )

    def _attach_topics(self, connection: sqlite3.Connection, paper_id: int, topics: Iterable[str]) -> None:
        seen = set()
        for topic in topics:
            topic_text = topic.strip()
            if not topic_text or topic_text in seen:
                continue
            seen.add(topic_text)
            connection.execute(
                """
                INSERT INTO topic_assignments (entity_type, entity_id, topic, label, confidence, source)
                VALUES ('paper', ?, ?, ?, 1.0, 'provider')
                """,
                (paper_id, topic_text, topic_text),
            )

    def _ensure_paper(self, connection: sqlite3.Connection, metadata: Dict[str, Any], actor_user_id: Optional[int], automatic: bool = False) -> Dict[str, Any]:
        metadata = dict(metadata)
        metadata["doi"] = normalize_doi(metadata.get("doi"))
        metadata["authors"] = parse_authors(metadata.get("authors"))
        quality, reliability = self._classify_quality(metadata)
        existing = self._find_existing_paper(connection, metadata)
        if existing:
            details = json_loads(existing["metadata_json"], {})
            merged = {**details, **{key: value for key, value in metadata.items() if value not in (None, "", [], {})}}
            quality, reliability = self._classify_quality(merged)
            connection.execute(
                """
                UPDATE papers
                SET subtitle = COALESCE(subtitle, ?),
                    abstract = COALESCE(abstract, ?),
                    venue = COALESCE(venue, ?),
                    year = COALESCE(year, ?),
                    published_at = COALESCE(published_at, ?),
                    publication_type = COALESCE(publication_type, ?),
                    language = COALESCE(language, ?),
                    canonical_url = COALESCE(canonical_url, ?),
                    pdf_url = COALESCE(pdf_url, ?),
                    metadata_json = ?,
                    quality_state = ?,
                    reliability_state = ?,
                    retraction_state = COALESCE(retraction_state, ?),
                    updated_at = ?
                WHERE id = ?
                """,
                (
                    metadata.get("subtitle"),
                    metadata.get("abstract"),
                    metadata.get("venue"),
                    metadata.get("year"),
                    metadata.get("published_at"),
                    metadata.get("publication_type"),
                    metadata.get("language"),
                    metadata.get("canonical_url"),
                    metadata.get("pdf_url"),
                    json_dumps(merged),
                    quality,
                    reliability,
                    metadata.get("retraction_state"),
                    utcnow(),
                    existing["id"],
                ),
            )
            self._upsert_paper_sources(connection, existing["id"], merged)
            return self._row_to_paper(connection.execute("SELECT * FROM papers WHERE id = ?", (existing["id"],)).fetchone())
        cursor = connection.execute(
            """
            INSERT INTO papers (
                canonical_key, doi, title, subtitle, abstract, venue, year, published_at, publication_type, language,
                canonical_url, pdf_url, metadata_json, quality_state, reliability_state, retraction_state, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                canonical_key(metadata),
                metadata.get("doi"),
                metadata.get("title") or "Record manuale",
                metadata.get("subtitle"),
                metadata.get("abstract"),
                metadata.get("venue"),
                metadata.get("year"),
                metadata.get("published_at"),
                metadata.get("publication_type"),
                metadata.get("language"),
                metadata.get("canonical_url"),
                metadata.get("pdf_url"),
                json_dumps(metadata),
                quality,
                reliability,
                metadata.get("retraction_state"),
                utcnow(),
                utcnow(),
            ),
        )
        paper_id = cursor.lastrowid
        for position, author_name in enumerate(metadata["authors"], start=1):
            author_id = self._ensure_author(connection, author_name, metadata)
            connection.execute(
                "INSERT OR IGNORE INTO paper_authors (paper_id, author_id, author_position) VALUES (?, ?, ?)",
                (paper_id, author_id, position),
            )
        self._attach_topics(connection, paper_id, metadata.get("topics", []) + metadata.get("keywords", []))
        self._upsert_paper_sources(connection, paper_id, metadata)
        return self._row_to_paper(connection.execute("SELECT * FROM papers WHERE id = ?", (paper_id,)).fetchone())

    def _row_to_paper(self, row: sqlite3.Row) -> Dict[str, Any]:
        metadata = json_loads(row["metadata_json"], {})
        return {
            "id": row["id"],
            "doi": row["doi"],
            "title": row["title"],
            "subtitle": row["subtitle"],
            "abstract": row["abstract"],
            "venue": row["venue"],
            "year": row["year"],
            "published_at": row["published_at"],
            "publication_type": row["publication_type"],
            "language": row["language"],
            "canonical_url": row["canonical_url"],
            "pdf_url": row["pdf_url"],
            "quality_state": row["quality_state"],
            "reliability_state": row["reliability_state"],
            "retraction_state": row["retraction_state"],
            "metadata": metadata,
        }

    def _row_to_note(self, row: sqlite3.Row) -> Dict[str, Any]:
        return {
            "id": row["id"],
            "target_type": row["target_type"],
            "target_id": row["target_id"],
            "collection_id": row["collection_id"],
            "author_user_id": row["author_user_id"],
            "visibility": row["visibility"],
            "body": row["body"],
            "version": row["version"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    def _relation_snapshot_ttl_seconds(self, direction: str) -> int:
        if direction == "references":
            return self.config.reference_cache_ttl_seconds
        if direction == "citations":
            return self.config.citation_cache_ttl_seconds
        raise ServiceError("Direzione snapshot non valida.", status=422)

    def _build_relation_seed_record(self, connection: sqlite3.Connection, paper_row: sqlite3.Row) -> Dict[str, Any]:
        metadata = json_loads(paper_row["metadata_json"], {})
        external_ids = dict(metadata.get("external_ids", {}))
        graph_hints = dict(metadata.get("graph_hints", {}))
        source_rows = connection.execute(
            """
            SELECT provider, provider_paper_id, source_url
            FROM paper_sources
            WHERE paper_id = ?
            ORDER BY is_primary DESC, provider ASC
            """,
            (paper_row["id"],),
        ).fetchall()
        for source in source_rows:
            if source["provider"] == "openalex":
                openalex_id = source["provider_paper_id"] or source["source_url"]
                if openalex_id:
                    external_ids.setdefault("openalex", openalex_id)
                    graph_hints.setdefault("openalex_id", openalex_id)
        return {
            **metadata,
            "doi": paper_row["doi"],
            "title": paper_row["title"],
            "external_ids": external_ids,
            "graph_hints": graph_hints,
        }

    def _relation_item_from_record(
        self,
        connection: sqlite3.Connection,
        direction: str,
        related_record: Dict[str, Any],
    ) -> Dict[str, Any]:
        paper = self._ensure_paper(connection, related_record, None, automatic=True)
        related_row = connection.execute("SELECT * FROM papers WHERE id = ?", (paper["id"],)).fetchone()
        related_paper = self._row_to_paper(related_row)
        providers = [item.get("provider") for item in related_record.get("raw_sources", []) if item.get("provider")]
        providers = list(dict.fromkeys(providers))
        edge_state = self._edge_state_for_record(related_record)
        return {
            "direction": direction,
            "relation_type": "cites" if direction == "references" else "cited_by",
            "paper": {
                "id": related_paper["id"],
                "doi": related_paper["doi"],
                "title": related_paper["title"],
                "venue": related_paper["venue"],
                "year": related_paper["year"],
                "published_at": related_paper["published_at"],
                "quality_state": related_paper["quality_state"],
                "reliability_state": related_paper["reliability_state"],
            },
            "edge": {
                "state": edge_state,
                "confidence": 1.0,
                "explanation": "Fetched live from external providers and normalized by the backend.",
                "providers": providers,
                "discovered_via": [direction[:-1] if direction.endswith("s") else direction],
                "retrieved_at": utcnow(),
                "evidence_count": max(1, len(providers)),
            },
        }

    def _relation_summary_from_items(self, items: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
        return {
            "count": len(items),
            "retrieved": sum(1 for item in items if item["edge"]["state"] == "retrieved"),
            "partial": sum(1 for item in items if item["edge"]["state"] == "partial"),
            "incomplete": sum(1 for item in items if item["edge"]["state"] == "incomplete"),
            "inferred": sum(1 for item in items if item["edge"]["state"] == "inferred"),
        }

    def _snapshot_payload(self, row: sqlite3.Row) -> Dict[str, Any]:
        stale = not iso_after_now(row["expires_at"])
        return {
            "direction": row["direction"],
            "status": row["status"],
            "items": json_loads(row["items_json"], []),
            "summary": json_loads(row["summary_json"], {}),
            "sources_used": json_loads(row["source_summary_json"], []),
            "degraded": json_loads(row["degraded_json"], []),
            "fetched_at": row["fetched_at"],
            "expires_at": row["expires_at"],
            "stale": stale,
        }

    def _load_relation_snapshot(self, connection: sqlite3.Connection, paper_id: int, direction: str) -> Optional[Dict[str, Any]]:
        row = connection.execute(
            """
            SELECT * FROM paper_relation_snapshots
            WHERE paper_id = ? AND direction = ?
            """,
            (paper_id, direction),
        ).fetchone()
        return self._snapshot_payload(row) if row else None

    def _save_relation_snapshot(
        self,
        connection: sqlite3.Connection,
        *,
        paper_id: int,
        direction: str,
        items: Sequence[Dict[str, Any]],
        degraded: Sequence[str],
        sources_used: Optional[Sequence[str]] = None,
    ) -> Dict[str, Any]:
        fetched_at = utcnow()
        expires_at = iso_plus_seconds(self._relation_snapshot_ttl_seconds(direction))
        normalized_sources = list(dict.fromkeys(sources_used or []))
        if not normalized_sources:
            for item in items:
                for provider in item.get("edge", {}).get("providers", []):
                    if provider not in normalized_sources:
                        normalized_sources.append(provider)
        summary = self._relation_summary_from_items(items)
        status = "fresh"
        connection.execute(
            """
            INSERT INTO paper_relation_snapshots (
                paper_id, direction, status, items_json, summary_json, source_summary_json,
                degraded_json, fetched_at, expires_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (paper_id, direction) DO UPDATE SET
                status = excluded.status,
                items_json = excluded.items_json,
                summary_json = excluded.summary_json,
                source_summary_json = excluded.source_summary_json,
                degraded_json = excluded.degraded_json,
                fetched_at = excluded.fetched_at,
                expires_at = excluded.expires_at,
                updated_at = excluded.updated_at
            """,
            (
                paper_id,
                direction,
                status,
                json_dumps(list(items)),
                json_dumps(summary),
                json_dumps(normalized_sources),
                json_dumps(list(dict.fromkeys(degraded))),
                fetched_at,
                expires_at,
                fetched_at,
            ),
        )
        row = connection.execute(
            """
            SELECT * FROM paper_relation_snapshots
            WHERE paper_id = ? AND direction = ?
            """,
            (paper_id, direction),
        ).fetchone()
        return self._snapshot_payload(row)

    def _graph_modes(self, mode: str) -> List[str]:
        if mode == "all":
            return ["references", "citations"]
        if mode not in GRAPH_MODES:
            raise ServiceError("Modalita di refresh grafo non valida.", status=422)
        return [mode]

    def _edge_state_for_record(self, record: Dict[str, Any]) -> str:
        has_identifier = bool(normalize_doi(record.get("doi")) or any(record.get("external_ids", {}).values()))
        quality, _reliability = self._classify_quality(record)
        if not has_identifier:
            return "incomplete"
        if quality in {"ambiguo", "parziale", "manuale"}:
            return "partial"
        return "retrieved"

    def _evidence_key(self, evidence: Dict[str, Any]) -> Tuple[Any, ...]:
        return (
            evidence.get("discovered_from_paper_id"),
            evidence.get("observed_as"),
            evidence.get("provider"),
        )

    def _finalize_edge_metadata(self, metadata: Dict[str, Any]) -> Dict[str, Any]:
        evidence = metadata.get("evidence", []) or []
        providers = []
        discovered_via = []
        last_retrieved_at = None
        edge_states = set()
        for item in evidence:
            provider = item.get("provider")
            if provider and provider not in providers:
                providers.append(provider)
            observed_as = item.get("observed_as")
            if observed_as and observed_as not in discovered_via:
                discovered_via.append(observed_as)
            retrieved_at = item.get("retrieved_at")
            if retrieved_at and (last_retrieved_at is None or retrieved_at > last_retrieved_at):
                last_retrieved_at = retrieved_at
            if item.get("edge_state"):
                edge_states.add(item["edge_state"])
        metadata["source_providers"] = providers
        metadata["discovered_via"] = discovered_via
        metadata["last_retrieved_at"] = last_retrieved_at
        metadata["evidence_count"] = len(evidence)
        if "incomplete" in edge_states:
            metadata["aggregate_state"] = "incomplete"
        elif "partial" in edge_states:
            metadata["aggregate_state"] = "partial"
        elif evidence:
            metadata["aggregate_state"] = "retrieved"
        else:
            metadata["aggregate_state"] = "unknown"
        return metadata

    def _upsert_graph_edge(
        self,
        connection: sqlite3.Connection,
        *,
        source_paper_id: int,
        target_paper_id: int,
        confidence: float,
        explanation: str,
        evidence: Dict[str, Any],
    ) -> None:
        if source_paper_id == target_paper_id:
            return
        existing = connection.execute(
            """
            SELECT * FROM paper_relationships
            WHERE source_paper_id = ? AND target_paper_id = ? AND relation_type = ?
            """,
            (source_paper_id, target_paper_id, GRAPH_RELATION_TYPE),
        ).fetchone()
        if existing:
            metadata = json_loads(existing["metadata_json"], {})
            evidence_list = metadata.get("evidence", []) or []
            evidence_index = {self._evidence_key(item): item for item in evidence_list}
            evidence_index[self._evidence_key(evidence)] = evidence
            metadata["evidence"] = list(evidence_index.values())
            finalized = self._finalize_edge_metadata(metadata)
            connection.execute(
                """
                UPDATE paper_relationships
                SET confidence = ?, explanation = ?, metadata_json = ?
                WHERE id = ?
                """,
                (
                    max(existing["confidence"], confidence),
                    explanation,
                    json_dumps(finalized),
                    existing["id"],
                ),
            )
            return
        metadata = self._finalize_edge_metadata({"evidence": [evidence]})
        connection.execute(
            """
            INSERT INTO paper_relationships (source_paper_id, target_paper_id, relation_type, confidence, explanation, metadata_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (source_paper_id, target_paper_id, GRAPH_RELATION_TYPE, confidence, explanation, json_dumps(metadata), utcnow()),
        )

    def _prune_graph_observations(self, connection: sqlite3.Connection, seed_paper_id: int, modes: Sequence[str]) -> int:
        deleted = 0
        if "references" in modes:
            rows = connection.execute(
                """
                SELECT * FROM paper_relationships
                WHERE relation_type = ? AND source_paper_id = ?
                """,
                (GRAPH_RELATION_TYPE, seed_paper_id),
            ).fetchall()
            deleted += self._prune_rows_by_evidence(connection, rows, seed_paper_id, "reference")
        if "citations" in modes:
            rows = connection.execute(
                """
                SELECT * FROM paper_relationships
                WHERE relation_type = ? AND target_paper_id = ?
                """,
                (GRAPH_RELATION_TYPE, seed_paper_id),
            ).fetchall()
            deleted += self._prune_rows_by_evidence(connection, rows, seed_paper_id, "citation")
        return deleted

    def _prune_rows_by_evidence(
        self,
        connection: sqlite3.Connection,
        rows: Sequence[sqlite3.Row],
        seed_paper_id: int,
        observed_as: str,
    ) -> int:
        deleted = 0
        for row in rows:
            metadata = json_loads(row["metadata_json"], {})
            evidence = metadata.get("evidence", []) or []
            filtered = [
                item
                for item in evidence
                if not (
                    item.get("discovered_from_paper_id") == seed_paper_id
                    and item.get("observed_as") == observed_as
                )
            ]
            if filtered:
                metadata["evidence"] = filtered
                finalized = self._finalize_edge_metadata(metadata)
                connection.execute(
                    "UPDATE paper_relationships SET metadata_json = ? WHERE id = ?",
                    (json_dumps(finalized), row["id"]),
                )
                continue
            connection.execute("DELETE FROM paper_relationships WHERE id = ?", (row["id"],))
            deleted += 1
        return deleted

    def _ensure_relationship_graph(
        self,
        connection: sqlite3.Connection,
        seed_paper_id: int,
        relations: Dict[str, List[Dict[str, Any]]],
        *,
        modes: Sequence[str],
        rebuild: bool,
    ) -> Dict[str, int]:
        created = 0
        pruned = self._prune_graph_observations(connection, seed_paper_id, modes) if rebuild else 0
        now = utcnow()
        if "references" in modes:
            for reference in relations.get("references", []):
                target = self._ensure_paper(connection, reference, None, automatic=True)
                self._upsert_graph_edge(
                    connection,
                    source_paper_id=seed_paper_id,
                    target_paper_id=target["id"],
                    confidence=1.0,
                    explanation="Recovered from external references list.",
                    evidence={
                        "discovered_from_paper_id": seed_paper_id,
                        "observed_as": "reference",
                        "provider": (reference.get("raw_sources") or [{}])[0].get("provider"),
                        "providers": [item.get("provider") for item in reference.get("raw_sources", []) if item.get("provider")],
                        "retrieved_at": now,
                        "edge_state": self._edge_state_for_record(reference),
                        "record_identifier_state": "resolved"
                        if normalize_doi(reference.get("doi")) or any(reference.get("external_ids", {}).values())
                        else "unresolved",
                    },
                )
                created += 1
        if "citations" in modes:
            for citation in relations.get("citations", []):
                source = self._ensure_paper(connection, citation, None, automatic=True)
                self._upsert_graph_edge(
                    connection,
                    source_paper_id=source["id"],
                    target_paper_id=seed_paper_id,
                    confidence=1.0,
                    explanation="Recovered from external citations list.",
                    evidence={
                        "discovered_from_paper_id": seed_paper_id,
                        "observed_as": "citation",
                        "provider": (citation.get("raw_sources") or [{}])[0].get("provider"),
                        "providers": [item.get("provider") for item in citation.get("raw_sources", []) if item.get("provider")],
                        "retrieved_at": now,
                        "edge_state": self._edge_state_for_record(citation),
                        "record_identifier_state": "resolved"
                        if normalize_doi(citation.get("doi")) or any(citation.get("external_ids", {}).values())
                        else "unresolved",
                    },
                )
                created += 1
        return {"upserted": created, "pruned": pruned}

    def add_paper(
        self,
        user_id: int,
        *,
        identifier_type: str,
        value: Optional[str] = None,
        collection_id: Optional[int] = None,
        metadata: Optional[Dict[str, Any]] = None,
        force_refresh: bool = False,
    ) -> Dict[str, Any]:
        if collection_id:
            self._require_collection_access(user_id, collection_id, minimum_role="editor")
        credential_states = self._credential_states(user_id)
        degraded: List[str] = []
        source_provider = None
        record_data = metadata or {}
        retrieval_run_id: Optional[int] = None
        cache_hit = False
        relations: Optional[Dict[str, Any]] = None
        if identifier_type != "manual":
            retrieval_run_id = self._start_retrieval_run(
                user_id,
                None,
                "paper_ingest",
                {"identifier_type": identifier_type, "value": value, "collection_id": collection_id, "force_refresh": force_refresh},
            )
            lookup = self._cached_provider_lookup(identifier_type, value or "", credential_states, force_refresh=force_refresh)
            degraded = lookup["degraded"]
            source_provider = lookup["provider"]
            cache_hit = lookup.get("cache_hit", False)
            if lookup["record"]:
                record_data = dict(lookup["record"])
            elif identifier_type in {"doi", "title", "url"}:
                record_data = {
                    "doi": value if identifier_type == "doi" else None,
                    "title": value if identifier_type == "title" else metadata.get("title") if metadata else None,
                    "canonical_url": value if identifier_type == "url" else None,
                    "manual": True,
                    "quality_note": "Manual fallback due to unresolved external lookup.",
                }
        if not record_data.get("title") and not record_data.get("doi"):
            if retrieval_run_id:
                self._finish_retrieval_run(retrieval_run_id, status="failed", degraded=["Record minimo non valido."], cache_hit=cache_hit)
            raise ServiceError("Record minimo non valido.", status=422)
        if record_data.get("doi") or record_data.get("graph_hints") or record_data.get("external_ids"):
            relations = self._cached_provider_relations(record_data, credential_states, force_refresh=force_refresh)
            degraded.extend(relations["degraded"])
            if lookup := relations.get("provider"):
                source_provider = source_provider or lookup
            cache_hit = cache_hit and relations.get("cache_hit", False) if identifier_type != "manual" else relations.get("cache_hit", False)
        with self._connect() as connection:
            paper = self._ensure_paper(connection, record_data, user_id)
            if collection_id:
                connection.execute(
                    """
                    INSERT OR IGNORE INTO collection_papers (collection_id, paper_id, added_by_user_id, added_at)
                    VALUES (?, ?, ?, ?)
                    """,
                    (collection_id, paper["id"], user_id, utcnow()),
                )
            if relations:
                self._ensure_relationship_graph(connection, paper["id"], relations["relations"], modes=["references", "citations"], rebuild=False)
            connection.commit()
        if retrieval_run_id:
            relation_summary = self.get_paper(paper["id"])
            self._finish_retrieval_run(
                retrieval_run_id,
                status="completed",
                stats={
                    "paper_id": paper["id"],
                    "references": sum(1 for item in relation_summary["relations"] if item["relation_type"] == "cites"),
                    "citations": sum(1 for item in relation_summary["relations"] if item["relation_type"] == "cited_by"),
                },
                degraded=degraded,
                cache_hit=cache_hit,
                paper_id=paper["id"],
            )
        self._audit(user_id, "paper_added", "paper", paper["id"], f"Aggiunto paper {paper['title']}.", details={"collection_id": collection_id})
        return {"paper": self.get_paper(paper["id"]), "provider": source_provider, "degraded": degraded}

    def get_live_relations(
        self,
        user_id: int,
        paper_id: int,
        *,
        direction: str = "all",
        force_refresh: bool = False,
    ) -> Dict[str, Any]:
        directions = self._graph_modes(direction)
        credential_states = self._credential_states(user_id)
        available_sources = [
            provider.capability.name
            for provider in getattr(self.providers, "providers", [])
            if not hasattr(self.providers, "_provider_available") or self.providers._provider_available(provider, credential_states)
        ]
        with self._connect() as connection:
            paper_row = connection.execute("SELECT * FROM papers WHERE id = ?", (paper_id,)).fetchone()
            if not paper_row:
                raise ServiceError("Paper non trovato.", status=404)
            snapshots = {item: self._load_relation_snapshot(connection, paper_id, item) for item in directions}
            metadata = json_loads(paper_row["metadata_json"], {})
            relation_hints = {
                "references": metadata.get("reference_count"),
                "citations": metadata.get("citation_count"),
            }
            stale_directions = [
                item
                for item, snapshot in snapshots.items()
                if force_refresh
                or snapshot is None
                or snapshot["stale"]
                or (
                    snapshot.get("summary", {}).get("count", 0) == 0
                    and not snapshot.get("sources_used")
                )
                or (
                    snapshot.get("summary", {}).get("count", 0) == 0
                    and isinstance(relation_hints.get(item), int)
                    and relation_hints.get(item, 0) > 0
                )
            ]
            seed_record = self._build_relation_seed_record(connection, paper_row)
        degraded: List[str] = []
        cache_hit = not stale_directions
        refreshed: List[str] = []
        if stale_directions:
            if not (seed_record.get("doi") or seed_record.get("graph_hints") or seed_record.get("external_ids")):
                raise ServiceError("Il paper non ha identificatori sufficienti per recuperare relations live.", status=422)
            run_id = self._start_retrieval_run(
                user_id,
                paper_id,
                "paper_relations_live_refresh",
                {"paper_id": paper_id, "directions": stale_directions, "force_refresh": force_refresh},
            )
            relations_payload = self._cached_provider_relations(seed_record, credential_states, force_refresh=True)
            degraded = relations_payload.get("degraded", [])
            with self._connect() as connection:
                for item in stale_directions:
                    relation_items = [
                        self._relation_item_from_record(connection, item, record)
                        for record in relations_payload["relations"].get(item, [])
                    ]
                    snapshots[item] = self._save_relation_snapshot(
                        connection,
                        paper_id=paper_id,
                        direction=item,
                        items=relation_items,
                        degraded=degraded,
                        sources_used=available_sources,
                    )
                    refreshed.append(item)
                connection.commit()
            self._finish_retrieval_run(
                run_id,
                status="completed",
                stats={
                    "paper_id": paper_id,
                    "directions": stale_directions,
                    "references": snapshots.get("references", {}).get("summary", {}).get("count", 0),
                    "citations": snapshots.get("citations", {}).get("summary", {}).get("count", 0),
                },
                degraded=degraded,
                cache_hit=False,
                paper_id=paper_id,
            )
        return {
            "paper_id": paper_id,
            "cache_hit": cache_hit,
            "refreshed": refreshed,
            "references": snapshots.get("references"),
            "citations": snapshots.get("citations"),
            "degraded": degraded,
        }

    def _relation_state_for_paper(self, paper_id: int, direction: str, metadata: Dict[str, Any], related_quality_state: Optional[str]) -> str:
        evidence = metadata.get("evidence", []) or []
        observed_as = "reference" if direction == "references" else "citation"
        directly_observed = any(
            item.get("discovered_from_paper_id") == paper_id and item.get("observed_as") == observed_as
            for item in evidence
        )
        if any(item.get("edge_state") == "incomplete" for item in evidence):
            return "incomplete"
        if related_quality_state in {"manuale", "parziale", "ambiguo"}:
            return "incomplete"
        if directly_observed:
            return "retrieved"
        if any(item.get("edge_state") == "partial" for item in evidence):
            return "partial"
        return "inferred"

    def _relation_entry_from_row(self, paper_id: int, direction: str, row: sqlite3.Row) -> Dict[str, Any]:
        metadata = json_loads(row["metadata_json"], {})
        related = {
            "id": row["related_id"],
            "doi": row["related_doi"],
            "title": row["related_title"],
            "venue": row["related_venue"],
            "year": row["related_year"],
            "published_at": row["related_published_at"],
            "quality_state": row["related_quality_state"],
            "reliability_state": row["related_reliability_state"],
        }
        state = self._relation_state_for_paper(paper_id, direction, metadata, row["related_quality_state"])
        return {
            "direction": direction,
            "relation_type": "cites" if direction == "references" else "cited_by",
            "paper": related,
            "edge": {
                "id": row["id"],
                "state": state,
                "confidence": row["confidence"],
                "explanation": row["explanation"],
                "providers": metadata.get("source_providers", []),
                "discovered_via": metadata.get("discovered_via", []),
                "retrieved_at": metadata.get("last_retrieved_at"),
                "evidence_count": metadata.get("evidence_count", 0),
                "metadata": metadata,
            },
        }

    def _paper_relations(self, connection: sqlite3.Connection, paper_id: int) -> Dict[str, Any]:
        outgoing_rows = connection.execute(
            """
            SELECT
                paper_relationships.*,
                papers.id AS related_id,
                papers.doi AS related_doi,
                papers.title AS related_title,
                papers.venue AS related_venue,
                papers.year AS related_year,
                papers.published_at AS related_published_at,
                papers.quality_state AS related_quality_state,
                papers.reliability_state AS related_reliability_state
            FROM paper_relationships
            JOIN papers ON papers.id = paper_relationships.target_paper_id
            WHERE paper_relationships.source_paper_id = ? AND paper_relationships.relation_type = ? AND papers.merged_into_paper_id IS NULL
            ORDER BY COALESCE(papers.published_at, printf('%04d-01-01', papers.year)) DESC, papers.title ASC
            """,
            (paper_id, GRAPH_RELATION_TYPE),
        ).fetchall()
        incoming_rows = connection.execute(
            """
            SELECT
                paper_relationships.*,
                papers.id AS related_id,
                papers.doi AS related_doi,
                papers.title AS related_title,
                papers.venue AS related_venue,
                papers.year AS related_year,
                papers.published_at AS related_published_at,
                papers.quality_state AS related_quality_state,
                papers.reliability_state AS related_reliability_state
            FROM paper_relationships
            JOIN papers ON papers.id = paper_relationships.source_paper_id
            WHERE paper_relationships.target_paper_id = ? AND paper_relationships.relation_type = ? AND papers.merged_into_paper_id IS NULL
            ORDER BY COALESCE(papers.published_at, printf('%04d-01-01', papers.year)) DESC, papers.title ASC
            """,
            (paper_id, GRAPH_RELATION_TYPE),
        ).fetchall()
        references = [self._relation_entry_from_row(paper_id, "references", row) for row in outgoing_rows]
        citations = [self._relation_entry_from_row(paper_id, "citations", row) for row in incoming_rows]
        summary = {
            "references": len(references),
            "citations": len(citations),
            "retrieved_references": sum(1 for item in references if item["edge"]["state"] == "retrieved"),
            "retrieved_citations": sum(1 for item in citations if item["edge"]["state"] == "retrieved"),
            "inferred_references": sum(1 for item in references if item["edge"]["state"] == "inferred"),
            "inferred_citations": sum(1 for item in citations if item["edge"]["state"] == "inferred"),
            "partial_references": sum(1 for item in references if item["edge"]["state"] == "partial"),
            "partial_citations": sum(1 for item in citations if item["edge"]["state"] == "partial"),
            "incomplete_references": sum(1 for item in references if item["edge"]["state"] == "incomplete"),
            "incomplete_citations": sum(1 for item in citations if item["edge"]["state"] == "incomplete"),
        }
        flattened = [
            {
                "relation_type": entry["relation_type"],
                "target_id": entry["paper"]["id"],
                "target_title": entry["paper"]["title"],
                "state": entry["edge"]["state"],
                "metadata": entry["edge"]["metadata"],
            }
            for entry in references + citations
        ]
        return {"references": references, "citations": citations, "summary": summary, "flattened": flattened}

    def get_paper(self, paper_id: int) -> Dict[str, Any]:
        with self._connect() as connection:
            row = connection.execute("SELECT * FROM papers WHERE id = ?", (paper_id,)).fetchone()
            if not row:
                raise ServiceError("Paper non trovato.", status=404)
            authors = connection.execute(
                """
                SELECT authors.*
                FROM paper_authors
                JOIN authors ON authors.id = paper_authors.author_id
                WHERE paper_authors.paper_id = ?
                ORDER BY paper_authors.author_position ASC
                """,
                (paper_id,),
            ).fetchall()
            notes = connection.execute(
                "SELECT * FROM notes WHERE target_type = 'paper' AND target_id = ? ORDER BY updated_at DESC",
                (paper_id,),
            ).fetchall()
            relations = self._paper_relations(connection, paper_id)
            topics = connection.execute(
                "SELECT topic, label, confidence FROM topic_assignments WHERE entity_type = 'paper' AND entity_id = ?",
                (paper_id,),
            ).fetchall()
            sources = connection.execute(
                "SELECT provider, provider_paper_id, source_url, is_primary, retrieved_at FROM paper_sources WHERE paper_id = ? ORDER BY is_primary DESC, provider ASC",
                (paper_id,),
            ).fetchall()
            latest_run = connection.execute(
                """
                SELECT id, operation, status, cache_hit, stats_json, degraded_json, started_at, completed_at
                FROM retrieval_runs
                WHERE paper_id = ?
                ORDER BY started_at DESC
                LIMIT 1
                """,
                (paper_id,),
            ).fetchone()
        paper = self._row_to_paper(row)
        paper["authors"] = [dict(author) for author in authors]
        paper["notes"] = [self._row_to_note(note) for note in notes]
        paper["relations"] = relations["flattened"]
        paper["graph"] = {
            "references": relations["references"],
            "citations": relations["citations"],
            "summary": relations["summary"],
        }
        paper["topics"] = [dict(topic) for topic in topics]
        paper["sources"] = [dict(source) for source in sources]
        paper["retrieval"] = (
            {
                **dict(latest_run),
                "stats": json_loads(latest_run["stats_json"], {}),
                "degraded": json_loads(latest_run["degraded_json"], []),
            }
            if latest_run
            else None
        )
        return paper

    def list_retrieval_runs(self, user_id: int, paper_id: Optional[int] = None) -> List[Dict[str, Any]]:
        with self._connect() as connection:
            if paper_id is not None:
                rows = connection.execute(
                    """
                    SELECT * FROM retrieval_runs
                    WHERE paper_id = ?
                    ORDER BY started_at DESC
                    LIMIT 50
                    """,
                    (paper_id,),
                ).fetchall()
            else:
                rows = connection.execute(
                    """
                    SELECT * FROM retrieval_runs
                    WHERE user_id = ?
                    ORDER BY started_at DESC
                    LIMIT 100
                    """,
                    (user_id,),
                ).fetchall()
        return [
            {
                **dict(row),
                "request": json_loads(row["request_json"], {}),
                "stats": json_loads(row["stats_json"], {}),
                "degraded": json_loads(row["degraded_json"], []),
            }
            for row in rows
        ]

    def refresh_paper_graph(
        self,
        user_id: int,
        paper_id: int,
        *,
        mode: str = "all",
        force_refresh: bool = True,
        rebuild: bool = True,
    ) -> Dict[str, Any]:
        paper = self.get_paper(paper_id)
        modes = self._graph_modes(mode)
        seed_record = {
            **paper.get("metadata", {}),
            "doi": paper.get("doi"),
            "title": paper.get("title"),
            "external_ids": paper.get("metadata", {}).get("external_ids", {}),
            "graph_hints": paper.get("metadata", {}).get("graph_hints", {}),
        }
        request_payload = {"paper_id": paper_id, "doi": paper.get("doi"), "force_refresh": force_refresh, "mode": modes, "rebuild": rebuild}
        run_id = self._start_retrieval_run(user_id, paper_id, "graph_refresh", request_payload)
        if not (seed_record.get("doi") or seed_record.get("graph_hints") or seed_record.get("external_ids")):
            self._finish_retrieval_run(run_id, status="failed", degraded=["Paper privo di DOI o identificatore provider sufficiente."], cache_hit=False, paper_id=paper_id)
            raise ServiceError("Il paper non ha un identificatore sufficiente per refresh del grafo.", status=422)
        relations = self._cached_provider_relations(seed_record, self._credential_states(user_id), force_refresh=force_refresh)
        with self._connect() as connection:
            mutations = self._ensure_relationship_graph(connection, paper_id, relations["relations"], modes=modes, rebuild=rebuild)
            connection.commit()
        refreshed = self.get_paper(paper_id)
        stats = {
            "mode": modes,
            "references": refreshed["graph"]["summary"]["references"],
            "citations": refreshed["graph"]["summary"]["citations"],
            "upserted_edges": mutations["upserted"],
            "pruned_edges": mutations["pruned"],
        }
        self._finish_retrieval_run(
            run_id,
            status="completed",
            stats=stats,
            degraded=relations["degraded"],
            cache_hit=relations.get("cache_hit", False),
            paper_id=paper_id,
        )
        self._audit(user_id, "paper_graph_refreshed", "paper", paper_id, "Grafo paper aggiornato dal backend.")
        return {
            "paper": self.get_paper(paper_id),
            "degraded": relations["degraded"],
            "cache_hit": relations.get("cache_hit", False),
            "mutations": mutations,
            "mode": modes,
        }

    def _neighbor_paper_ids(self, connection: sqlite3.Connection, paper_id: int, directions: Sequence[str]) -> List[int]:
        neighbors: List[int] = []
        if "references" in directions:
            rows = connection.execute(
                """
                SELECT target_paper_id
                FROM paper_relationships
                WHERE source_paper_id = ? AND relation_type = ?
                ORDER BY id ASC
                """,
                (paper_id, GRAPH_RELATION_TYPE),
            ).fetchall()
            neighbors.extend(row["target_paper_id"] for row in rows)
        if "citations" in directions:
            rows = connection.execute(
                """
                SELECT source_paper_id
                FROM paper_relationships
                WHERE target_paper_id = ? AND relation_type = ?
                ORDER BY id ASC
                """,
                (paper_id, GRAPH_RELATION_TYPE),
            ).fetchall()
            neighbors.extend(row["source_paper_id"] for row in rows)
        deduped: List[int] = []
        seen: set[int] = set()
        for item in neighbors:
            if item not in seen:
                seen.add(item)
                deduped.append(item)
        return deduped

    def expand_paper_graph(
        self,
        user_id: int,
        seed_paper_id: int,
        *,
        depth: int = 1,
        directions: Optional[Sequence[str]] = None,
        max_nodes: Optional[int] = None,
        force_refresh: bool = False,
        rebuild: bool = False,
    ) -> Dict[str, Any]:
        expansion_modes = list(dict.fromkeys(directions or ["references", "citations"]))
        for direction in expansion_modes:
            if direction not in GRAPH_MODES:
                raise ServiceError("Direzione di espansione non valida.", status=422)
        max_nodes = max_nodes or self.config.max_related_works
        visited = {seed_paper_id}
        frontier = [seed_paper_id]
        run_id = self._start_retrieval_run(
            user_id,
            seed_paper_id,
            "graph_expand",
            {
                "paper_id": seed_paper_id,
                "depth": depth,
                "directions": expansion_modes,
                "max_nodes": max_nodes,
                "force_refresh": force_refresh,
                "rebuild": rebuild,
            },
        )
        degraded: List[str] = []
        expanded = 0
        levels: List[Dict[str, Any]] = []
        for level in range(depth):
            next_frontier: List[int] = []
            for paper_id in frontier:
                result = self.refresh_paper_graph(
                    user_id,
                    paper_id,
                    mode="all" if len(expansion_modes) == 2 else expansion_modes[0],
                    force_refresh=force_refresh,
                    rebuild=rebuild,
                )
                degraded.extend(result["degraded"])
                expanded += 1
                with self._connect() as connection:
                    for related_id in self._neighbor_paper_ids(connection, paper_id, expansion_modes):
                        if related_id not in visited:
                            visited.add(related_id)
                            next_frontier.append(related_id)
                        if len(visited) >= max_nodes:
                            break
                if len(visited) >= max_nodes:
                    degraded.append("Espansione troncata al limite massimo di nodi configurato.")
                    break
            levels.append({"depth": level + 1, "frontier_size": len(frontier), "discovered": len(next_frontier)})
            frontier = next_frontier
            if not frontier or len(visited) >= max_nodes:
                break
        self._finish_retrieval_run(
            run_id,
            status="completed",
            stats={"expanded_nodes": expanded, "reachable_papers": len(visited), "levels": levels},
            degraded=degraded,
            cache_hit=not force_refresh,
            paper_id=seed_paper_id,
        )
        return {
            "graph": self.get_graph(user_id, [seed_paper_id], depth=max(depth, 1), limit=max_nodes),
            "expanded_nodes": expanded,
            "reachable_papers": len(visited),
            "levels": levels,
            "degraded": degraded,
        }

    def refresh_collection_graph(
        self,
        user_id: int,
        collection_id: int,
        *,
        mode: str = "all",
        force_refresh: bool = True,
        rebuild: bool = True,
    ) -> Dict[str, Any]:
        collection = self.get_collection(user_id, collection_id)
        modes = self._graph_modes(mode)
        run_id = self._start_retrieval_run(
            user_id,
            None,
            "collection_graph_refresh",
            {"collection_id": collection_id, "mode": modes, "force_refresh": force_refresh, "rebuild": rebuild},
        )
        refreshed = 0
        degraded: List[str] = []
        skipped: List[int] = []
        for paper in collection["papers"]:
            if not paper.get("doi") and not paper.get("metadata", {}).get("graph_hints"):
                skipped.append(paper["id"])
                continue
            result = self.refresh_paper_graph(user_id, paper["id"], mode=mode, force_refresh=force_refresh, rebuild=rebuild)
            refreshed += 1
            degraded.extend(result["degraded"])
        stats = {"collection_id": collection_id, "refreshed_papers": refreshed, "skipped_papers": skipped, "mode": modes}
        self._finish_retrieval_run(run_id, status="completed", stats=stats, degraded=degraded, cache_hit=not force_refresh)
        self._audit(user_id, "collection_graph_refreshed", "collection", collection_id, "Grafo collezione aggiornato dal backend.")
        return {"collection": self.get_collection(user_id, collection_id), "stats": stats, "degraded": list(dict.fromkeys(degraded))}

    def search_papers(self, user_id: int, query: str, filters: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        filters = filters or {}
        query_norm = normalize_text(query)
        local_results: List[Dict[str, Any]] = []
        with self._connect() as connection:
            rows = connection.execute("SELECT * FROM papers WHERE merged_into_paper_id IS NULL ORDER BY year DESC, title ASC").fetchall()
            for row in rows:
                paper = self._row_to_paper(row)
                searchable = " ".join(
                    [
                        paper["title"] or "",
                        paper.get("abstract") or "",
                        paper.get("venue") or "",
                        paper.get("doi") or "",
                        " ".join(paper["metadata"].get("keywords", [])),
                        " ".join(paper["metadata"].get("topics", [])),
                    ]
                )
                if query_norm and query_norm not in normalize_text(searchable):
                    continue
                if filters.get("collection_id"):
                    exists = connection.execute(
                        "SELECT 1 FROM collection_papers WHERE collection_id = ? AND paper_id = ?",
                        (filters["collection_id"], row["id"]),
                    ).fetchone()
                    if not exists:
                        continue
                if filters.get("status"):
                    state = connection.execute(
                        """
                        SELECT 1 FROM user_paper_state
                        WHERE user_id = ? AND paper_id = ? AND status = ?
                        """,
                        (user_id, row["id"], filters["status"]),
                    ).fetchone()
                    if not state:
                        continue
                local_results.append(paper)
        external = self._cached_provider_search(query, self._credential_states(user_id))
        collection_presence = defaultdict(list)
        with self._connect() as connection:
            memberships = connection.execute(
                """
                SELECT collection_papers.paper_id, collections.name
                FROM collection_papers
                JOIN collections ON collections.id = collection_papers.collection_id
                LEFT JOIN collection_members ON collection_members.collection_id = collections.id
                WHERE collections.owner_id = ? OR collection_members.user_id = ?
                """,
                (user_id, user_id),
            ).fetchall()
        for row in memberships:
            collection_presence[row["paper_id"]].append(row["name"])
        for paper in local_results:
            paper["known_in_collections"] = collection_presence.get(paper["id"], [])
        return {"results": local_results, "external_results": external["results"], "degraded": external["degraded"]}

    def set_paper_state(self, user_id: int, paper_id: int, payload: Dict[str, Any]) -> Dict[str, Any]:
        status = payload.get("status", "salvato")
        if status not in VALID_STATES:
            raise ServiceError("Stato non valido.", status=422)
        collection_id = payload.get("collection_id")
        if collection_id:
            self._require_collection_access(user_id, collection_id, minimum_role="viewer")
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO user_paper_state (
                    user_id, paper_id, collection_id, status, tags_json, is_important, is_favorite,
                    is_hidden, is_excluded, is_ignored, last_action_at, source
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (user_id, paper_id, collection_id) DO UPDATE SET
                    status = excluded.status,
                    tags_json = excluded.tags_json,
                    is_important = excluded.is_important,
                    is_favorite = excluded.is_favorite,
                    is_hidden = excluded.is_hidden,
                    is_excluded = excluded.is_excluded,
                    is_ignored = excluded.is_ignored,
                    last_action_at = excluded.last_action_at,
                    source = excluded.source
                """,
                (
                    user_id,
                    paper_id,
                    collection_id,
                    status,
                    json_dumps(payload.get("tags", [])),
                    int(bool(payload.get("is_important"))),
                    int(bool(payload.get("is_favorite"))),
                    int(bool(payload.get("is_hidden"))),
                    int(bool(payload.get("is_excluded") or status == "escluso")),
                    int(bool(payload.get("is_ignored") or status == "ignorato")),
                    utcnow(),
                    payload.get("source", "manual"),
                ),
            )
            if payload.get("feedback_type"):
                connection.execute(
                    """
                    INSERT INTO feedback (user_id, target_type, target_id, feedback_type, details_json, created_at)
                    VALUES (?, 'paper', ?, ?, ?, ?)
                    """,
                    (user_id, paper_id, payload["feedback_type"], json_dumps(payload), utcnow()),
                )
        self._audit(user_id, "paper_state_changed", "paper", paper_id, f"Stato paper aggiornato a {status}.")
        return {"paper_id": paper_id, "status": status, "collection_id": collection_id}

    def add_note(self, user_id: int, payload: Dict[str, Any]) -> Dict[str, Any]:
        target_type = payload["target_type"]
        target_id = int(payload["target_id"])
        collection_id = payload.get("collection_id")
        if collection_id:
            self._require_collection_access(user_id, collection_id, minimum_role="viewer")
        with self._connect() as connection:
            cursor = connection.execute(
                """
                INSERT INTO notes (target_type, target_id, collection_id, author_user_id, visibility, body, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    target_type,
                    target_id,
                    collection_id,
                    user_id,
                    payload.get("visibility", "private"),
                    payload["body"],
                    utcnow(),
                    utcnow(),
                ),
            )
            note_id = cursor.lastrowid
            connection.execute(
                """
                INSERT INTO note_history (note_id, version, body, edited_at, edited_by_user_id)
                VALUES (?, 1, ?, ?, ?)
                """,
                (note_id, payload["body"], utcnow(), user_id),
            )
        self._audit(user_id, "note_added", target_type, target_id, "Nota aggiunta.")
        return self.get_note(note_id)

    def get_note(self, note_id: int) -> Dict[str, Any]:
        with self._connect() as connection:
            row = connection.execute("SELECT * FROM notes WHERE id = ?", (note_id,)).fetchone()
            if not row:
                raise ServiceError("Nota non trovata.", status=404)
            history = connection.execute(
                "SELECT * FROM note_history WHERE note_id = ? ORDER BY version DESC",
                (note_id,),
            ).fetchall()
        note = self._row_to_note(row)
        note["history"] = [dict(item) for item in history]
        return note

    def update_note(self, user_id: int, note_id: int, body: str) -> Dict[str, Any]:
        with self._connect() as connection:
            row = connection.execute("SELECT * FROM notes WHERE id = ?", (note_id,)).fetchone()
            if not row:
                raise ServiceError("Nota non trovata.", status=404)
            if row["author_user_id"] != user_id:
                raise ServiceError("Solo l'autore puo modificare la nota.", status=403)
            version = row["version"] + 1
            connection.execute(
                "UPDATE notes SET body = ?, version = ?, updated_at = ? WHERE id = ?",
                (body, version, utcnow(), note_id),
            )
            connection.execute(
                """
                INSERT INTO note_history (note_id, version, body, edited_at, edited_by_user_id)
                VALUES (?, ?, ?, ?, ?)
                """,
                (note_id, version, body, utcnow(), user_id),
            )
        self._audit(user_id, "note_updated", row["target_type"], row["target_id"], "Nota aggiornata.")
        return self.get_note(note_id)

    def search_notes(self, user_id: int, query: str) -> List[Dict[str, Any]]:
        query_norm = normalize_text(query)
        rows: List[Dict[str, Any]] = []
        with self._connect() as connection:
            for row in connection.execute("SELECT * FROM notes ORDER BY updated_at DESC").fetchall():
                if query_norm not in normalize_text(row["body"]):
                    continue
                if row["visibility"] == "private" and row["author_user_id"] != user_id:
                    continue
                rows.append(self._row_to_note(row))
        return rows

    def search_authors(self, query: str) -> List[Dict[str, Any]]:
        query_norm = normalize_text(query)
        with self._connect() as connection:
            rows = connection.execute("SELECT * FROM authors ORDER BY canonical_name ASC").fetchall()
        result = []
        for row in rows:
            aliases = json_loads(row["aliases_json"], [])
            haystack = " ".join([row["canonical_name"]] + aliases)
            if query_norm and query_norm not in normalize_text(haystack):
                continue
            result.append(
                {
                    "id": row["id"],
                    "canonical_name": row["canonical_name"],
                    "aliases": aliases,
                    "topics": json_loads(row["topics_json"], []),
                    "affiliations": json_loads(row["affiliations_json"], []),
                }
            )
        return result

    def get_author(self, author_id: int) -> Dict[str, Any]:
        with self._connect() as connection:
            author = connection.execute("SELECT * FROM authors WHERE id = ?", (author_id,)).fetchone()
            if not author:
                raise ServiceError("Autore non trovato.", status=404)
            papers = connection.execute(
                """
                SELECT papers.*
                FROM paper_authors
                JOIN papers ON papers.id = paper_authors.paper_id
                WHERE paper_authors.author_id = ?
                ORDER BY papers.year DESC, papers.title ASC
                """,
                (author_id,),
            ).fetchall()
            coauthors = connection.execute(
                """
                SELECT DISTINCT coauthors.id, coauthors.canonical_name
                FROM paper_authors pa1
                JOIN paper_authors pa2 ON pa1.paper_id = pa2.paper_id AND pa2.author_id != pa1.author_id
                JOIN authors coauthors ON coauthors.id = pa2.author_id
                WHERE pa1.author_id = ?
                ORDER BY coauthors.canonical_name ASC
                """,
                (author_id,),
            ).fetchall()
            notes = connection.execute(
                "SELECT * FROM notes WHERE target_type = 'author' AND target_id = ? ORDER BY updated_at DESC",
                (author_id,),
            ).fetchall()
        return {
            "id": author["id"],
            "canonical_name": author["canonical_name"],
            "aliases": json_loads(author["aliases_json"], []),
            "topics": json_loads(author["topics_json"], []),
            "affiliations": json_loads(author["affiliations_json"], []),
            "papers": [self._row_to_paper(paper) for paper in papers],
            "coauthors": [dict(item) for item in coauthors],
            "notes": [self._row_to_note(note) for note in notes],
        }

    def follow_entity(self, user_id: int, entity_type: str, entity_id: int) -> Dict[str, Any]:
        with self._connect() as connection:
            connection.execute(
                """
                INSERT OR IGNORE INTO followed_entities (user_id, entity_type, entity_id, created_at)
                VALUES (?, ?, ?, ?)
                """,
                (user_id, entity_type, entity_id, utcnow()),
            )
        self._audit(user_id, "entity_followed", entity_type, entity_id, f"Seguito {entity_type} {entity_id}.")
        return {"entity_type": entity_type, "entity_id": entity_id}

    def unfollow_entity(self, user_id: int, entity_type: str, entity_id: int) -> None:
        with self._connect() as connection:
            connection.execute(
                "DELETE FROM followed_entities WHERE user_id = ? AND entity_type = ? AND entity_id = ?",
                (user_id, entity_type, entity_id),
            )
        self._audit(user_id, "entity_unfollowed", entity_type, entity_id, f"Non segue piu {entity_type} {entity_id}.")

    def merge_papers(self, user_id: int, winner_id: int, loser_id: int, reason: str = "") -> Dict[str, Any]:
        with self._connect() as connection:
            winner = connection.execute("SELECT * FROM papers WHERE id = ?", (winner_id,)).fetchone()
            loser = connection.execute("SELECT * FROM papers WHERE id = ?", (loser_id,)).fetchone()
            if not winner or not loser:
                raise ServiceError("Paper non trovato.", status=404)
            if winner_id == loser_id:
                raise ServiceError("I paper devono essere distinti.", status=422)
            winner_meta = json_loads(winner["metadata_json"], {})
            loser_meta = json_loads(loser["metadata_json"], {})
            merged_meta = {**loser_meta, **winner_meta}
            if not winner["doi"] and loser["doi"]:
                connection.execute("UPDATE papers SET doi = ? WHERE id = ?", (loser["doi"], winner_id))
            connection.execute(
                """
                UPDATE papers
                SET metadata_json = ?, quality_state = ?, reliability_state = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    json_dumps(merged_meta),
                    self._classify_quality(merged_meta)[0],
                    self._classify_quality(merged_meta)[1],
                    utcnow(),
                    winner_id,
                ),
            )
            for table, foreign_key in (
                ("collection_papers", "paper_id"),
                ("user_paper_state", "paper_id"),
            ):
                connection.execute(
                    f"UPDATE OR IGNORE {table} SET {foreign_key} = ? WHERE {foreign_key} = ?",
                    (winner_id, loser_id),
                )
            connection.execute(
                "UPDATE notes SET target_id = ? WHERE target_type = 'paper' AND target_id = ?",
                (winner_id, loser_id),
            )
            connection.execute(
                "UPDATE feedback SET target_id = ? WHERE target_type = 'paper' AND target_id = ?",
                (winner_id, loser_id),
            )
            connection.execute(
                "UPDATE topic_assignments SET entity_id = ? WHERE entity_type = 'paper' AND entity_id = ?",
                (winner_id, loser_id),
            )
            connection.execute(
                "UPDATE paper_relationships SET source_paper_id = ? WHERE source_paper_id = ?",
                (winner_id, loser_id),
            )
            connection.execute(
                "UPDATE paper_relationships SET target_paper_id = ? WHERE target_paper_id = ?",
                (winner_id, loser_id),
            )
            connection.execute(
                "UPDATE papers SET merged_into_paper_id = ?, updated_at = ? WHERE id = ?",
                (winner_id, utcnow(), loser_id),
            )
            connection.execute(
                """
                INSERT INTO merge_events (winner_paper_id, loser_paper_id, reason, is_automatic, created_at)
                VALUES (?, ?, ?, 0, ?)
                """,
                (winner_id, loser_id, reason, utcnow()),
            )
        self._audit(user_id, "paper_merged", "paper", winner_id, f"Merge completato con record {loser_id}.")
        return self.get_paper(winner_id)

    def get_graph(self, user_id: int, seed_paper_ids: Sequence[int], depth: int = 1, limit: int = 50) -> Dict[str, Any]:
        nodes: Dict[str, Dict[str, Any]] = {}
        edges: List[Dict[str, Any]] = []
        seen_edges: set[Tuple[str, str, str]] = set()
        frontier = list(seed_paper_ids)
        seen = set(frontier)
        with self._connect() as connection:
            for paper_id in seed_paper_ids:
                paper = connection.execute("SELECT * FROM papers WHERE id = ?", (paper_id,)).fetchone()
                if paper:
                    nodes[f"paper:{paper_id}"] = {"id": f"paper:{paper_id}", "type": "paper", "label": paper["title"]}
            for _level in range(depth):
                next_frontier: List[int] = []
                for paper_id in frontier:
                    relations = connection.execute(
                        """
                        SELECT * FROM paper_relationships
                        WHERE (source_paper_id = ? OR target_paper_id = ?) AND relation_type = ?
                        LIMIT ?
                        """,
                        (paper_id, paper_id, GRAPH_RELATION_TYPE, limit),
                    ).fetchall()
                    for relation in relations:
                        source_id = relation["source_paper_id"]
                        target_id = relation["target_paper_id"]
                        metadata = json_loads(relation["metadata_json"], {})
                        for target in (source_id, target_id):
                            if target not in seen and len(nodes) < limit:
                                row = connection.execute("SELECT * FROM papers WHERE id = ?", (target,)).fetchone()
                                if row:
                                    nodes[f"paper:{target}"] = {"id": f"paper:{target}", "type": "paper", "label": row["title"]}
                                    seen.add(target)
                                    next_frontier.append(target)
                        if len(edges) < limit:
                            edge_key = (f"paper:{source_id}", f"paper:{target_id}", GRAPH_RELATION_TYPE)
                            if edge_key not in seen_edges:
                                seen_edges.add(edge_key)
                                edges.append(
                                    {
                                        "source": f"paper:{source_id}",
                                        "target": f"paper:{target_id}",
                                        "type": GRAPH_RELATION_TYPE,
                                        "explanation": relation["explanation"],
                                        "state": metadata.get("aggregate_state", "unknown"),
                                        "providers": metadata.get("source_providers", []),
                                    }
                                )
                    author_rows = connection.execute(
                        """
                        SELECT authors.id, authors.canonical_name
                        FROM paper_authors
                        JOIN authors ON authors.id = paper_authors.author_id
                        WHERE paper_authors.paper_id = ?
                        """,
                        (paper_id,),
                    ).fetchall()
                    for author in author_rows:
                        nodes[f"author:{author['id']}"] = {"id": f"author:{author['id']}", "type": "author", "label": author["canonical_name"]}
                        edge_key = (f"author:{author['id']}", f"paper:{paper_id}", "authored")
                        if edge_key not in seen_edges and len(edges) < limit:
                            seen_edges.add(edge_key)
                            edges.append({"source": f"author:{author['id']}", "target": f"paper:{paper_id}", "type": "authored"})
                    topic_rows = connection.execute(
                        "SELECT topic FROM topic_assignments WHERE entity_type = 'paper' AND entity_id = ?",
                        (paper_id,),
                    ).fetchall()
                    for topic in topic_rows:
                        topic_id = normalize_text(topic["topic"])
                        nodes[f"topic:{topic_id}"] = {"id": f"topic:{topic_id}", "type": "topic", "label": topic["topic"]}
                        edge_key = (f"paper:{paper_id}", f"topic:{topic_id}", "topic")
                        if edge_key not in seen_edges and len(edges) < limit:
                            seen_edges.add(edge_key)
                            edges.append({"source": f"paper:{paper_id}", "target": f"topic:{topic_id}", "type": "topic"})
                frontier = next_frontier
                if not frontier or len(nodes) >= limit:
                    break
        degraded = []
        if len(nodes) >= limit:
            degraded.append("Grafo limitato per densita eccessiva.")
        return {"nodes": list(nodes.values()), "edges": edges[:limit], "degraded": degraded}

    def timeline(self, user_id: int, *, collection_id: Optional[int] = None, topic: Optional[str] = None, seed_paper_id: Optional[int] = None) -> Dict[str, Any]:
        papers: List[Dict[str, Any]] = []
        with self._connect() as connection:
            if collection_id:
                self._require_collection_access(user_id, collection_id)
                rows = connection.execute(
                    """
                    SELECT papers.*
                    FROM collection_papers
                    JOIN papers ON papers.id = collection_papers.paper_id
                    WHERE collection_papers.collection_id = ?
                    ORDER BY COALESCE(papers.published_at, printf('%04d-01-01', papers.year)) ASC
                    """,
                    (collection_id,),
                ).fetchall()
            elif topic:
                rows = connection.execute(
                    """
                    SELECT papers.*
                    FROM topic_assignments
                    JOIN papers ON papers.id = topic_assignments.entity_id
                    WHERE topic_assignments.entity_type = 'paper' AND topic_assignments.topic = ?
                    ORDER BY COALESCE(papers.published_at, printf('%04d-01-01', papers.year)) ASC
                    """,
                    (topic,),
                ).fetchall()
            elif seed_paper_id:
                graph = self.get_graph(user_id, [seed_paper_id], depth=2, limit=100)
                paper_ids = [int(node["id"].split(":")[1]) for node in graph["nodes"] if node["type"] == "paper"]
                placeholders = ",".join("?" for _ in paper_ids) or "0"
                rows = connection.execute(
                    f"SELECT * FROM papers WHERE id IN ({placeholders}) ORDER BY COALESCE(published_at, printf('%04d-01-01', year)) ASC",
                    tuple(paper_ids),
                ).fetchall()
            else:
                rows = []
        for row in rows:
            paper = self._row_to_paper(row)
            papers.append(paper)
        years = [paper["year"] for paper in papers if paper.get("year")]
        counts = Counter(years)
        growth = [{"year": year, "count": counts[year]} for year in sorted(counts)]
        for index, paper in enumerate(papers):
            if index == 0:
                paper["phase"] = "originario"
            elif index == len(papers) - 1:
                paper["phase"] = "recente"
            else:
                paper["phase"] = "intermedio"
        return {"items": papers, "growth": growth}

    def recommend(
        self,
        user_id: int,
        *,
        collection_id: Optional[int] = None,
        seed_paper_ids: Optional[Sequence[int]] = None,
    ) -> Dict[str, Any]:
        seen_papers: set[int] = set(seed_paper_ids or [])
        candidate_scores: Dict[int, float] = defaultdict(float)
        explanations: Dict[int, List[str]] = defaultdict(list)
        excluded_ids: set[int] = set()
        followed_authors: set[int] = set()
        followed_topics: set[str] = set()
        with self._connect() as connection:
            if collection_id:
                self._require_collection_access(user_id, collection_id)
                rows = connection.execute("SELECT paper_id FROM collection_papers WHERE collection_id = ?", (collection_id,)).fetchall()
                seen_papers.update(row["paper_id"] for row in rows)
            feedback_rows = connection.execute(
                """
                SELECT target_id, feedback_type FROM feedback
                WHERE user_id = ? AND target_type = 'paper'
                """,
                (user_id,),
            ).fetchall()
            for row in feedback_rows:
                if row["feedback_type"] in {"escluso", "non_rilevante", "nascondi", "ignorato"}:
                    excluded_ids.add(row["target_id"])
            state_rows = connection.execute(
                """
                SELECT paper_id, status, is_excluded, is_ignored
                FROM user_paper_state WHERE user_id = ?
                """,
                (user_id,),
            ).fetchall()
            for row in state_rows:
                if row["status"] in {"escluso", "ignorato"} or row["is_excluded"] or row["is_ignored"]:
                    excluded_ids.add(row["paper_id"])
            follow_rows = connection.execute("SELECT entity_type, entity_id FROM followed_entities WHERE user_id = ?", (user_id,)).fetchall()
            for row in follow_rows:
                if row["entity_type"] == "author":
                    followed_authors.add(row["entity_id"])
                elif row["entity_type"] == "topic":
                    topic_row = connection.execute("SELECT topic FROM topic_assignments WHERE id = ?", (row["entity_id"],)).fetchone()
                    if topic_row:
                        followed_topics.add(topic_row["topic"])
            for seed_id in seen_papers:
                relations = connection.execute(
                    """
                    SELECT target_paper_id FROM paper_relationships
                    WHERE source_paper_id = ? AND relation_type = ?
                    """,
                    (seed_id, GRAPH_RELATION_TYPE),
                ).fetchall()
                for relation in relations:
                    if relation["target_paper_id"] in seen_papers:
                        continue
                    candidate_scores[relation["target_paper_id"]] += 2.0
                    explanations[relation["target_paper_id"]].append("Collegato ai seed tramite references persistite nel grafo.")
                incoming_relations = connection.execute(
                    """
                    SELECT source_paper_id FROM paper_relationships
                    WHERE target_paper_id = ? AND relation_type = ?
                    """,
                    (seed_id, GRAPH_RELATION_TYPE),
                ).fetchall()
                for relation in incoming_relations:
                    if relation["source_paper_id"] in seen_papers:
                        continue
                    candidate_scores[relation["source_paper_id"]] += 2.5
                    explanations[relation["source_paper_id"]].append("Collegato ai seed tramite citations persistite nel grafo.")
                topic_rows = connection.execute(
                    """
                    SELECT topic FROM topic_assignments WHERE entity_type = 'paper' AND entity_id = ?
                    """,
                    (seed_id,),
                ).fetchall()
                for topic_row in topic_rows:
                    related = connection.execute(
                        """
                        SELECT entity_id FROM topic_assignments
                        WHERE entity_type = 'paper' AND topic = ?
                        """,
                        (topic_row["topic"],),
                    ).fetchall()
                    for related_row in related:
                        if related_row["entity_id"] not in seen_papers:
                            candidate_scores[related_row["entity_id"]] += 1.5
                            explanations[related_row["entity_id"]].append(f"Condivide il topic {topic_row['topic']}.")
            for author_id in followed_authors:
                papers = connection.execute("SELECT paper_id FROM paper_authors WHERE author_id = ?", (author_id,)).fetchall()
                for row in papers:
                    candidate_scores[row["paper_id"]] += 1.0
                    explanations[row["paper_id"]].append("Paper di un autore seguito.")
            if not candidate_scores:
                rows = connection.execute(
                    "SELECT id FROM papers WHERE merged_into_paper_id IS NULL ORDER BY year DESC, title ASC LIMIT 5"
                ).fetchall()
                for row in rows:
                    candidate_scores[row["id"]] += 0.5
                    explanations[row["id"]].append("Suggerimento cold start basato sui record recenti disponibili.")
            results = []
            for paper_id, score in sorted(candidate_scores.items(), key=lambda item: item[1], reverse=True):
                if paper_id in excluded_ids:
                    continue
                paper = self.get_paper(paper_id)
                if paper["quality_state"] in {"ambiguo", "manuale"}:
                    score -= 0.5
                    explanations[paper_id].append("Record penalizzato per qualita o affidabilita ridotta.")
                results.append(
                    {
                        "paper": paper,
                        "score": round(score, 2),
                        "explanation": " ".join(dict.fromkeys(explanations[paper_id])),
                    }
                )
        return {"results": results[:10], "degraded": []}

    def get_feed(self, user_id: int) -> List[Dict[str, Any]]:
        with self._connect() as connection:
            collections = connection.execute(
                """
                SELECT collections.id
                FROM collections
                LEFT JOIN collection_members ON collection_members.collection_id = collections.id
                WHERE collections.owner_id = ? OR collection_members.user_id = ?
                ORDER BY collections.updated_at DESC
                LIMIT 3
                """,
                (user_id, user_id),
            ).fetchall()
        items = []
        for row in collections:
            recommendations = self.recommend(user_id, collection_id=row["id"])["results"][:3]
            for recommendation in recommendations:
                items.append(
                    {
                        "kind": "collection_update",
                        "collection_id": row["id"],
                        "paper_id": recommendation["paper"]["id"],
                        "title": recommendation["paper"]["title"],
                        "explanation": recommendation["explanation"],
                    }
                )
        return items[:10]

    def list_notifications(self, user_id: int) -> List[Dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute("SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 20", (user_id,)).fetchall()
        return [dict(row) for row in rows]

    def _notify(self, user_id: int, kind: str, title: str, message: str, payload: Optional[Dict[str, Any]] = None) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO notifications (user_id, kind, title, message, payload_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (user_id, kind, title, message, json_dumps(payload or {}), utcnow()),
            )

    def invite_collaborator(self, user_id: int, collection_id: int, email: str, role: str) -> Dict[str, Any]:
        self._require_collection_access(user_id, collection_id, minimum_role="owner")
        if role not in {"viewer", "editor"}:
            raise ServiceError("Ruolo non valido.", status=422)
        now = utcnow()
        notified_user_id: Optional[int] = None
        with self._connect() as connection:
            user = connection.execute("SELECT id FROM users WHERE email = ? AND deleted_at IS NULL", (email.lower(),)).fetchone()
            invite_cursor = connection.execute(
                """
                INSERT INTO shared_invites (collection_id, email, role, status, created_at)
                VALUES (?, ?, ?, 'pending', ?)
                """,
                (collection_id, email.lower(), role, now),
            )
            if user:
                connection.execute(
                    """
                    INSERT OR REPLACE INTO collection_members (collection_id, user_id, role, created_at)
                    VALUES (?, ?, ?, ?)
                    """,
                    (collection_id, user["id"], role, now),
                )
                connection.execute(
                    "UPDATE shared_invites SET status = 'accepted', responded_at = ? WHERE id = ?",
                    (now, invite_cursor.lastrowid),
                )
                notified_user_id = user["id"]
        if notified_user_id:
            self._notify(
                notified_user_id,
                "shared_collection",
                "Nuova collezione condivisa",
                f"Sei stato aggiunto alla collezione {collection_id}.",
                {"collection_id": collection_id},
            )
        self._audit(user_id, "collaborator_invited", "collection", collection_id, f"Invitato {email} come {role}.")
        return {"collection_id": collection_id, "email": email, "role": role}

    def revoke_collaborator(self, user_id: int, collection_id: int, collaborator_user_id: int) -> None:
        self._require_collection_access(user_id, collection_id, minimum_role="owner")
        with self._connect() as connection:
            connection.execute(
                "DELETE FROM collection_members WHERE collection_id = ? AND user_id = ?",
                (collection_id, collaborator_user_id),
            )
        self._audit(user_id, "collaborator_revoked", "collection", collection_id, f"Revocato accesso a utente {collaborator_user_id}.")

    def _parse_bibtex(self, content: str) -> List[Dict[str, Any]]:
        records: List[Dict[str, Any]] = []
        current: Dict[str, Any] = {}
        for line in content.splitlines():
            stripped = line.strip()
            if stripped.startswith("@"):
                if current:
                    records.append(current)
                    current = {}
                current["manual"] = True
                continue
            if "=" in stripped:
                key, value = stripped.split("=", 1)
                current[key.strip().lower()] = value.strip().strip(",{}\" ")
        if current:
            records.append(current)
        for record in records:
            record["title"] = record.get("title")
            record["doi"] = record.get("doi")
            record["authors"] = parse_authors(record.get("author"))
            record["year"] = int(record["year"]) if str(record.get("year", "")).isdigit() else None
            record["venue"] = record.get("journal") or record.get("booktitle")
        return records

    def import_records(self, user_id: int, payload: Dict[str, Any]) -> Dict[str, Any]:
        source_type = payload.get("source_type", "identifiers")
        preview = bool(payload.get("preview"))
        content = payload.get("content", "")
        corrections = payload.get("corrections", {})
        collection_id = payload.get("collection_id")
        if collection_id:
            self._require_collection_access(user_id, collection_id, minimum_role="editor")
        items: List[Dict[str, Any]] = []
        if source_type in {"identifiers", "titles", "urls"}:
            lines = [line.strip() for line in str(content).splitlines() if line.strip()]
            for line in lines:
                items.append({"identifier_type": {"identifiers": "doi", "titles": "title", "urls": "url"}[source_type], "value": line})
        elif source_type == "json":
            records = json.loads(content or "[]")
            for record in records:
                items.append({"identifier_type": "manual", "metadata": {**record, **corrections.get(record.get("title", ""), {})}})
        elif source_type == "bibtex":
            for record in self._parse_bibtex(content):
                items.append({"identifier_type": "manual", "metadata": record})
        else:
            raise ServiceError("Formato import non supportato.", status=422)
        if preview:
            preview_items = []
            with self._connect() as connection:
                for item in items:
                    metadata = item.get("metadata") or {"doi": item.get("value") if item["identifier_type"] == "doi" else None, "title": item.get("value") if item["identifier_type"] == "title" else None}
                    existing = self._find_existing_paper(connection, metadata)
                    preview_items.append({"raw": item, "duplicate": bool(existing), "existing_paper_id": existing["id"] if existing else None})
            return {"preview": preview_items}
        now = utcnow()
        with self._connect() as connection:
            import_cursor = connection.execute(
                "INSERT INTO imports (user_id, source_type, status, summary_json, created_at, updated_at) VALUES (?, ?, 'running', '{}', ?, ?)",
                (user_id, source_type, now, now),
            )
            import_id = import_cursor.lastrowid
        summary = {"success": 0, "duplicates": 0, "failed": 0, "skipped": 0}
        for item in items:
            try:
                result = self.add_paper(
                    user_id,
                    identifier_type=item["identifier_type"],
                    value=item.get("value"),
                    collection_id=collection_id,
                    metadata=item.get("metadata"),
                )
                summary["success"] += 1
                status = "success"
                message = ", ".join(result.get("degraded", []))
                entity_id = result["paper"]["id"]
            except ServiceError as error:
                summary["failed"] += 1
                status = "failed"
                message = error.message
                entity_id = None
            with self._connect() as connection:
                connection.execute(
                    """
                    INSERT INTO import_items (import_id, raw_identifier, status, message, entity_type, entity_id, created_at)
                    VALUES (?, ?, ?, ?, 'paper', ?, ?)
                    """,
                    (import_id, item.get("value") or item.get("metadata", {}).get("title", "record"), status, message, entity_id, utcnow()),
                )
        with self._connect() as connection:
            connection.execute(
                "UPDATE imports SET status = 'completed', summary_json = ?, updated_at = ? WHERE id = ?",
                (json_dumps(summary), utcnow(), import_id),
            )
        self._notify(user_id, "import", "Import completato", "L'importazione e stata completata.", {"import_id": import_id, "summary": summary})
        self._audit(user_id, "import_completed", "import", import_id, "Import completato.", details=summary)
        return {"import_id": import_id, "summary": summary}

    def export_collection(self, user_id: int, collection_id: int, export_format: str = "json", include_notes: bool = True, include_states: bool = True) -> Dict[str, Any]:
        collection = self.get_collection(user_id, collection_id)
        payload = {
            "collection": {key: collection[key] for key in ("id", "name", "description", "visibility", "tags")},
            "papers": collection["papers"],
        }
        if include_notes:
            payload["notes"] = collection["notes"]
        if include_states:
            with self._connect() as connection:
                rows = connection.execute(
                    """
                    SELECT * FROM user_paper_state
                    WHERE user_id = ? AND collection_id = ?
                    """,
                    (user_id, collection_id),
                ).fetchall()
            payload["states"] = [dict(row) for row in rows]
        if export_format == "json" or export_format == "backup":
            content = json_dumps(payload)
        elif export_format == "bibtex":
            entries = []
            for paper in collection["papers"]:
                author_string = " and ".join(author["canonical_name"] for author in paper.get("authors", [])) if paper.get("authors") else "Unknown"
                entries.append(
                    "\n".join(
                        [
                            f"@article{{paper{paper['id']},",
                            f"  title = {{{paper['title']}}},",
                            f"  author = {{{author_string}}},",
                            f"  year = {{{paper.get('year') or ''}}},",
                            f"  doi = {{{paper.get('doi') or ''}}},",
                            f"  journal = {{{paper.get('venue') or ''}}},",
                            "}",
                        ]
                    )
                )
            content = "\n\n".join(entries)
        else:
            raise ServiceError("Formato export non supportato.", status=422)
        self._audit(user_id, "collection_exported", "collection", collection_id, f"Collezione esportata in formato {export_format}.")
        return {"format": export_format, "content": content}

    def link_library(self, user_id: int, payload: Dict[str, Any]) -> Dict[str, Any]:
        now = utcnow()
        with self._connect() as connection:
            cursor = connection.execute(
                """
                INSERT INTO linked_libraries (user_id, provider, external_library_id, name, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (user_id, provider, external_library_id) DO UPDATE SET
                    name = excluded.name,
                    status = excluded.status,
                    updated_at = excluded.updated_at
                """,
                (
                    user_id,
                    payload["provider"],
                    payload["external_library_id"],
                    payload.get("name", "Connected library"),
                    payload.get("status", "connected"),
                    now,
                    now,
                ),
            )
        library_id = cursor.lastrowid or self._get_linked_library_id(user_id, payload["provider"], payload["external_library_id"])
        self._audit(user_id, "library_linked", "library", library_id, "Libreria esterna collegata.")
        return {"library_id": library_id}

    def _get_linked_library_id(self, user_id: int, provider: str, external_library_id: str) -> int:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT id FROM linked_libraries WHERE user_id = ? AND provider = ? AND external_library_id = ?",
                (user_id, provider, external_library_id),
            ).fetchone()
        if not row:
            raise ServiceError("Libreria non trovata.", status=404)
        return row["id"]

    def sync_library(self, user_id: int, library_id: int, payload: Dict[str, Any]) -> Dict[str, Any]:
        records = payload.get("records", [])
        collection_id = payload.get("collection_id")
        with self._connect() as connection:
            library = connection.execute("SELECT * FROM linked_libraries WHERE id = ? AND user_id = ?", (library_id, user_id)).fetchone()
            if not library:
                raise ServiceError("Libreria non trovata.", status=404)
            if library["status"] == "revoked":
                raise ServiceError("Autorizzazione revocata per la libreria.", status=403)
        summary = {"imported": 0, "conflicts": 0, "skipped": 0}
        for record in records:
            external_id = str(record.get("external_id") or record.get("doi") or record.get("title"))
            try:
                result = self.add_paper(user_id, identifier_type="manual", metadata=record, collection_id=collection_id)
                paper_id = result["paper"]["id"]
                with self._connect() as connection:
                    existing_mapping = connection.execute(
                        """
                        SELECT * FROM external_mappings
                        WHERE provider = ? AND external_id = ? AND entity_type = 'paper'
                        """,
                        (payload.get("provider", "library"), external_id),
                    ).fetchone()
                    if existing_mapping and existing_mapping["entity_id"] != paper_id:
                        summary["conflicts"] += 1
                    connection.execute(
                        """
                        INSERT INTO external_mappings (provider, external_id, entity_type, entity_id, external_library_id, last_synced_at, source_payload_json)
                        VALUES (?, ?, 'paper', ?, ?, ?, ?)
                        """,
                        (
                            payload.get("provider", "library"),
                            external_id,
                            paper_id,
                            str(library_id),
                            utcnow(),
                            json_dumps(record),
                        ),
                    )
                    connection.execute("UPDATE linked_libraries SET last_synced_at = ?, updated_at = ? WHERE id = ?", (utcnow(), utcnow(), library_id))
                summary["imported"] += 1
            except sqlite3.IntegrityError:
                summary["skipped"] += 1
        self._notify(user_id, "sync", "Sync completata", "La sincronizzazione della libreria e terminata.", {"library_id": library_id, "summary": summary})
        self._audit(user_id, "library_synced", "library", library_id, "Sincronizzazione completata.", details=summary)
        return summary

    def get_audit_log(self, user_id: int, collection_id: Optional[int] = None) -> List[Dict[str, Any]]:
        with self._connect() as connection:
            if collection_id:
                self._require_collection_access(user_id, collection_id)
                rows = connection.execute(
                    """
                    SELECT * FROM audit_events
                    WHERE target_type = 'collection' AND target_id = ?
                    ORDER BY created_at DESC
                    LIMIT 100
                    """,
                    (collection_id,),
                ).fetchall()
            else:
                rows = connection.execute(
                    """
                    SELECT * FROM audit_events
                    WHERE actor_user_id = ?
                    ORDER BY created_at DESC
                    LIMIT 100
                    """,
                    (user_id,),
                ).fetchall()
        return [dict(row) for row in rows]

    def export_user_data(self, user_id: int) -> Dict[str, Any]:
        user = self.get_user(user_id)
        return {
            "user": user,
            "collections": self.list_collections(user_id),
            "notifications": self.list_notifications(user_id),
            "feed": self.get_feed(user_id),
            "audit": self.get_audit_log(user_id),
        }

    def delete_account(self, user_id: int) -> Dict[str, Any]:
        with self._connect() as connection:
            owned = connection.execute("SELECT id FROM collections WHERE owner_id = ?", (user_id,)).fetchall()
            for row in owned:
                replacement = connection.execute(
                    """
                    SELECT user_id FROM collection_members
                    WHERE collection_id = ? AND user_id != ?
                    ORDER BY CASE role WHEN 'editor' THEN 1 WHEN 'viewer' THEN 2 ELSE 3 END, created_at ASC
                    LIMIT 1
                    """,
                    (row["id"], user_id),
                ).fetchone()
                if replacement:
                    connection.execute("UPDATE collections SET owner_id = ?, updated_at = ? WHERE id = ?", (replacement["user_id"], utcnow(), row["id"]))
                else:
                    connection.execute("UPDATE collections SET owner_id = NULL, status = 'archived', updated_at = ? WHERE id = ?", (utcnow(), row["id"]))
            connection.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
            connection.execute("UPDATE users SET deleted_at = ?, disabled = 1 WHERE id = ?", (utcnow(), user_id))
        self._audit(user_id, "account_deleted", "user", user_id, "Account eliminato.")
        return {"deleted": True}

    def report_record_issue(self, user_id: int, paper_id: int, message: str) -> Dict[str, Any]:
        self._audit(user_id, "record_reported", "paper", paper_id, message, details={"message": message})
        return {"paper_id": paper_id, "reported": True}

    def system_status(self) -> Dict[str, Any]:
        with self._connect() as connection:
            counts = {
                "users": connection.execute("SELECT COUNT(*) FROM users WHERE deleted_at IS NULL").fetchone()[0],
                "collections": connection.execute("SELECT COUNT(*) FROM collections").fetchone()[0],
                "papers": connection.execute("SELECT COUNT(*) FROM papers WHERE merged_into_paper_id IS NULL").fetchone()[0],
                "notifications": connection.execute("SELECT COUNT(*) FROM notifications").fetchone()[0],
                "imports": connection.execute("SELECT COUNT(*) FROM imports").fetchone()[0],
                "provider_cache_entries": connection.execute("SELECT COUNT(*) FROM provider_cache").fetchone()[0],
                "retrieval_runs": connection.execute("SELECT COUNT(*) FROM retrieval_runs").fetchone()[0],
            }
        return {"counts": counts, "providers": self.providers.docs()}

    def _audit(
        self,
        actor_user_id: Optional[int],
        event_type: str,
        target_type: str,
        target_id: Optional[int],
        summary: str,
        *,
        details: Optional[Dict[str, Any]] = None,
        automatic: bool = False,
    ) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO audit_events (actor_user_id, event_type, target_type, target_id, is_automatic, summary, details_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    actor_user_id,
                    event_type,
                    target_type,
                    target_id,
                    int(automatic),
                    summary,
                    json_dumps(details or {}),
                    utcnow(),
                ),
            )
