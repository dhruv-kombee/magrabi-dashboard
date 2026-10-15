"""Delegate cookie verification to the existing portal; no signing key or user database copy.

The incoming role is NEVER accepted from a header. Only the portal's fixed private /api/me
response is trusted. Pass a fresh stateless GET function, not a cross-user requests.Session.
"""
import json
import re
import threading

PORTAL_ME = "http://magrabi-deploy-portal.deploy-portal.svc.cluster.local/api/me"


class PortalIdentityError(RuntimeError):
    pass


class PortalIdentity:
    def __init__(self, *, get):
        if not callable(get): raise TypeError("stateless_get_required")
        self._get = get
        self._slots = threading.BoundedSemaphore(4)

    def __call__(self, session_cookie):
        if not session_cookie: return None
        if not isinstance(session_cookie, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,8192}", session_cookie): return None
        if not self._slots.acquire(blocking=False): raise PortalIdentityError("identity_busy")
        response = None
        try:
            response = self._get(PORTAL_ME, headers={"Accept": "application/json", "Cookie": "session=" + session_cookie},
                allow_redirects=False, stream=True, timeout=(2, 3))
            if response.status_code in (401, 403): return None
            if response.status_code != 200 or response.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
                raise PortalIdentityError("identity_unavailable")
            data = bytearray()
            for chunk in response.iter_content(chunk_size=1024):
                data.extend(chunk)
                if len(data) > 4096: raise PortalIdentityError("identity_unavailable")
            role = json.loads(data).get("role")
            return role if role in ("admin", "viewer") else None
        except Exception:
            raise PortalIdentityError("identity_unavailable") from None
        finally:
            if response is not None:
                try: response.close()
                except Exception: pass
            self._slots.release()
