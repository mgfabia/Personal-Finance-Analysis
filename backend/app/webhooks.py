"""Plaid webhook verification — Phase 4.

Every webhook must be verified before we act on it (§Webhook requirements 2).
Plaid signs each webhook with a JWT in the ``Plaid-Verification`` header, signed
ES256 with a per-key-id key we fetch from ``/webhook_verification_key/get``.

Verification (all must pass, else reject):
  1. Header ``alg`` is exactly ``ES256`` — pinned, never trust the token's alg
     (the algorithm-confusion defense; same spirit as the auth invariant).
  2. Signature validates against the JWK for the token's ``kid``.
  3. The key is not expired/rotated (``expired_at`` is null).
  4. ``request_body_sha256`` claim equals SHA-256 of the *raw* request body —
     so the verified token actually covers this payload (compared constant-time).
  5. ``iat`` is within 5 minutes — replay protection.

Verification keys are cached by ``kid`` (stable per key; cheap to keep).
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from typing import Any

import jwt
from jwt.algorithms import ECAlgorithm

from plaid.model.webhook_verification_key_get_request import (
    WebhookVerificationKeyGetRequest,
)

from .plaid_client import get_plaid_client

_MAX_AGE_SECONDS = 300
_key_cache: dict[str, dict[str, Any]] = {}

# Negative cache: kids whose lookup failed, with the monotonic time of failure.
# The endpoint is unauthenticated, so without this any junk POST with a random
# kid costs a live Plaid API call (quota burn on demand). TTL'd — not permanent
# like successes — because an unknown kid may be a freshly rotated *real* key;
# bounded, because the attacker chooses the kid strings and must not be able to
# grow the dict without limit.
_FAILED_KID_TTL_SECONDS = 300
_FAILED_KID_MAX = 1024
_failed_kids: dict[str, float] = {}


def _verification_key(kid: str) -> dict[str, Any] | None:
    """Fetch (and cache) the JWK for a key id from Plaid; None if unfetchable."""
    cached = _key_cache.get(kid)
    if cached is not None:
        return cached

    now = time.monotonic()
    failed_at = _failed_kids.get(kid)
    if failed_at is not None and (now - failed_at) < _FAILED_KID_TTL_SECONDS:
        return None  # recently failed — reject without touching Plaid

    client = get_plaid_client()
    try:
        resp = client.webhook_verification_key_get(
            WebhookVerificationKeyGetRequest(key_id=kid)
        )
    except Exception:
        if len(_failed_kids) >= _FAILED_KID_MAX:
            # Evict expired entries; if a flood filled it with live ones, reset —
            # losing negative entries only costs extra Plaid calls, never safety.
            fresh = {k: t for k, t in _failed_kids.items() if (now - t) < _FAILED_KID_TTL_SECONDS}
            _failed_kids.clear()
            if len(fresh) < _FAILED_KID_MAX:
                _failed_kids.update(fresh)
        _failed_kids[kid] = now
        return None
    jwk = resp["key"].to_dict()
    _key_cache[kid] = jwk
    _failed_kids.pop(kid, None)
    return jwk


def verify_webhook(raw_body: bytes, verification_header: str | None) -> bool:
    """Return True only if the webhook is authentic and covers this body."""
    if not verification_header:
        return False

    # 1. Read the unverified header to learn alg + kid; pin alg to ES256.
    try:
        header = jwt.get_unverified_header(verification_header)
    except jwt.PyJWTError:
        return False
    if header.get("alg") != "ES256" or not header.get("kid"):
        return False

    # 2/3. Fetch the key for this kid; reject if unknown, rotated, or expired.
    jwk = _verification_key(header["kid"])
    if jwk is None or jwk.get("expired_at") is not None:
        return False

    try:
        public_key = ECAlgorithm.from_jwk(
            json.dumps({k: jwk[k] for k in ("kty", "crv", "x", "y")})
        )
    except (KeyError, ValueError, jwt.PyJWTError):
        return False

    # Verify the signature — algorithms pinned to ES256 (alg-confusion defense).
    try:
        claims = jwt.decode(verification_header, key=public_key, algorithms=["ES256"])
    except jwt.PyJWTError:
        return False

    # 5. Freshness (replay protection).
    iat = claims.get("iat")
    if not isinstance(iat, (int, float)) or (time.time() - iat) > _MAX_AGE_SECONDS:
        return False

    # 4. Body integrity — the signed claim must match this exact body.
    expected = claims.get("request_body_sha256")
    actual = hashlib.sha256(raw_body).hexdigest()
    if not expected or not hmac.compare_digest(str(expected), actual):
        return False

    return True
