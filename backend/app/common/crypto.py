"""Authenticated encryption for sensitive application data."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
from dataclasses import dataclass

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from app.config import settings


@dataclass(frozen=True)
class EncryptedValue:
    ciphertext: bytes
    nonce: bytes
    key_version: int


class EncryptionKeyring:
    def __init__(self, encoded_keys: str, active_version: int):
        raw = json.loads(encoded_keys)
        self._keys: dict[int, bytes] = {}
        for version, encoded in raw.items():
            key = base64.b64decode(encoded, validate=True)
            if len(key) != 32:
                raise ValueError("Every application encryption key must be exactly 32 bytes")
            self._keys[int(version)] = key
        if active_version not in self._keys:
            raise ValueError("Active encryption key version is unavailable")
        self.active_version = active_version

    def _purpose_key(self, version: int, purpose: str) -> bytes:
        master = self._keys.get(version)
        if master is None:
            raise ValueError(f"Unknown encryption key version: {version}")
        return HKDF(
            algorithm=hashes.SHA256(), length=32, salt=None, info=f"openbib:{purpose}".encode()
        ).derive(master)

    def encrypt(self, value: str, *, purpose: str, aad: str) -> EncryptedValue:
        nonce = os.urandom(12)
        version = self.active_version
        ciphertext = AESGCM(self._purpose_key(version, purpose)).encrypt(
            nonce, value.encode(), f"{purpose}:{aad}:v{version}".encode()
        )
        return EncryptedValue(ciphertext=ciphertext, nonce=nonce, key_version=version)

    def digest(self, value: str, *, purpose: str, version: int) -> str:
        """Keyed verification for low-entropy secrets, isolated by purpose/version."""
        return hmac.new(
            self._purpose_key(version, purpose), value.encode(), hashlib.sha256
        ).hexdigest()

    def decrypt(self, value: EncryptedValue, *, purpose: str, aad: str) -> str:
        plaintext = AESGCM(self._purpose_key(value.key_version, purpose)).decrypt(
            value.nonce, value.ciphertext, f"{purpose}:{aad}:v{value.key_version}".encode()
        )
        return plaintext.decode()


keyring = EncryptionKeyring(settings.app_encryption_keys, settings.app_active_key_version)
