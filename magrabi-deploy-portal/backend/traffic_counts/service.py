"""Bounded, on-demand reports over independent telemetry layers.

Only sanitized aggregates are persisted. One collection at a time in the portal's existing
single-worker process; there is no scheduler and no collection at import/startup. Do not import
the parent app to test this module: that app has unrelated deployment background workers.
"""
import copy
import csv
import hashlib
import io
import json
import os
import re
import threading
import time
import uuid
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .catalog import SOURCES
from . import providers

FILTER_VERSION = "2026-10-14-v1-" + providers.FILTER_VERSION
MAX_DAYS = 7
RETENTION_DAYS = 93
TIMEZONES = {"UTC": timezone.utc, "Asia/Kolkata": timezone(timedelta(hours=5, minutes=30))}
MAX_RUN_SECONDS = 3600
REPORT_TTL = 300
HISTORICAL_TTL = 3600
NEGATIVE_TTL = 30
MAX_REPORT_BYTES = 2_000_000
MAX_ROWS_PER_TABLE = 500
ID_PATTERN = re.compile(r"^[a-f0-9]{32}$")


class InvalidRequest(ValueError):
    pass


class Busy(RuntimeError):
    pass


def iso(value):
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def validate_request(body, now=None):
    now = now or datetime.now(timezone.utc)
    if not isinstance(body, dict) or set(body) != {"start", "end", "timezone", "sources"}:
        raise InvalidRequest("Provide start, end, timezone and sources only.")
    zone = body["timezone"]
    if not isinstance(zone, str) or zone not in TIMEZONES:
        raise InvalidRequest("Choose UTC or Asia/Kolkata.")
    bounds = []
    for name in ("start", "end"):
        raw = body[name]
        try:
            if not isinstance(raw, str) or len(raw) > 40:
                raise ValueError()
            value = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            if value.tzinfo is None or value.second or value.microsecond:
                raise ValueError()
            bounds.append(value.astimezone(timezone.utc))
        except (ValueError, TypeError):
            raise InvalidRequest("Dates need an explicit timezone and whole-minute precision.") from None
    start, end = bounds
    if end <= start or end - start > timedelta(days=MAX_DAYS):
        raise InvalidRequest("Choose a positive range of at most 7 days.")
    if end > now or start < now - timedelta(days=RETENTION_DAYS):
        raise InvalidRequest("Choose past dates within the last 93 days. Log retention may be shorter.")
    selected = body["sources"]
    if (not isinstance(selected, list) or not selected or len(selected) > len(SOURCES)
            or any(not isinstance(s, str) or s not in SOURCES for s in selected)
            or len(set(selected)) != len(selected)):
        raise InvalidRequest("Choose one or more distinct, configured source names.")
    return {"start": iso(start), "end": iso(end), "timezone": zone,
            "sources": [key for key in SOURCES if key in selected]}, start, end


def chunks(start, end, zone):
    """Disjoint <=1h intervals, additionally split at reporting-day boundaries."""
    cursor = start
    tz = TIMEZONES[zone]
    while cursor < end:
        local = cursor.astimezone(tz)
        midnight = datetime.combine(local.date() + timedelta(days=1), datetime.min.time(), tz)
        # Clock-hour alignment makes successful chunks reusable across later overlapping reports.
        next_hour = (cursor.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1))
        stop = min(end, next_hour, midnight.astimezone(timezone.utc))
        yield cursor, stop, local.date().isoformat()
        cursor = stop


def _sum_rows(dest, incoming):
    keys = {(row["scope"], row.get("trafficClass", "")) for row in incoming}
    if len(set(dest) | keys) > MAX_ROWS_PER_TABLE:
        raise ValueError("aggregate_row_limit")
    for row in incoming:
        key = (row["scope"], row.get("trafficClass", ""))
        if key not in dest and len(dest) >= MAX_ROWS_PER_TABLE:
            raise ValueError("aggregate_row_limit")
        item = dest.setdefault(key, {"scope": key[0], "counts": {}, "total": None,
                                    "unclassified": None})
        if key[1]:
            item["trafficClass"] = key[1]
        for field in ("total", "unclassified"):
            value = row.get(field)
            if value is not None:
                item[field] = (item[field] or 0) + value
        for code, value in row.get("counts", {}).items():
            if value is not None:
                item["counts"][code] = (item["counts"].get(code) or 0) + value
            else:
                item["counts"].setdefault(code, None)


