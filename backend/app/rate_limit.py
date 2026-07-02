"""Login brute-force throttle — a single global budget of failed attempts.

Why *global* (not per-IP): a rate limit should be keyed by the resource under
attack, and here that resource is one password (single-user app). One password →
one guess budget, no matter how many IPs the guesses arrive from — so IP
rotation buys an attacker nothing, and we never have to trust or parse
``X-Forwarded-For`` for a security decision. The accepted trade-off: an active
attacker can hold the budget exhausted and lock the real user out too. For a
finance app that is the right failure direction (confidentiality over login
availability); it self-heals when the attack stops and every attempt is logged.

Why in-memory: the deployed backend is one uvicorn process (no ``--workers``),
so a process-local counter is exact. If the service ever scales to N workers or
replicas, this silently becomes N× the budget — at that point the counter moves
into Postgres. A restart clears the budget, which is fine: an attacker cannot
trigger restarts.

Thread safety is load-bearing, not optional: sync endpoints run in FastAPI's
threadpool, so concurrent logins hit this from different threads. Without the
lock, a burst could race past the cap at exactly the moment the cap matters.

``time.monotonic`` (not ``time.time``) so the window can't be stretched or
shrunk by wall-clock adjustments (NTP steps, manual changes).
"""

from __future__ import annotations

import threading
import time
from collections import deque


class FailureBudget:
    """Sliding-window budget of failures (max ``max_failures`` per ``window_seconds``).

    Exact sliding window over a deque of failure timestamps — at a cap this
    small, exactness and auditability beat the memory savings of fixed-window
    or token-bucket approximations (a fixed window also allows a 2× burst
    straddling the reset boundary).
    """

    def __init__(self, max_failures: int, window_seconds: float) -> None:
        self.max_failures = max_failures
        self.window_seconds = window_seconds
        self._failures: deque[float] = deque()
        self._lock = threading.Lock()

    def _prune(self, now: float) -> None:
        cutoff = now - self.window_seconds
        while self._failures and self._failures[0] <= cutoff:
            self._failures.popleft()

    def retry_after(self) -> int:
        """Seconds until a budget slot frees, or 0 if the budget is available.

        Call this *before* any expensive work (bcrypt, DB lookup): the check is
        the cheap gate that stops an over-budget attacker from still burning
        ~250ms of CPU per request.
        """
        with self._lock:
            now = time.monotonic()
            self._prune(now)
            if len(self._failures) < self.max_failures:
                return 0
            # The oldest failure is the next to age out of the window.
            freed_in = self._failures[0] + self.window_seconds - now
            return max(1, int(freed_in) + 1)

    def record_failure(self) -> None:
        with self._lock:
            now = time.monotonic()
            self._prune(now)
            self._failures.append(now)

    def record_success(self) -> None:
        """Clear the budget. Only a caller holding the real password can reach
        this, so it never helps an attacker — it only stops the legitimate
        user's own typos from lingering against them."""
        with self._lock:
            self._failures.clear()
