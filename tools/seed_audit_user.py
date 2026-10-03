"""Create verified OpenBib accounts through the real OTP registration flow.

Local verification helper (standard library only). For each ``--email`` it
logs in when the account already exists; otherwise it runs the browser flow
(``/auth/registration/start`` -> code from the Mailpit API -> ``/verify`` ->
``/complete`` with the versions from ``/legal.json``), logs in and prints the
user id. Optionally it then seeds a demo Library with
``scripts.seed_demo_library`` inside the running ``api`` container.

    python tools/seed_audit_user.py \\
        --email audit@example.com --email audit-new@example.com \\
        --email editor@example.com --password correct-horse-battery-2
    python tools/seed_audit_user.py --email audit@example.com \\
        --email editor@example.com --password correct-horse-battery-2 \\
        --seed audit@example.com --share-with editor@example.com

Defaults: BASE_URL=http://localhost:3000 (the ``web`` container: it serves
``/legal.json`` and proxies ``/api``), MAILPIT_URL=http://localhost:8025.
Registration sends are limited to 5 per hour per IP and per email; existing
accounts skip registration entirely. Never point this at production.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

OTP = re.compile(r"(?m)^(\d{6})$")
REGISTRATION_COOKIES = ("openbib_registration", "__Host-openbib_registration")


class FlowError(RuntimeError):
    pass


def request(method, url, *, body=None, headers=None, timeout=30):
    """Return (status, headers, parsed JSON or text); HTTP errors are returned, not raised."""
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Accept", "application/json")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    for name, value in (headers or {}).items():
        req.add_header(name, value)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            status, head, raw = resp.status, resp.headers, resp.read()
    except urllib.error.HTTPError as exc:
        status, head, raw = exc.code, exc.headers, exc.read()
    text = raw.decode("utf-8", "replace")
    try:
        return status, head, json.loads(text) if text else None
    except ValueError:
        return status, head, text


def registration_cookie(headers, current=None):
    """The registration cookie from Set-Cookie (it rotates after /verify)."""
    for header in headers.get_all("Set-Cookie") or []:
        name, _, rest = header.partition("=")
        if name.strip() in REGISTRATION_COOKIES:
            value = rest.split(";", 1)[0]
            return f"{name.strip()}={value}" if value else None
    return current


class Stack:
    def __init__(self, base_url, mailpit_url, timeout):
        self.base = base_url.rstrip("/")
        self.api = f"{self.base}/api/v1"
        self.mailpit = mailpit_url.rstrip("/")
        self.timeout = timeout
        self.origin = {"Origin": self.base}

    def legal_versions(self):
        status, _, legal = request("GET", f"{self.base}/legal.json")
        if status != 200 or not isinstance(legal, dict):
            raise FlowError(f"GET /legal.json returned {status}; is the web container up?")
        return legal["terms_version"], legal["privacy_version"]

    def login(self, email, password):
        status, _, body = request(
            "POST",
            f"{self.api}/auth/login",
            body={"email": email, "password": password},
            headers=self.origin,
        )
        if status == 200:
            return body["access_token"]
        if status in (401, 403):
            return None
        raise FlowError(f"login for {email} returned {status}: {body}")

    def user_id(self, token):
        status, _, body = request(
            "GET", f"{self.api}/users/me", headers={"Authorization": f"Bearer {token}"}
        )
        if status != 200:
            raise FlowError(f"GET /users/me returned {status}: {body}")
        return body["id"]

    def message_ids(self, email):
        query = urllib.parse.urlencode({"query": f'to:"{email}"', "limit": "50"})
        status, _, body = request("GET", f"{self.mailpit}/api/v1/search?{query}")
        if status != 200 or not isinstance(body, dict):
            raise FlowError(f"Mailpit search returned {status}; is MAILPIT_URL right?")
        return [m["ID"] for m in body.get("messages") or []]

    def wait_for_code(self, email, seen):
        """Poll Mailpit for a message not in ``seen`` and return its 6-digit code."""
        deadline = time.monotonic() + self.timeout
        while time.monotonic() < deadline:
            for message_id in self.message_ids(email):
                if message_id in seen:
                    continue
                seen.add(message_id)
                status, _, message = request("GET", f"{self.mailpit}/api/v1/message/{message_id}")
                text = (message or {}).get("Text", "") if status == 200 else ""
                match = OTP.search(text.replace("\r\n", "\n"))
                if match:
                    return match.group(1)
            time.sleep(1)  # the mail-worker polls the outbox every few seconds
        raise FlowError(f"no verification code for {email} in Mailpit after {self.timeout}s")

    def register(self, email, password, display_name, locale):
        terms_version, privacy_version = self.legal_versions()
        seen = set(self.message_ids(email))
        status, head, body = request(
            "POST",
            f"{self.api}/auth/registration/start",
            body={"email": email, "locale": locale},
            headers=self.origin,
        )
        cookie = registration_cookie(head)
        if status != 202 or not cookie:
            raise FlowError(f"registration/start for {email} returned {status}: {body}")
        code = self.wait_for_code(email, seen)
        status, head, body = request(
            "POST",
            f"{self.api}/auth/registration/verify",
            body={"code": code},
            headers={**self.origin, "Cookie": cookie},
        )
        cookie = registration_cookie(head, cookie)
        if status != 200 or (body or {}).get("stage") != "profile":
            raise FlowError(f"registration/verify for {email} returned {status}: {body}")
        status, _, body = request(
            "POST",
            f"{self.api}/auth/registration/complete",
            body={
                "accept_terms": True,
                "terms_version": terms_version,
                "privacy_version": privacy_version,
                "password": password,
                "display_name": display_name,
            },
            headers={**self.origin, "Cookie": cookie},
        )
        if status != 200:
            raise FlowError(f"registration/complete for {email} returned {status}: {body}")
        return body["access_token"]

    def ensure_user(self, email, password, display_name, locale):
        token = self.login(email, password)
        outcome = "existing"
        if token is None:
            self.register(email, password, display_name, locale)
            token = self.login(email, password)
            outcome = "registered"
            if token is None:
                raise FlowError(f"{email} was registered but cannot log in")
        return self.user_id(token), outcome


def seed_library(args):
    command = [
        "docker", "compose", "exec", "-T", "api",
        "python", "-m", "scripts.seed_demo_library",
        "--email", args.seed,
        "--papers", str(args.papers),
        "--collections", str(args.collections),
        "--long-data",
    ]  # fmt: skip
    if args.share_with:
        command += ["--share-with", args.share_with]
    if args.reset:
        command.append("--reset")
    print("$ " + " ".join(command), flush=True)
    return subprocess.run(command, check=False).returncode


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--email", action="append", required=True, help="repeatable")
    parser.add_argument("--password", default=os.environ.get("AUDIT_PASSWORD"))
    parser.add_argument("--display-name", help="default: the email's local part")
    parser.add_argument("--locale", choices=("en", "it"), default="en")
    parser.add_argument("--base-url", default=os.environ.get("BASE_URL", "http://localhost:3000"))
    parser.add_argument(
        "--mailpit-url", default=os.environ.get("MAILPIT_URL", "http://localhost:8025")
    )
    parser.add_argument("--timeout", type=float, default=60, help="seconds to wait for a code")
    parser.add_argument("--seed", metavar="EMAIL", help="run seed_demo_library for this account")
    parser.add_argument("--share-with", metavar="EMAIL", help="passed to seed_demo_library")
    parser.add_argument("--papers", type=int, default=400)
    parser.add_argument("--collections", type=int, default=4)
    parser.add_argument("--reset", action="store_true", help="passed to seed_demo_library")
    args = parser.parse_args(argv)
    if not args.password or len(args.password) < 8:
        parser.error("--password (or AUDIT_PASSWORD) of at least 8 characters is required")
    stack = Stack(args.base_url, args.mailpit_url, args.timeout)
    try:
        for raw in args.email:
            email = raw.strip().lower()
            name = args.display_name or email.split("@", 1)[0]
            user_id, outcome = stack.ensure_user(email, args.password, name, args.locale)
            print(f"{email}\t{user_id}\t{outcome}", flush=True)
    except (FlowError, urllib.error.URLError, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    if args.seed:
        return seed_library(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