def csv_export(report):
    """No cross-layer sum; exact codes and unavailable groups remain distinguishable."""
    buffer = io.StringIO(newline="")
    writer = csv.writer(buffer)
    writer.writerow(["Source", "Layer", "Section", "Date", "Scope", "Traffic class", "Status",
                     "Total", "HTTP code / group", "Count", "Unclassified", "Start UTC", "End UTC",
                     "Timezone", "Chunks observed", "Chunks expected", "Fetched UTC", "Notes"])
    def safe(value):
        value = str(value)
        return "'" + value if value.startswith(("=", "+", "-", "@", "\t", "\r")) else value
    for source in report["sources"]:
        sections = [("Summary", "", source.get("totals", []), source["status"], source["coverage"])]
        sections += [("Daily", d["date"], d["rows"], d["status"], d["coverage"])
                     for d in source.get("daily", [])]
        for section, date, rows, status, coverage in sections:
            for row in rows or [{"scope": "No available observations", "counts": {}, "total": None}]:
                for code, count in sorted(row.get("counts", {}).items()) or [("Not Available", None)]:
                    writer.writerow([safe(source["label"]), source["layer"], section, date,
                        safe(row["scope"]), row.get("trafficClass", ""), status,
                        row.get("total") if row.get("total") is not None else "Not Available", code,
                        count if count is not None else "Not Available",
                        row.get("unclassified") if row.get("unclassified") is not None else "Not Available",
                        report["range"]["start"], report["range"]["end"], report["range"]["timezone"],
                        coverage["observed"], coverage["expected"], report.get("generatedAt", ""),
                        safe(" ".join(source.get("notes", [])))])
    return "\ufeff" + buffer.getvalue()


