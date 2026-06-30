"""Symmetric encryption for Plaid ``access_token``s at rest.

Invariant 1 (security): the database only ever stores *ciphertext* for an
``access_token``; the plaintext lives in memory just long enough to make a Plaid
data call. Fernet (AES-128-CBC + HMAC, from ``cryptography``) gives us
authenticated symmetric encryption keyed entirely by ``ACCESS_TOKEN_ENC_KEY``,
which comes from the environment and is never committed.

Used from Phase 2 (encrypt on exchange) onward (decrypt before each sync).
"""

from __future__ import annotations

from functools import lru_cache

from cryptography.fernet import Fernet, InvalidToken

from .config import get_settings


@lru_cache
def _fernet() -> Fernet:
    """Build the Fernet cipher from the env key (cached for process lifetime)."""
    key = get_settings().access_token_enc_key
    if not key:
        raise RuntimeError(
            "ACCESS_TOKEN_ENC_KEY is not set. Generate a Fernet key and provide "
            "it via the environment (see backend/.env.example)."
        )
    try:
        # Fernet validates the key shape (32 url-safe-base64 bytes) on construction.
        return Fernet(key.encode("utf-8"))
    except (ValueError, TypeError) as exc:
        raise RuntimeError(
            "ACCESS_TOKEN_ENC_KEY is not a valid Fernet key (expected 32 "
            "url-safe-base64-encoded bytes)."
        ) from exc


def encrypt_token(plaintext: str) -> str:
    """Encrypt a Plaid access_token for storage. Returns url-safe ciphertext."""
    return _fernet().encrypt(plaintext.encode("utf-8")).decode("utf-8")


def decrypt_token(ciphertext: str) -> str:
    """Decrypt a stored access_token back to plaintext for a Plaid call.

    Raises RuntimeError if the ciphertext can't be authenticated with the
    current key (wrong/rotated key, or tampered data).
    """
    try:
        return _fernet().decrypt(ciphertext.encode("utf-8")).decode("utf-8")
    except InvalidToken as exc:
        raise RuntimeError(
            "Failed to decrypt access_token — ciphertext does not match the "
            "current ACCESS_TOKEN_ENC_KEY (wrong key, rotated key, or corruption)."
        ) from exc
