"""Synthetic-only service and Flask boundary tests. Never import app.py."""
import functools
import json
import sys
import tempfile
import threading
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from flask import Flask, jsonify, request
from traffic_counts.service import TrafficReports, InvalidRequest, Busy, chunks, validate_request, csv_export, _sum_rows
from traffic_counts.routes import make_blueprint

NOW = datetime(2026, 10, 14, 12, tzinfo=timezone.utc)
BODY = {"start": "2026-10-12T23:30:00+05:30", "end": "2026-10-13T01:00:00+05:30",
        "timezone": "Asia/Kolkata", "sources": ["ecom_ingress"]}


def fixture(*_):
    return {"status": "complete", "rows": [{"scope": "All traffic", "counts": {"200": 9, "500": 1},
                                             "total": 10, "unclassified": 0}], "notes": []}


class TestService(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.reports = TrafficReports(self.tmp.name, collect=fixture,
            configured=lambda: {"ecom_ingress": True}, clock=lambda: NOW.timestamp())

    def tearDown(self):
        self.reports.close()
        self.tmp.cleanup()

    def finish(self, body=None):
        result = self.reports.start(body or BODY)
        self.reports.close()
        return self.reports.get(result["id"])

    def test_date_validation(self):
        normalized, start, end = validate_request(BODY, NOW)
        self.assertEqual(normalized["start"], "2026-10-12T18:00:00Z")
        self.assertEqual((end-start).total_seconds(), 5400)
        for edit in ({"start": "2026-10-12T18:00:00"}, {"start": "2026-10-12T18:00:01Z"},
                     {"sources": ["ecom_ingress", "ecom_ingress"]}, {"timezone": "Europe/London"},
                     {"end": "2026-10-15T00:00:00Z"}, {"start": "2026-09-01T00:00:00Z"},
                     {"start": "2026-07-01T00:00:00Z"}, {"sources": ["https://private"]}):
            with self.subTest(edit=edit), self.assertRaises(InvalidRequest):
                validate_request(dict(BODY, **edit), NOW)

    def test_disjoint_chunks_split_at_ist_midnight(self):
        normalized, start, end = validate_request(BODY, NOW)
        intervals = list(chunks(start, end, normalized["timezone"]))
        self.assertEqual(len(intervals), 3)
        self.assertEqual(intervals[0][0], start)
        self.assertEqual(intervals[-1][1], end)
        self.assertEqual(sum((b-a).total_seconds() for a,b,_ in intervals), 5400)
        self.assertEqual([d for _,_,d in intervals], ["2026-10-12", "2026-10-13", "2026-10-13"])
        self.assertTrue(all(intervals[i][1] == intervals[i+1][0] for i in range(len(intervals)-1)))

    def test_totals_daily_and_cache(self):
        result = self.finish()
        self.assertEqual(result["status"], "complete")
        source = result["sources"][0]
        self.assertEqual(source["totals"][0]["total"], 30)
        self.assertEqual([d["rows"][0]["total"] for d in source["daily"]], [10, 20])
        self.assertEqual(source["coverage"], {"expected": 3, "observed": 3})
        self.assertTrue(self.reports.start(BODY)["cached"])
        self.assertNotIn("key", result)

    def test_failure_never_healthy_zero(self):
        def collect(_sid, start, _end):
            if start.minute == 30:
                raise RuntimeError("SECRET_SENTINEL")
            return fixture()
        self.reports.collect = collect
        result = self.finish()
        source = result["sources"][0]
        self.assertEqual(source["status"], "partial")
        self.assertEqual(source["totals"][0]["total"], 20)
        self.assertEqual(source["coverage"]["observed"], 2)
        self.assertNotIn("SECRET_SENTINEL", json.dumps(result))
        self.assertNotIn("SECRET_SENTINEL", csv_export(result))

    def test_unconfigured_and_null_macula(self):
        result = self.finish(dict(BODY, sources=["macula_gateway"]))
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["sources"][0]["totals"], [])
        self.assertIn("Not Available", csv_export(result))
        self.assertEqual(result["sources"][0]["granularity"], "status_group")

    def test_single_flight_busy(self):
        release = threading.Event()
        def waiting(*args):
            release.wait(2)
            return fixture()
        self.reports.collect = waiting
        try:
            first = self.reports.start(BODY)
            self.assertEqual(self.reports.start(BODY)["id"], first["id"])
            with self.assertRaises(Busy):
                self.reports.start(dict(BODY, start="2026-10-12T22:30:00+05:30"))
        finally:
            release.set()

    def test_restart_does_not_resume_jobs_automatically(self):
        rid = "a" * 32
        self.reports._write("reports", rid, {"id": rid, "status": "running"})
        self.assertEqual(self.reports.get(rid)["status"], "failed")
        self.assertIsNone(self.reports._executor)
        self.assertIsNone(self.reports.get("../secret"))

    def test_catalog_notes_not_mutated(self):
        before = self.reports.metadata()
        self.finish(dict(BODY, sources=["macula_gateway"]))
        self.assertEqual(before, self.reports.metadata())

    def test_persisted_cache_reused(self):
        self.finish()
        other = TrafficReports(self.tmp.name, collect=lambda *_: self.fail("cache missed"),
                               configured=lambda: {"ecom_ingress": True}, clock=lambda: NOW.timestamp())
        try:
            rid = other.start(BODY)["id"]
            other.close()
            self.assertEqual(other.get(rid)["sources"][0]["cachedChunks"], 3)
        finally:
            other.close()

    def test_row_limit_is_atomic(self):
        rows = {(str(n), ""): {"scope": str(n), "counts": {"200": 1}, "total": 1,
                               "unclassified": 0} for n in range(500)}
        before = json.dumps(list(rows.values()), sort_keys=True)
        with self.assertRaises(ValueError):
            _sum_rows(rows, [{"scope": "0", "counts": {"200": 8}, "total": 8},
                             {"scope": "extra", "counts": {"200": 1}, "total": 1}])
        self.assertEqual(json.dumps(list(rows.values()), sort_keys=True), before)

    def test_empty_old_logs_do_not_skip_newer_chunks(self):
        calls = []
        def collect(*args):
            calls.append(args)
            return ({"status": "unavailable", "rows": [], "error": "log_data_missing"}
                    if len(calls) <= 3 else fixture())
        self.reports.collect = collect
        result = self.finish(dict(BODY, start="2026-10-12T21:30:00+05:30"))
        self.assertGreater(len(calls), 3)
        self.assertEqual(result["sources"][0]["status"], "partial")


