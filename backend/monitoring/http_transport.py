"""Stateless, allowlisted HTTP reads with cancellable whole-stream deadlines.

No shared cookie jar, redirects, retries, environment proxies or upstream error bodies.
Only the isolated monitoring service uses this transport; no deployment app is imported.
"""
import asyncio
import re

import httpx

from .portal_identity import PORTAL_ME
from .tempo_reader import CLUSTER_TEMPO_ORIGIN
from .trace_model import MAX_BYTES
from .async_runtime import run_bounded
from .dashboard_reader import dashboard_transport_profile
from .service_map import transport_profile as service_map_transport_profile
from .rum_reader import transport_profile as rum_transport_profile
from .traffic_reader import transport_profile as traffic_transport_profile


class TransportError(RuntimeError):
    pass


class BufferedResponse:
    def __init__(self, status_code, headers, body=b""):
        self.status_code, self.headers, self._body = status_code, headers, body

    def iter_content(self, chunk_size=8192):
        for start in range(0, len(self._body), chunk_size):
            yield self._body[start:start + chunk_size]

    def close(self):
        self._body = b""


def _profile(url, headers):
    if not isinstance(headers, dict) or headers.get("Accept") != "application/json":
        raise TransportError("invalid_request")
    if url == PORTAL_ME:
        cookie = headers.get("Cookie", "")
        if (set(headers) != {"Accept", "Cookie"} or not isinstance(cookie, str) or
                not re.fullmatch(r"session=[A-Za-z0-9_.-]{1,8192}", cookie)):
            raise TransportError("invalid_identity_request")
        return 4096, 3.0
    prefix = CLUSTER_TEMPO_ORIGIN + "/api/traces/"
    if (isinstance(url, str) and url.startswith(prefix) and
            re.fullmatch(r"[0-9a-f]{32}", url[len(prefix):]) and
            url[len(prefix):] != "0" * 32 and set(headers) == {"Accept"}):
        return MAX_BYTES, 10.0
    if isinstance(url, str) and set(headers) == {"Accept"}:
        profile = dashboard_transport_profile(url)
        if profile: return profile
        # The service map is a second exact-query allowlist entry, not a relaxation of this gate:
        # it matches one fixed PromQL string with a current timestamp and nothing else.
        profile = service_map_transport_profile(url)
        if profile: return profile
        # RUM: seven fixed LogQL strings against Loki, each with a current timestamp. Same gate style.
        profile = rum_transport_profile(url)
        if profile: return profile
        profile = traffic_transport_profile(url)
        if profile: return profile
    raise TransportError("unsupported_upstream")


async def _fetch(url, *, headers, max_bytes, deadline, client_factory=httpx.AsyncClient):
    try:
        # Includes connect, headers and every chunk; continuous trickling cannot extend it.
        async with asyncio.timeout(deadline):
            async with client_factory(trust_env=False, follow_redirects=False,
                    timeout=httpx.Timeout(deadline, connect=min(2.0, deadline)),
                    limits=httpx.Limits(max_connections=1, max_keepalive_connections=0)) as client:
                async with client.stream("GET", url, headers={**headers, "Accept-Encoding": "identity"}) as response:
                    safe_headers = {key: response.headers[key] for key in ("Content-Type", "Content-Length")
                        if key in response.headers}
                    result = BufferedResponse(response.status_code, safe_headers)
                    if response.status_code != 200:
                        return result  # Never read an error/redirect response body.
                    if safe_headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
                        raise TransportError("invalid_content_type")
                    length = safe_headers.get("Content-Length")
                    if length is not None and (not re.fullmatch(r"[0-9]{1,12}", length) or int(length) > max_bytes):
                        raise TransportError("response_too_large")
                    # Reject compression so a compressed body cannot inflate before our byte cap.
                    if response.headers.get("Content-Encoding", "identity").strip().lower() not in ("", "identity"):
                        raise TransportError("unsupported_encoding")
                    body = bytearray()
                    async for chunk in response.aiter_raw(chunk_size=8192):
                        if len(body) + len(chunk) > max_bytes:
                            raise TransportError("response_too_large")
                        body.extend(chunk)
                    result._body = bytes(body)
                    return result
    except TimeoutError:
        raise TransportError("upstream_deadline") from None
    except TransportError:
        raise
    except Exception:
        raise TransportError("upstream_unavailable") from None


def stateless_get(url, *, headers, allow_redirects=False, stream=True, timeout=(2, 10)):
    max_bytes, deadline = _profile(url, headers)
    if allow_redirects is not False or stream is not True:
        raise TransportError("invalid_request")
    if (not isinstance(timeout, tuple) or len(timeout) != 2 or
            any(type(t) not in (int, float) or not 0 < t <= 15 for t in timeout)):
        raise TransportError("invalid_timeout")
    return run_bounded(_fetch(url, headers=headers, max_bytes=max_bytes, deadline=min(deadline, timeout[1])))
