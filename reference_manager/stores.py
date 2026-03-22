from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional


def utcnow() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=True, sort_keys=True)


def json_loads(value: Optional[str], default: Any) -> Any:
    if not value:
        return default
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return default


class GraphStore:
    def initialize(self) -> None:
        return

    def upsert_node(self, node_type: str, node_id: Any, payload: Dict[str, Any]) -> None:
        raise NotImplementedError

    def upsert_edge(
        self,
        source_type: str,
        source_id: Any,
        target_type: str,
        target_id: Any,
        relation_type: str,
        payload: Dict[str, Any],
    ) -> None:
        raise NotImplementedError

    def delete_edge(
        self,
        source_type: str,
        source_id: Any,
        target_type: str,
        target_id: Any,
        relation_type: str,
    ) -> None:
        raise NotImplementedError

    def describe(self) -> Dict[str, Any]:
        raise NotImplementedError


class ReadModelStore:
    def initialize(self) -> None:
        return

    def upsert_view(self, view_type: str, view_key: str, payload: Dict[str, Any]) -> None:
        raise NotImplementedError

    def get_view(self, view_type: str, view_key: str) -> Optional[Dict[str, Any]]:
        raise NotImplementedError

    def delete_view(self, view_type: str, view_key: str) -> None:
        raise NotImplementedError

    def describe(self) -> Dict[str, Any]:
        raise NotImplementedError


