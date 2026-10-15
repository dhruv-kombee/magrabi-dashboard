"""Per-request-thread async loop, without waiting for DNS executor shutdown per request.

An already-running OS resolver cannot be killed. Bound it to ONE task per request thread;
while occupied, later resolver submissions fail immediately instead of creating a queue.
The isolated Gunicorn process is fixed at four request threads. No threads/loops start on import.
"""
import asyncio
from concurrent.futures import ThreadPoolExecutor
import threading


class BoundedResolverExecutor(ThreadPoolExecutor):
    def __init__(self):
        super().__init__(max_workers=1, thread_name_prefix="monitoring-resolver")
        self._slot = threading.BoundedSemaphore(1)

    def submit(self, fn, /, *args, **kwargs):
        if not self._slot.acquire(blocking=False):
            raise RuntimeError("resolver_busy")
        try:
            future = super().submit(fn, *args, **kwargs)
        except BaseException:
            self._slot.release()
            raise
        # Cancelling asyncio's wrapper must NOT release an OS call still running underneath.
        future.add_done_callback(lambda _: self._slot.release())
        return future


class ThreadRuntime:
    def __init__(self, loop=None):
        self.loop = loop if loop is not None else asyncio.new_event_loop()
        self.resolver = BoundedResolverExecutor()
        self.loop.set_default_executor(self.resolver)

    def run(self, awaitable):
        # Deliberately no asyncio.run/Runner.close/shutdown_default_executor on the request path.
        # Timeout/cancellation happens inside the operation. OS resolution remains bounded above.
        return self.loop.run_until_complete(awaitable)


_state = threading.local()


def run_bounded(awaitable):
    try:
        runtime = getattr(_state, "runtime", None)
        if runtime is None:
            runtime = _state.runtime = ThreadRuntime()
    except Exception:
        awaitable.close()
        raise RuntimeError("async_runtime_unavailable") from None
    return runtime.run(awaitable)