class TrafficReports:
    def __init__(self, directory, collect=None, configured=None, clock=time.time):
        self.directory = Path(directory)
        self.collect = collect or providers.collect
        self.configured = configured or providers.configured_sources
        self.clock = clock
        self._lock = threading.RLock()
        self._executor = None
        self._active = None
        self._reports = OrderedDict()

    def metadata(self):
        configured = self.configured()
        return {"sources": [dict(copy.deepcopy(value), configured=bool(configured.get(key)))
                            for key, value in SOURCES.items()], "maxDays": MAX_DAYS,
                "retentionDays": RETENTION_DAYS, "timezones": list(TIMEZONES),
                "filterVersion": FILTER_VERSION}

    def _write(self, folder, key, doc):
        encoded = json.dumps(doc, ensure_ascii=True, separators=(",", ":"))
        if len(encoded) > MAX_REPORT_BYTES:
            raise ValueError("aggregate_size_limit")
        target = self.directory / folder
        target.mkdir(parents=True, exist_ok=True)
        path = target / (key + ".json")
        temp = target / (key + ".tmp")
        temp.write_text(encoded, encoding="utf-8")
        os.replace(temp, path)

    def _read(self, folder, key):
        path = self.directory / folder / (key + ".json")
        try:
            if path.stat().st_size > MAX_REPORT_BYTES:
                return None
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def _trim(self):
        # Only generated hash/UUID filenames, inside this feature's exact subdirectories.
        for folder, maximum in (("reports", 20), ("chunks", 2000)):
            directory = self.directory / folder
            if not directory.exists():
                continue
            files = [p for p in directory.glob("*.json") if re.fullmatch(r"[a-f0-9]{32,64}\.json", p.name)]
            for path in sorted(files, key=lambda p: p.stat().st_mtime, reverse=True)[maximum:]:
                path.unlink(missing_ok=True)

    def start(self, body):
        normalized, start, end = validate_request(body, datetime.fromtimestamp(self.clock(), timezone.utc))
        key = hashlib.sha256((FILTER_VERSION + json.dumps(normalized, sort_keys=True)).encode()).hexdigest()
        with self._lock:
            for previous in reversed(list(self._reports.values())):
                if previous["key"] == key and (previous["status"] == "running" or (
                        previous["status"] == "complete" and self.clock() - previous["finishedEpoch"] < REPORT_TTL)):
                    return {"id": previous["id"], "status": previous["status"], "cached": True}
            if self._active:
                raise Busy("Another traffic report is collecting. Wait for it to finish before starting another range.")
            self._trim()
            intervals = list(chunks(start, end, normalized["timezone"]))
            sources = []
            for sid in normalized["sources"]:
                days = sorted({day for _, _, day in intervals})
                sources.append(dict(copy.deepcopy(SOURCES[sid]), status="pending", totals=[],
                    coverage={"expected": len(intervals), "observed": 0},
                    daily=[{"date": day, "rows": [], "status": "pending", "coverage": {
                        "expected": sum(1 for _, _, d in intervals if d == day), "observed": 0}}
                        for day in days]))
            rid = uuid.uuid4().hex
            report = {"id": rid, "key": key, "status": "running", "range": {
                k: normalized[k] for k in ("start", "end", "timezone")}, "generatedAt": None,
                "filterVersion": FILTER_VERSION, "startedAt": iso(datetime.fromtimestamp(self.clock(), timezone.utc)),
                "progress": {"completed": 0, "total": len(sources) * len(intervals)}, "sources": sources,
                "notes": ["Layers overlap. Never add different source totals.",
                          "HTTP success is not proof that an order or payment succeeded."]}
            self._write("reports", rid, report)
            self._reports[rid] = report
            self._active = rid
            if self._executor is None:
                self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="traffic-counts")
            self._executor.submit(self._run, rid, intervals)
            while len(self._reports) > 2:
                self._reports.popitem(last=False)
            return {"id": rid, "status": "running", "cached": False}

    def get(self, rid):
        if not isinstance(rid, str) or not ID_PATTERN.fullmatch(rid):
            return None
        with self._lock:
            report = self._reports.get(rid)
            if report is None:
                report = self._read("reports", rid)
                if report and report["status"] == "running":
                    report["status"] = "failed"
                    report["error"] = "Collection was interrupted by a portal restart. Run the report again."
                    for source in report.get("sources", []):
                        if source["status"] in ("running", "pending"):
                            source["status"] = "partial" if any(r.get("total") is not None for r in source["totals"]) else "unavailable"
                            for daily in source["daily"]:
                                daily["status"] = ("complete" if daily["coverage"]["observed"] == daily["coverage"]["expected"] else
                                                   "partial" if any(r.get("total") is not None for r in daily["rows"]) else "unavailable")
            if report:
                result = copy.deepcopy(report)
                result.pop("key", None)
                result.pop("finishedEpoch", None)
                return result
        return None

    def _chunk(self, sid, start, end):
        key = hashlib.sha256(f"{FILTER_VERSION}|{sid}|{iso(start)}|{iso(end)}".encode()).hexdigest()
        saved = self._read("chunks", key)
        ttl = HISTORICAL_TTL if end.timestamp() < self.clock() - HISTORICAL_TTL else REPORT_TTL
        if saved and saved.get("result", {}).get("status") != "complete":
            ttl = NEGATIVE_TTL
        if saved and 0 <= self.clock() - saved["at"] < ttl:
            result = saved["result"]
            result["cached"] = True
            return result
        try:
            result = self.collect(sid, start, end)
        except Exception:
            # Upstream exception strings may embed URLs/credentials. Never persist/return them.
            result = {"status": "unavailable", "rows": [], "notes": [], "error": "provider_query_failed"}
        result["fetchedAt"] = iso(datetime.fromtimestamp(self.clock(), timezone.utc))
        self._write("chunks", key, {"at": self.clock(), "result": result})
        return result

    def _run(self, rid, intervals):
        deadline = time.monotonic() + MAX_RUN_SECONDS
        try:
            report = self._reports[rid]
            configured = self.configured()
            for source in report["sources"]:
                totals, by_day = {}, {d["date"]: {} for d in source["daily"]}
                successes = 0
                unavailable_streak = 0
                with self._lock:
                    source["status"] = "running"
                for start, end, day in intervals:
                    if time.monotonic() > deadline:
                        raise TimeoutError()
                    result = self._chunk(source["id"], start, end) if configured.get(source["id"]) and unavailable_streak < 3 else {
                        "status": "unavailable", "rows": [], "notes": ["Server-side source credentials are not configured."],
                        "error": "not_configured"}
                    if unavailable_streak >= 3:
                        result = {"status": "unavailable", "rows": [], "error": "source_backoff",
                                  "notes": ["Stopped querying this source after three unavailable chunks. Run again later to retry."]}
                    # Missing retained data is not a transport failure: later chunks may exist.
                    transport_failure = result.get("error") in {
                        "access_denied", "authentication_failed", "upstream_unavailable",
                        "upstream_timeout", "provider_query_failed", "source_backoff"}
                    unavailable_streak = unavailable_streak + 1 if transport_failure else 0
                    with self._lock:
                        daily = next(d for d in source["daily"] if d["date"] == day)
                        _sum_rows(totals, result.get("rows", []))
                        _sum_rows(by_day[day], result.get("rows", []))
                        if result["status"] == "complete":
                            successes += 1
                            daily["coverage"]["observed"] += 1
                        for note in result.get("notes", []):
                            if note not in source["notes"]:
                                source["notes"].append(note)
                        if result.get("error"):
                            source["error"] = result["error"]
                        source["totals"] = list(totals.values())
                        source["coverage"]["observed"] = successes
                        source["fetchedAt"] = result.get("fetchedAt")
                        if result.get("fetchedAt"):
                            source["oldestFetchedAt"] = min(source.get("oldestFetchedAt", result["fetchedAt"]), result["fetchedAt"])
                            source["newestFetchedAt"] = max(source.get("newestFetchedAt", result["fetchedAt"]), result["fetchedAt"])
                        daily["rows"] = list(by_day[day].values())
                        source["cachedChunks"] = source.get("cachedChunks", 0) + int(result.get("cached", False))
                        report["progress"]["completed"] += 1
                        if len(json.dumps(report, ensure_ascii=True, separators=(",", ":"))) > MAX_REPORT_BYTES:
                            raise ValueError("aggregate_size_limit")
                with self._lock:
                    source["status"] = ("complete" if successes == len(intervals) else
                                         "partial" if any(r["total"] is not None for r in totals.values()) else "unavailable")
                    for daily in source["daily"]:
                        daily["status"] = ("complete" if daily["coverage"]["observed"] == daily["coverage"]["expected"]
                                           else "partial" if any(r["total"] is not None for r in daily["rows"]) else "unavailable")
                    if source["status"] != "complete":
                        source["notes"].append("Incomplete coverage. Shown numbers are observed subtotals, not full-range totals.")
                    self._write("reports", rid, report)
            with self._lock:
                statuses = [s["status"] for s in report["sources"]]
                report["status"] = ("complete" if all(s == "complete" for s in statuses) else
                                     "failed" if all(s == "unavailable" for s in statuses) else "partial")
        except Exception:
            with self._lock:
                report = self._reports[rid]
                report["status"] = "failed"
                report["error"] = "Collection stopped. Completed source results are retained; run again to retry."
                for source in report["sources"]:
                    if source["status"] in ("running", "pending"):
                        source["status"] = "partial" if any(r.get("total") is not None for r in source["totals"]) else "unavailable"
                        for daily in source["daily"]:
                            daily["status"] = ("complete" if daily["coverage"]["observed"] == daily["coverage"]["expected"]
                                               else "partial" if any(r.get("total") is not None for r in daily["rows"]) else "unavailable")
                if len(json.dumps(report, ensure_ascii=True, separators=(",", ":"))) > MAX_REPORT_BYTES:
                    # Fail closed rather than persist or serve a silently truncated full-range report.
                    for source in report["sources"]:
                        source.update(totals=[], daily=[], status="unavailable", error="aggregate_size_limit")
                    report["error"] = "Report exceeded the aggregate-size limit. Select a shorter range or fewer sources."
        finally:
            with self._lock:
                report["generatedAt"] = iso(datetime.fromtimestamp(self.clock(), timezone.utc))
                report["finishedEpoch"] = self.clock()
                try:
                    self._write("reports", rid, report)
                finally:
                    self._active = None

    def close(self):
        """Only for controlled shutdown/tests; no network or collection is started here."""
        if self._executor:
            self._executor.shutdown(wait=True)