class TestRoutes(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.reports = TrafficReports(self.tmp.name, collect=fixture, configured=lambda: {}, clock=lambda: NOW.timestamp())
        def auth(*roles):
            def decorator(fn):
                @functools.wraps(fn)
                def wrapped(*args, **kwargs):
                    if request.headers.get("X-Test-Role") not in roles:
                        return jsonify(message="forbidden"), 403
                    return fn(*args, **kwargs)
                return wrapped
            return decorator
        app = Flask(__name__)
        app.register_blueprint(make_blueprint(self.reports, auth))
        self.client = app.test_client()
        self.headers = {"X-Test-Role": "viewer", "X-Traffic-Request": "1"}

    def tearDown(self):
        self.reports.close()
        self.tmp.cleanup()

    def test_auth_every_route(self):
        for path in ("/sources", "/reports/" + "a"*32, "/reports/" + "a"*32 + "/export.csv"):
            self.assertEqual(self.client.get("/api/insights/traffic"+path).status_code, 403)
        self.assertEqual(self.client.post("/api/insights/traffic/reports", json=BODY).status_code, 403)
        self.assertEqual(self.client.get("/api/insights/traffic/sources", headers=self.headers).status_code, 200)

    def test_csrf_validation_and_export(self):
        path = "/api/insights/traffic/reports"
        self.assertEqual(self.client.post(path, json=BODY, headers={"X-Test-Role": "viewer"}).status_code, 403)
        self.assertEqual(self.client.post(path, json=BODY, headers=dict(self.headers, Origin="https://evil.test")).status_code, 403)
        response = self.client.post(path, json=BODY, headers=self.headers)
        self.assertEqual(response.status_code, 202)
        self.reports.close()
        export = self.client.get(path+"/"+response.json["id"]+"/export.csv", headers=self.headers)
        self.assertEqual(export.status_code, 200)
        self.assertEqual(export.headers["Cache-Control"], "no-store")
        self.assertIn("Not Available", export.text)


if __name__ == "__main__":
    unittest.main()
