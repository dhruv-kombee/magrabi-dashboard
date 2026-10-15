"""Small process-local token bucket: shed excess monitoring reads instead of queuing them."""
import threading
import time


class RequestBudget:
    def __init__(self, *, burst, per_second, clock=time.monotonic):
        if type(burst) is not int or burst < 1 or not 0 < per_second <= 2:
            raise ValueError("invalid_request_budget")
        self._burst, self._rate, self._clock = burst, per_second, clock
        self._tokens, self._at = float(burst), clock()
        self._lock = threading.Lock()

    def consume(self):
        with self._lock:
            now = self._clock()
            self._tokens = min(self._burst, self._tokens + max(0, now - self._at) * self._rate)
            self._at = now
            if self._tokens < 1:
                return False
            self._tokens -= 1
            return True

    def wrap(self, get):
        def limited_get(*args, **kwargs):
            if not self.consume():
                raise RuntimeError("monitoring_read_budget_exhausted")
            return get(*args, **kwargs)
        return limited_get