class SqliteGraphStore(GraphStore):
    def __init__(self, db_path: str) -> None:
        self.db_path = db_path

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path)
        connection.row_factory = sqlite3.Row
        return connection

    def initialize(self) -> None:
        Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS graph_projection_nodes (
                    entity_key TEXT PRIMARY KEY,
                    entity_type TEXT NOT NULL,
                    entity_id TEXT NOT NULL,
                    payload_json TEXT NOT NULL DEFAULT '{}',
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS graph_projection_edges (
                    edge_key TEXT PRIMARY KEY,
                    source_key TEXT NOT NULL,
                    target_key TEXT NOT NULL,
                    relation_type TEXT NOT NULL,
                    payload_json TEXT NOT NULL DEFAULT '{}',
                    updated_at TEXT NOT NULL
                );
                """
            )
            connection.commit()

    def _entity_key(self, node_type: str, node_id: Any) -> str:
        return f"{node_type}:{node_id}"

    def upsert_node(self, node_type: str, node_id: Any, payload: Dict[str, Any]) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO graph_projection_nodes (entity_key, entity_type, entity_id, payload_json, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT (entity_key) DO UPDATE SET
                    payload_json = excluded.payload_json,
                    updated_at = excluded.updated_at
                """,
                (self._entity_key(node_type, node_id), node_type, str(node_id), json_dumps(payload), utcnow()),
            )
            connection.commit()

    def upsert_edge(
        self,
        source_type: str,
        source_id: Any,
        target_type: str,
        target_id: Any,
        relation_type: str,
        payload: Dict[str, Any],
    ) -> None:
        source_key = self._entity_key(source_type, source_id)
        target_key = self._entity_key(target_type, target_id)
        edge_key = f"{source_key}->{relation_type}->{target_key}"
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO graph_projection_edges (edge_key, source_key, target_key, relation_type, payload_json, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT (edge_key) DO UPDATE SET
                    payload_json = excluded.payload_json,
                    updated_at = excluded.updated_at
                """,
                (edge_key, source_key, target_key, relation_type, json_dumps(payload), utcnow()),
            )
            connection.commit()

    def delete_edge(
        self,
        source_type: str,
        source_id: Any,
        target_type: str,
        target_id: Any,
        relation_type: str,
    ) -> None:
        source_key = self._entity_key(source_type, source_id)
        target_key = self._entity_key(target_type, target_id)
        edge_key = f"{source_key}->{relation_type}->{target_key}"
        with self._connect() as connection:
            connection.execute("DELETE FROM graph_projection_edges WHERE edge_key = ?", (edge_key,))
            connection.commit()

    def describe(self) -> Dict[str, Any]:
        with self._connect() as connection:
            node_count = connection.execute("SELECT COUNT(*) FROM graph_projection_nodes").fetchone()[0]
            edge_count = connection.execute("SELECT COUNT(*) FROM graph_projection_edges").fetchone()[0]
        return {"backend": "sqlite", "nodes": node_count, "edges": edge_count}


class SqliteReadModelStore(ReadModelStore):
    def __init__(self, db_path: str) -> None:
        self.db_path = db_path

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path)
        connection.row_factory = sqlite3.Row
        return connection

    def initialize(self) -> None:
        Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS projection_views (
                    view_type TEXT NOT NULL,
                    view_key TEXT NOT NULL,
                    payload_json TEXT NOT NULL DEFAULT '{}',
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (view_type, view_key)
                );
                """
            )
            connection.commit()

    def upsert_view(self, view_type: str, view_key: str, payload: Dict[str, Any]) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO projection_views (view_type, view_key, payload_json, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT (view_type, view_key) DO UPDATE SET
                    payload_json = excluded.payload_json,
                    updated_at = excluded.updated_at
                """,
                (view_type, view_key, json_dumps(payload), utcnow()),
            )
            connection.commit()

    def get_view(self, view_type: str, view_key: str) -> Optional[Dict[str, Any]]:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT payload_json FROM projection_views WHERE view_type = ? AND view_key = ?",
                (view_type, view_key),
            ).fetchone()
        return json_loads(row["payload_json"], {}) if row else None

    def delete_view(self, view_type: str, view_key: str) -> None:
        with self._connect() as connection:
            connection.execute(
                "DELETE FROM projection_views WHERE view_type = ? AND view_key = ?",
                (view_type, view_key),
            )
            connection.commit()

    def describe(self) -> Dict[str, Any]:
        with self._connect() as connection:
            count = connection.execute("SELECT COUNT(*) FROM projection_views").fetchone()[0]
        return {"backend": "sqlite", "views": count}


class Neo4jGraphStore(GraphStore):
    def __init__(self, uri: str, username: str, password: str, *, database: Optional[str] = None) -> None:
        try:
            from neo4j import GraphDatabase
        except ImportError as error:
            raise RuntimeError("neo4j package is not installed.") from error
        self.driver = GraphDatabase.driver(uri, auth=(username, password))
        self.database = database

    def initialize(self) -> None:
        return

    def _label(self, node_type: str) -> str:
        mapping = {"user": "User", "paper": "Paper", "collection": "Collection"}
        if node_type not in mapping:
            raise ValueError(f"Unsupported node type for Neo4j: {node_type}")
        return mapping[node_type]

    def upsert_node(self, node_type: str, node_id: Any, payload: Dict[str, Any]) -> None:
        label = self._label(node_type)
        query = f"MERGE (n:{label} {{key: $key}}) SET n.payload_json = $payload_json, n.updated_at = $updated_at"
        with self.driver.session(database=self.database) as session:
            session.run(query, key=f"{node_type}:{node_id}", payload_json=json_dumps(payload), updated_at=utcnow())

    def upsert_edge(
        self,
        source_type: str,
        source_id: Any,
        target_type: str,
        target_id: Any,
        relation_type: str,
        payload: Dict[str, Any],
    ) -> None:
        source_label = self._label(source_type)
        target_label = self._label(target_type)
        rel = relation_type.upper().replace("-", "_")
        query = (
            f"MERGE (s:{source_label} {{key: $source_key}}) "
            f"MERGE (t:{target_label} {{key: $target_key}}) "
            f"MERGE (s)-[r:{rel}]->(t) "
            f"SET r.payload_json = $payload_json, r.updated_at = $updated_at"
        )
        with self.driver.session(database=self.database) as session:
            session.run(
                query,
                source_key=f"{source_type}:{source_id}",
                target_key=f"{target_type}:{target_id}",
                payload_json=json_dumps(payload),
                updated_at=utcnow(),
            )

    def delete_edge(
        self,
        source_type: str,
        source_id: Any,
        target_type: str,
        target_id: Any,
        relation_type: str,
    ) -> None:
        source_label = self._label(source_type)
        target_label = self._label(target_type)
        rel = relation_type.upper().replace("-", "_")
        query = (
            f"MATCH (s:{source_label} {{key: $source_key}})-[r:{rel}]->(t:{target_label} {{key: $target_key}}) "
            "DELETE r"
        )
        with self.driver.session(database=self.database) as session:
            session.run(query, source_key=f"{source_type}:{source_id}", target_key=f"{target_type}:{target_id}")

    def describe(self) -> Dict[str, Any]:
        return {"backend": "neo4j", "database": self.database or "default"}


class MongoReadModelStore(ReadModelStore):
    def __init__(self, uri: str, database: str) -> None:
        try:
            from pymongo import MongoClient
        except ImportError as error:
            raise RuntimeError("pymongo package is not installed.") from error
        self.client = MongoClient(uri)
        self.database = self.client[database]
        self.collection = self.database["projection_views"]

    def initialize(self) -> None:
        self.collection.create_index([("view_type", 1), ("view_key", 1)], unique=True)

    def upsert_view(self, view_type: str, view_key: str, payload: Dict[str, Any]) -> None:
        self.collection.update_one(
            {"view_type": view_type, "view_key": view_key},
            {"$set": {"payload": payload, "updated_at": utcnow()}},
            upsert=True,
        )

    def get_view(self, view_type: str, view_key: str) -> Optional[Dict[str, Any]]:
        document = self.collection.find_one({"view_type": view_type, "view_key": view_key})
        return document.get("payload") if document else None

    def delete_view(self, view_type: str, view_key: str) -> None:
        self.collection.delete_one({"view_type": view_type, "view_key": view_key})

    def describe(self) -> Dict[str, Any]:
        return {"backend": "mongodb", "database": self.database.name}


@dataclass(frozen=True)
class StoreBundle:
    graph: GraphStore
    read_models: ReadModelStore


def _projection_db_path(db_path: str, suffix: str) -> str:
    path = Path(db_path)
    if path.suffix:
        return str(path.with_name(f"{path.stem}.{suffix}{path.suffix}"))
    return f"{db_path}.{suffix}.sqlite3"


def build_store_bundle(config: Any, *, db_path: str) -> StoreBundle:
    if getattr(config, "graph_store_backend", "sqlite") == "neo4j":
        graph = Neo4jGraphStore(
            config.neo4j_uri,
            config.neo4j_username,
            config.neo4j_password,
            database=config.neo4j_database,
        )
    else:
        graph = SqliteGraphStore(_projection_db_path(db_path, "graph"))
    if getattr(config, "read_model_store_backend", "sqlite") == "mongodb":
        read_models = MongoReadModelStore(config.mongodb_uri, config.mongodb_database)
    else:
        read_models = SqliteReadModelStore(_projection_db_path(db_path, "views"))
    graph.initialize()
    read_models.initialize()
    return StoreBundle(graph=graph, read_models=read_models)
