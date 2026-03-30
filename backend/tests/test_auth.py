"""Tests for auth service (password hashing, JWT tokens)."""

import pytest

from app.auth.service import (
    create_access_token,
    create_refresh_token,
    hash_password,
    verify_access_token,
    verify_password,
    verify_refresh_token,
)


def test_hash_and_verify_password():
    password = "correct-horse-battery-staple"
    h = hash_password(password)
    assert h != password
    assert verify_password(password, h) is True
    assert verify_password("wrong-password", h) is False


def test_access_token_roundtrip():
    user_id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    token = create_access_token(user_id)
    payload = verify_access_token(token)
    assert payload is not None
    assert payload["sub"] == user_id
    assert payload["type"] == "access"


def test_refresh_token_roundtrip():
    user_id = "11111111-2222-3333-4444-555555555555"
    token = create_refresh_token(user_id)
    payload = verify_refresh_token(token)
    assert payload is not None
    assert payload["sub"] == user_id
    assert payload["type"] == "refresh"


def test_access_token_invalid():
    assert verify_access_token("not.a.token") is None


def test_refresh_token_rejects_access_token():
    token = create_access_token("some-user-id")
    assert verify_refresh_token(token) is None
