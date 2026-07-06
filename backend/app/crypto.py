"""Symmetric encryption for Plaid ``access_token``s at rest.

Invariant 1 (security): the database only ever stores *ciphertext* for an
``access_token``; the plaintext lives in memory just long enough to make a Plaid
data call. Fernet (AES-128-CBC + HMAC, from ``cryptography``) gives us
authenticated symmetric encryption keyed entirely by ``ACCESS_TOKEN_ENC_KEY``,
which comes from the environment and is never committed.

``ACCESS_TOKEN_ENC_KEY`` is a comma-separated list of Fernet keys, **newest
first** (a single key — today's config — is the degenerate case and needs no
change). MultiFernet encrypts with the first key and tries each in order on
decrypt, which is what makes rotation possible *without* orphaning stored
tokens (plain Fernet would raise InvalidToken on everything the moment the key
changed, forcing a manual re-link of every bank). Rotation runbook:

    1. Generate a new key; prepend it: ACCESS_TOKEN_ENC_KEY=<new>,<old>. Deploy.
       Old rows still decrypt (old key), new writes use the new key.
    2. Re-encrypt existing rows: python -m app.rotate_enc_key
    3. Drop the old key from the list. Deploy. The old key is now powerless.

Used from Phase 2 (encrypt on exchange) onward (decrypt before each sync).
"""

from __future__ import annotations

from functools import lru_cache

from cryptography.fernet import Fernet, InvalidToken, MultiFernet

from .config import get_settings


@lru_cache
def _fernet() -> MultiFernet:
    """Build the cipher from the env key list (cached for process lifetime)."""
    raw = get_settings().access_token_enc_key
    keys = [k.strip() for k in raw.split(",") if k.strip()]
    if not keys:
        raise RuntimeError(
            "ACCESS_TOKEN_ENC_KEY is not set. Generate a Fernet key and provide "
            "it via the environment (see backend/.env.example)."
        )
    try:
        # Fernet validates each key's shape (32 url-safe-base64 bytes) on
        # construction; fail at startup, not on the first token write.
        return MultiFernet([Fernet(k.encode("utf-8")) for k in keys])
    except (ValueError, TypeError) as exc:
        raise RuntimeError(
            "ACCESS_TOKEN_ENC_KEY contains an invalid Fernet key (expected "
            "comma-separated 32-byte url-safe-base64 keys, newest first)."
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
            "Failed to decrypt access_token — ciphertext does not match any key "
            "in ACCESS_TOKEN_ENC_KEY (wrong key, dropped too early, or corruption)."
        ) from exc


def rotate_ciphertext(ciphertext: str) -> str:
    """Re-encrypt a stored ciphertext under the current primary (first) key.

    MultiFernet.rotate decrypts with whichever key matches and re-encrypts with
    the first — the plaintext never leaves this call. Raises RuntimeError if no
    key in the list can decrypt it (same failure mode as decrypt_token).
    """
    try:
        return _fernet().rotate(ciphertext.encode("utf-8")).decode("utf-8")
    except InvalidToken as exc:
        raise RuntimeError(
            "Cannot rotate ciphertext — no key in ACCESS_TOKEN_ENC_KEY decrypts "
            "it. Re-add the old key to the list, then rotate again."
        ) from exc
