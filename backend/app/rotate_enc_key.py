"""Re-encrypt every stored access_token under the current primary key — step 2
of the key-rotation runbook (see ``crypto.py``'s module docstring).

Run *after* prepending the new key to ``ACCESS_TOKEN_ENC_KEY`` and deploying,
and *before* dropping the old key from the list. Like ``set_password``, this
runs inside Railway (``railway ssh``) because the prod DB is private:

    python -m app.rotate_enc_key

Idempotent and safe to re-run: a row already under the primary key is simply
re-encrypted under that same key. Each row is updated in its own transaction,
so an interruption leaves a mix of old- and new-key rows — all still readable
(both keys are in the list at this point), and the next run finishes the job.
The plaintext token never leaves ``MultiFernet.rotate`` (never printed, never
logged); only ciphertexts move.
"""

from __future__ import annotations

from .crypto import rotate_ciphertext
from .db import connect


def rotate_all() -> tuple[int, int]:
    """Rotate every live ciphertext; return (rotated, failed) counts."""
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, plaid_item_id, access_token_encrypted FROM items "
                "WHERE access_token_encrypted IS NOT NULL"
            )
            rows = cur.fetchall()

    rotated = failed = 0
    for item_id, plaid_item_id, ciphertext in rows:
        try:
            new_ciphertext = rotate_ciphertext(ciphertext)
        except RuntimeError as exc:
            # Report and continue — one undecryptable row must not strand the rest.
            print(f"  FAILED  {plaid_item_id}: {exc}")
            failed += 1
            continue
        with connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE items SET access_token_encrypted = %s WHERE id = %s",
                    (new_ciphertext, item_id),
                )
        rotated += 1
        print(f"  rotated {plaid_item_id}")

    return rotated, failed


def main() -> int:
    print("rotate_enc_key: re-encrypting stored access_tokens under the primary key")
    rotated, failed = rotate_all()
    print(f"rotate_enc_key: done — {rotated} rotated, {failed} failed")
    if failed:
        print(
            "rotate_enc_key: some rows failed — do NOT drop the old key from "
            "ACCESS_TOKEN_ENC_KEY until this reports 0 failed."
        )
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
