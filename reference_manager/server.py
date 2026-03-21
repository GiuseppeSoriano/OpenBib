from __future__ import annotations

import json
import mimetypes
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import parse_qs, urlparse

from .service import ReferenceManagerService, ServiceError


def json_response(handler: BaseHTTPRequestHandler, status: int, payload: Dict[str, Any]) -> None:
    data = json.dumps(payload, ensure_ascii=True, indent=2).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(data)))
    handler.end_headers()
    handler.wfile.write(data)


class ReferenceManagerHandler(BaseHTTPRequestHandler):
    service: ReferenceManagerService
    static_dir: Path

    def log_message(self, format: str, *args: Any) -> None:
        return

    def _token(self) -> Optional[str]:
        raw = self.headers.get("Cookie")
        if not raw:
            return None
        jar = cookies.SimpleCookie()
        jar.load(raw)
        morsel = jar.get("session_token")
        return morsel.value if morsel else None

    def _user(self) -> Optional[Dict[str, Any]]:
        token = self._token()
        return self.service.get_user_from_token(token or "") if token else None

    def _parse_body(self) -> Dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b"{}"
        if not raw:
            return {}
        return json.loads(raw.decode("utf-8"))

    def _set_session_cookie(self, token: str) -> None:
        cookie = cookies.SimpleCookie()
        cookie["session_token"] = token
        cookie["session_token"]["path"] = "/"
        cookie["session_token"]["httponly"] = True
        self.send_header("Set-Cookie", cookie.output(header="").strip())

    def _serve_static(self, path: str) -> None:
        relative = "index.html" if path in {"/", ""} else path.lstrip("/")
        file_path = self.static_dir / relative
        if not file_path.exists() or not file_path.is_file():
            self.send_error(404)
            return
        content = file_path.read_bytes()
        mime_type = mimetypes.guess_type(str(file_path))[0] or "text/plain"
        self.send_response(200)
        self.send_header("Content-Type", mime_type)
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        try:
            if parsed.path == "/api/bootstrap":
                json_response(self, 200, self.service.bootstrap(self._token()))
                return
            if parsed.path == "/api/profile":
                user = self.service.require_user(self._token())
                json_response(self, 200, {"user": user})
                return
            if parsed.path == "/api/collections":
                user = self.service.require_user(self._token())
                json_response(self, 200, {"collections": self.service.list_collections(user["id"])})
                return
            if parsed.path == "/api/papers":
                user = self.service.require_user(self._token())
                params = parse_qs(parsed.query)
                collection_id = int(params["collection_id"][0]) if params.get("collection_id") else None
                json_response(self, 200, {"papers": self.service.list_workspace_papers(user["id"], collection_id=collection_id)})
                return
            if parsed.path.startswith("/api/collections/"):
                user = self.service.require_user(self._token())
                collection_id = int(parsed.path.rsplit("/", 1)[-1])
                json_response(self, 200, {"collection": self.service.get_collection(user["id"], collection_id)})
                return
            if parsed.path == "/api/search":
                user = self.service.require_user(self._token())
                params = parse_qs(parsed.query)
                collection_id = int(params["collection_id"][0]) if params.get("collection_id") else None
                filters = {
                    "collection_id": collection_id,
                    "status": params.get("status", [None])[0],
                }
                json_response(self, 200, self.service.search_papers(user["id"], params.get("q", [""])[0], filters))
                return
            if parsed.path.startswith("/api/papers/"):
                user = self.service.require_user(self._token())
                paper_id = int(parsed.path.rsplit("/", 1)[-1])
                json_response(self, 200, {"paper": self.service.get_paper(paper_id)})
                return
            if parsed.path == "/api/authors":
                user = self.service.require_user(self._token())
                params = parse_qs(parsed.query)
                json_response(self, 200, {"authors": self.service.search_authors(params.get("q", [""])[0])})
                return
            if parsed.path.startswith("/api/authors/"):
                user = self.service.require_user(self._token())
                author_id = int(parsed.path.rsplit("/", 1)[-1])
                json_response(self, 200, {"author": self.service.get_author(author_id)})
                return
            if parsed.path == "/api/graph":
                user = self.service.require_user(self._token())
                params = parse_qs(parsed.query)
                seeds = [int(item) for item in params.get("seed", [])]
                depth = int(params.get("depth", ["1"])[0])
                json_response(self, 200, self.service.get_graph(user["id"], seeds, depth=depth))
                return
            if parsed.path == "/api/timeline":
                user = self.service.require_user(self._token())
                params = parse_qs(parsed.query)
                collection_id = int(params["collection_id"][0]) if params.get("collection_id") else None
                seed_paper_id = int(params["seed_paper_id"][0]) if params.get("seed_paper_id") else None
                topic = params.get("topic", [None])[0]
                json_response(self, 200, self.service.timeline(user["id"], collection_id=collection_id, topic=topic, seed_paper_id=seed_paper_id))
                return
            if parsed.path == "/api/recommendations":
                user = self.service.require_user(self._token())
                params = parse_qs(parsed.query)
                collection_id = int(params["collection_id"][0]) if params.get("collection_id") else None
                seed_ids = [int(item) for item in params.get("seed", [])]
                json_response(self, 200, self.service.recommend(user["id"], collection_id=collection_id, seed_paper_ids=seed_ids))
                return
            if parsed.path == "/api/feed":
                user = self.service.require_user(self._token())
                json_response(self, 200, {"items": self.service.get_feed(user["id"])})
                return
            if parsed.path == "/api/notifications":
                user = self.service.require_user(self._token())
                json_response(self, 200, {"notifications": self.service.list_notifications(user["id"])})
                return
            if parsed.path == "/api/audit":
                user = self.service.require_user(self._token())
                params = parse_qs(parsed.query)
                collection_id = int(params["collection_id"][0]) if params.get("collection_id") else None
                json_response(self, 200, {"events": self.service.get_audit_log(user["id"], collection_id=collection_id)})
                return
            if parsed.path == "/api/retrieval-runs":
                user = self.service.require_user(self._token())
                params = parse_qs(parsed.query)
                paper_id = int(params["paper_id"][0]) if params.get("paper_id") else None
                json_response(self, 200, {"runs": self.service.list_retrieval_runs(user["id"], paper_id=paper_id)})
                return
            if parsed.path == "/api/providers":
                user = self._user()
                json_response(self, 200, {"providers": self.service.list_provider_statuses(user["id"]) if user else self.service.providers.docs()})
                return
            if parsed.path == "/api/system":
                json_response(self, 200, self.service.system_status())
                return
            self._serve_static(parsed.path)
        except ServiceError as error:
            json_response(self, error.status, {"error": error.message, "details": error.details})

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        try:
            body = self._parse_body()
            if parsed.path == "/api/register":
                result = self.service.register_user(body.get("email", ""), body.get("password", ""), body.get("display_name"))
                self.send_response(201)
                self._set_session_cookie(result["token"])
                self.send_header("Content-Type", "application/json; charset=utf-8")
                response = json.dumps({"user": result["user"]}, ensure_ascii=True).encode("utf-8")
                self.send_header("Content-Length", str(len(response)))
                self.end_headers()
                self.wfile.write(response)
                return
            if parsed.path == "/api/login":
                result = self.service.login(body.get("email", ""), body.get("password", ""))
                self.send_response(200)
                self._set_session_cookie(result["token"])
                self.send_header("Content-Type", "application/json; charset=utf-8")
                response = json.dumps({"user": result["user"]}, ensure_ascii=True).encode("utf-8")
                self.send_header("Content-Length", str(len(response)))
                self.end_headers()
                self.wfile.write(response)
                return
            if parsed.path == "/api/logout":
                token = self._token()
                if token:
                    self.service.logout(token)
                self.send_response(204)
                self.end_headers()
                return
            user = self.service.require_user(self._token())
            if parsed.path == "/api/recover":
                json_response(self, 200, self.service.recover_access(body.get("email", "")))
                return
            if parsed.path == "/api/profile":
                json_response(self, 200, {"user": self.service.update_profile(user["id"], body)})
                return
            if parsed.path == "/api/collections":
                json_response(
                    self,
                    201,
                    {"collection": self.service.create_collection(user["id"], body.get("name", ""), body.get("description", ""), body.get("visibility", "private"), body.get("seed_paper_ids"))},
                )
                return
            if parsed.path == "/api/collections/update":
                json_response(self, 200, {"collection": self.service.update_collection(user["id"], int(body["collection_id"]), body)})
                return
            if parsed.path == "/api/collections/duplicate":
                json_response(self, 200, {"collection": self.service.duplicate_collection(user["id"], int(body["collection_id"]))})
                return
            if parsed.path == "/api/collections/merge":
                json_response(self, 200, {"collection": self.service.merge_collections(user["id"], int(body["target_id"]), body.get("source_ids", []))})
                return
            if parsed.path == "/api/snapshots":
                json_response(
                    self,
                    201,
                    {"snapshot": self.service.save_snapshot(user["id"], int(body["collection_id"]), body["name"], body.get("view_type", "graph"), body.get("state", {}))},
                )
                return
            if parsed.path == "/api/papers/add":
                result = self.service.add_paper(
                    user["id"],
                    identifier_type=body.get("identifier_type", "manual"),
                    value=body.get("value"),
                    collection_id=body.get("collection_id"),
                    metadata=body.get("metadata"),
                    force_refresh=body.get("force_refresh", False),
                )
                json_response(self, 201, result)
                return
            if parsed.path == "/api/papers/refresh":
                json_response(
                    self,
                    200,
                    self.service.refresh_paper_graph(user["id"], int(body["paper_id"]), force_refresh=body.get("force_refresh", True)),
                )
                return
            if parsed.path == "/api/papers/expand":
                json_response(
                    self,
                    200,
                    self.service.expand_paper_graph(
                        user["id"],
                        int(body["paper_id"]),
                        depth=int(body.get("depth", 1)),
                        force_refresh=body.get("force_refresh", False),
                    ),
                )
                return
            if parsed.path == "/api/papers/state":
                json_response(self, 200, self.service.set_paper_state(user["id"], int(body["paper_id"]), body))
                return
            if parsed.path == "/api/papers/merge":
                json_response(self, 200, {"paper": self.service.merge_papers(user["id"], int(body["winner_id"]), int(body["loser_id"]), body.get("reason", ""))})
                return
            if parsed.path == "/api/papers/report":
                json_response(self, 200, self.service.report_record_issue(user["id"], int(body["paper_id"]), body.get("message", "Segnalazione record.")))
                return
            if parsed.path == "/api/notes":
                json_response(self, 201, {"note": self.service.add_note(user["id"], body)})
                return
            if parsed.path == "/api/notes/update":
                json_response(self, 200, {"note": self.service.update_note(user["id"], int(body["note_id"]), body["body"])})
                return
            if parsed.path == "/api/notes/search":
                json_response(self, 200, {"notes": self.service.search_notes(user["id"], body.get("query", ""))})
                return
            if parsed.path == "/api/follow":
                json_response(self, 200, self.service.follow_entity(user["id"], body["entity_type"], int(body["entity_id"])))
                return
            if parsed.path == "/api/unfollow":
                self.service.unfollow_entity(user["id"], body["entity_type"], int(body["entity_id"]))
                json_response(self, 200, {"ok": True})
                return
            if parsed.path == "/api/import":
                json_response(self, 200, self.service.import_records(user["id"], body))
                return
            if parsed.path == "/api/export":
                json_response(
                    self,
                    200,
                    self.service.export_collection(
                        user["id"],
                        int(body["collection_id"]),
                        body.get("format", "json"),
                        body.get("include_notes", True),
                        body.get("include_states", True),
                    ),
                )
                return
            if parsed.path == "/api/providers/credentials":
                json_response(self, 200, self.service.upsert_provider_credential(user["id"], body))
                return
            if parsed.path == "/api/share/invite":
                json_response(self, 200, self.service.invite_collaborator(user["id"], int(body["collection_id"]), body["email"], body["role"]))
                return
            if parsed.path == "/api/share/revoke":
                self.service.revoke_collaborator(user["id"], int(body["collection_id"]), int(body["user_id"]))
                json_response(self, 200, {"ok": True})
                return
            if parsed.path == "/api/libraries/link":
                json_response(self, 201, self.service.link_library(user["id"], body))
                return
            if parsed.path == "/api/libraries/sync":
                json_response(self, 200, self.service.sync_library(user["id"], int(body["library_id"]), body))
                return
            if parsed.path == "/api/user/export":
                json_response(self, 200, self.service.export_user_data(user["id"]))
                return
            if parsed.path == "/api/account/delete":
                json_response(self, 200, self.service.delete_account(user["id"]))
                return
            raise ServiceError("Endpoint non trovato.", status=404)
        except ServiceError as error:
            json_response(self, error.status, {"error": error.message, "details": error.details})


def create_server(host: str, port: int, *, db_path: str, static_dir: str) -> ThreadingHTTPServer:
    service = ReferenceManagerService(db_path)
    handler = ReferenceManagerHandler
    handler.service = service
    handler.static_dir = Path(static_dir)
    return ThreadingHTTPServer((host, port), handler)
