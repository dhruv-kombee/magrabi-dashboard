"""Read-only synthetic results adapter. No browser, scheduler or customer credentials.

Only one fixed internal service is reachable. Bearer credentials never leave this process;
arbitrary URLs, response fields and exception text are never returned to the browser.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import json
from pathlib import Path
import re

import httpx

from .async_runtime import run_bounded

ORIGIN = "http://synthetic-results.observability.svc.cluster.local:5153"
TOKEN_FILE = "/run/secrets/synthetic-results/api-token"
MAX_BYTES = 256_000
STEPS = ("site", "login", "product", "cart", "shipping", "payment", "return", "cleanup")
REASONS = frozenset({"none", "not_configured", "auth_failed", "mfa_required", "site_unavailable",
    "selector_changed", "no_stock", "stock_changed", "cart_not_empty", "cart_verification_failed",
    "shipping_failed", "payment_boundary_not_approved", "payment_not_reached", "forbidden_payment_action",
    "unexpected_origin", "step_timeout", "run_timeout", "cleanup_failed", "runner_lost",
    "concurrent_run", "internal_error", "results_unavailable"})
RUN_STATUSES = frozenset({"running", "passed", "failed", "blocked", "interrupted"})
RUN_KEYS = frozenset({"run_id", "site_id", "environment", "scheduled_at", "started_at", "finished_at",
    "updated_at", "status", "duration_ms", "candidate_attempts", "payment_boundary", "cleanup_status", "steps"})
SUMMARY_KEYS = frozenset({"schema_version", "site_id", "environment", "generated_at", "schedule_enabled",
    "interval_minutes", "state", "last_run_at", "next_run_at", "summary", "runs", "pagination"})


class SyntheticError(ValueError):
    pass


def _fail():
    raise SyntheticError("synthetic_payload_invalid")


def _keys(value, keys):
    if type(value) is not dict or set(value) != set(keys): _fail()


def _integer(value, low, high, nullable=False):
    if nullable and value is None: return
    if type(value) is not int or not low <= value <= high: _fail()


def _time(value, nullable=False):
    if nullable and value is None: return None
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z", value): _fail()
    try: return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError: _fail()


def _run(value, generated):
    _keys(value, RUN_KEYS)
    if not isinstance(value["run_id"], str) or not re.fullmatch(r"[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}", value["run_id"]): _fail()
    if value["site_id"] != "magrabi-sit" or value["environment"] != "sit": _fail()
    if type(value["status"]) is not str or value["status"] not in RUN_STATUSES: _fail()
    scheduled, started, updated = (_time(value[k]) for k in ("scheduled_at", "started_at", "updated_at"))
    finished = _time(value["finished_at"], True)
    if scheduled > started or started > updated or (updated - generated).total_seconds() > 5 or (updated - started).total_seconds() > 900: _fail()
    if finished is not None and not started <= finished <= updated: _fail()
    _integer(value["duration_ms"], 0, 900_000, True)
    _integer(value["candidate_attempts"], 0, 5)
    if value["payment_boundary"] not in ("checkout_only", "gateway_reached"): _fail()
    if value["cleanup_status"] not in ("not_started", "verified", "failed", "not_needed"): _fail()
    if type(value["steps"]) is not list or len(value["steps"]) != len(STEPS): _fail()
    for step, name in zip(value["steps"], STEPS):
        _keys(step, {"id", "status", "duration_ms", "http_status", "reason_code"})
        if step["id"] != name or step["status"] not in ("pending", "running", "passed", "failed", "blocked", "skipped"): _fail()
        if type(step["reason_code"]) is not str or step["reason_code"] not in REASONS: _fail()
        _integer(step["duration_ms"], 0, 900_000, True)
        _integer(step["http_status"], 100, 599, True)
        if step["status"] in ("pending", "running", "passed") and step["reason_code"] != "none": _fail()
        if step["status"] in ("failed", "blocked") and step["reason_code"] == "none": _fail()
        if step["status"] == "passed" and step["http_status"] is not None and step["http_status"] >= 400: _fail()
        if step["status"] not in ("pending", "running") and step["duration_ms"] is None: _fail()
    statuses = [s["status"] for s in value["steps"]]
    if value["status"] == "running":
        if finished is not None or value["duration_ms"] is not None: _fail()
    else:
        if finished is None or value["duration_ms"] is None or any(s in ("pending", "running") for s in statuses): _fail()
        if abs((finished - started).total_seconds() * 1000 - value["duration_ms"]) > 1000: _fail()
    if statuses.count("running") > 1: _fail()
    if value["status"] == "passed" and (statuses != ["passed"] * len(STEPS) or value["cleanup_status"] != "verified"): _fail()
    if value["status"] == "blocked" and ("blocked" not in statuses or "failed" in statuses): _fail()
    if value["status"] == "failed" and "failed" not in statuses: _fail()
    if value["cleanup_status"] == "verified" and statuses[-1] != "passed": _fail()
    if value["cleanup_status"] == "failed" and (statuses[-1] != "failed" or value["steps"][-1]["reason_code"] != "cleanup_failed" or value["status"] not in ("running", "failed", "interrupted")): _fail()
    if value["cleanup_status"] == "not_needed" and statuses[-1] != "skipped": _fail()
    if value["cleanup_status"] == "not_started" and statuses[-1] not in ("pending", "running"): _fail()


def validate_summary(value, *, limit, offset):
    """Fail closed: one unexpected field or invalid row rejects the full response."""
    _keys(value, SUMMARY_KEYS)
    if type(value["schema_version"]) is not int or value["schema_version"] != 1: _fail()
    if value["site_id"] != "magrabi-sit" or value["environment"] != "sit": _fail()
    if type(value["schedule_enabled"]) is not bool: _fail()
    if type(value["interval_minutes"]) is not int or value["interval_minutes"] != 60: _fail()
    if value["state"] not in ("disabled", "ready", "running", "attention_required", "stale"): _fail()
    generated = _time(value["generated_at"])
    last = _time(value["last_run_at"], True)
    upcoming = _time(value["next_run_at"], True)
    if last is not None and last > generated: _fail()
    if upcoming is not None and upcoming < generated: _fail()
    if not value["schedule_enabled"] and value["next_run_at"] is not None: _fail()
    _keys(value["summary"], RUN_STATUSES)
    for count in value["summary"].values(): _integer(count, 0, 100_000)
    if value["summary"]["running"] > 1: _fail()
    page = value["pagination"]
    _keys(page, {"limit", "offset", "total", "has_more"})
    _integer(page["limit"], 1, 50)
    _integer(page["offset"], 0, 10_000)
    _integer(page["total"], 0, 100_000)
    if page["limit"] != limit or page["offset"] != offset or type(page["has_more"]) is not bool: _fail()
    if type(value["runs"]) is not list or len(value["runs"]) > limit: _fail()
    if len(value["runs"]) != min(limit, max(0, page["total"] - offset)): _fail()
    if sum(value["summary"].values()) != page["total"]: _fail()
    if page["has_more"] != (offset + len(value["runs"]) < page["total"]): _fail()
    ids = set()
    for run in value["runs"]:
        _run(run, generated)
        if run["run_id"] in ids: _fail()
        ids.add(run["run_id"])
    for status in RUN_STATUSES:
        if sum(run["status"] == status for run in value["runs"]) > value["summary"][status]: _fail()
    return value


def disabled_summary(limit=20, offset=0):
    return {"schema_version": 1, "site_id": "magrabi-sit", "environment": "sit",
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "schedule_enabled": False, "interval_minutes": 60, "state": "disabled",
        "last_run_at": None, "next_run_at": None, "summary": {s: 0 for s in sorted(RUN_STATUSES)},
        "runs": [], "pagination": {"limit": limit, "offset": offset, "total": 0, "has_more": False}}


async def _fetch(limit, offset, token):
    try:
        async with asyncio.timeout(5):
            async with httpx.AsyncClient(trust_env=False, follow_redirects=False, timeout=httpx.Timeout(5, connect=2)) as client:
                async with client.stream("GET", f"{ORIGIN}/v1/runs?limit={limit}&offset={offset}",
                        headers={"Accept": "application/json", "Accept-Encoding": "identity", "Authorization": "Bearer " + token}) as response:
                    if response.status_code != 200: raise SyntheticError("synthetic_results_unavailable")
                    if response.headers.get("Content-Type", "").split(";", 1)[0].lower() != "application/json": _fail()
                    if response.headers.get("Content-Encoding", "identity") != "identity": _fail()
                    declared = response.headers.get("Content-Length")
                    if declared is not None and (not re.fullmatch(r"\d{1,12}", declared) or int(declared) > MAX_BYTES): _fail()
                    body = bytearray()
                    async for chunk in response.aiter_raw(chunk_size=8192):
                        if len(body) + len(chunk) > MAX_BYTES: _fail()
                        body.extend(chunk)
                    return json.loads(body)
    except Exception:
        raise SyntheticError("synthetic_results_unavailable") from None


class SyntheticReader:
    def __init__(self, *, enabled=False, token_file=TOKEN_FILE, fetch=None):
        if type(enabled) is not bool: raise ValueError("invalid_synthetic_configuration")
        self.enabled, self.token_file, self.fetch = enabled, token_file, fetch

    def read(self, *, limit=20, offset=0):
        _integer(limit, 1, 50)
        _integer(offset, 0, 10_000)
        if not self.enabled: return disabled_summary(limit, offset)
        if self.fetch is not None:
            payload = self.fetch(limit=limit, offset=offset)
        else:
            try:
                with Path(self.token_file).open("rb") as handle: raw = handle.read(258)
                token = raw.decode("ascii").strip()
                if not re.fullmatch(r"[A-Za-z0-9_.~-]{32,256}", token): raise ValueError()
                payload = run_bounded(_fetch(limit, offset, token))
            except Exception:
                raise SyntheticError("synthetic_results_unavailable") from None
        return validate_summary(payload, limit=limit, offset=offset)
