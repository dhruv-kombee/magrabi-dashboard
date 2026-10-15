"""Admin-only Flask Blueprint. Registration never starts a provider or background worker.

Dependency injection is mandatory: identity must come from the host's verified session,
and trace bytes from a reviewed bounded read-only provider. No default provider, URLs,
credentials, file reads, schedulers or outbound network implementation exist here.
"""
from __future__ import annotations

from collections.abc import Callable, Mapping
from flask import Blueprint, jsonify, request

from .trace_model import MAX_BYTES, SIT_SERVICES, TraceError, ScopeError, TracePolicy, summarize_trace, validate_trace_id
from .log_links import build_log_links


def create_monitoring_blueprint(*, identity: Callable, read_trace: Callable | None = None,
        enabled: bool = False, policy: TracePolicy | None = None, loki_datasource_uid: str | None = None,
        dashboard_reader=None, service_map_reader=None, rum_reader=None, traffic_reader=None) -> Blueprint:
    if not callable(identity):
        raise TypeError("identity_callback_required")
    if type(enabled) is not bool or (enabled and not callable(read_trace)):
        raise ValueError("explicit_provider_required")
    bp = Blueprint("monitoring", __name__, url_prefix="/api/monitoring/v1")

    @bp.before_request
    def gate():
        # This runs before every registered route, including automatic OPTIONS.
        try:
            principal = identity()
        except Exception:
            return jsonify(error="authentication_unavailable"), 503
        if not principal:
            return jsonify(error="authentication_required"), 401
        if not isinstance(principal, Mapping) or principal.get("role") != "admin":
            return jsonify(error="admin_required"), 403
        if request.method not in ("GET", "HEAD", "OPTIONS"):
            return jsonify(error="read_only_endpoint"), 405

    @bp.after_request
    def private_response(response):
        response.headers["Cache-Control"] = "private, no-store"
        response.headers["Pragma"] = "no-cache"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Vary"] = "Cookie"
        return response

    @bp.get("/environments")
    def environments():
        return jsonify(environments=[
            {"id": "sit", "enabled": enabled, "mapping_status": "partial_verified_macula_only",
                "namespaces": sorted((policy.services if policy else SIT_SERVICES))},
            *[{"id": name, "enabled": False, "mapping_status": "not_configured"} for name in ("dev", "beta", "prod")]],
            live_traffic="not_established", service_catalog="not_a_live_health_snapshot")

    @bp.get("/sit/traces/<trace_id>")
    def trace(trace_id):
        try:
            trace_id = validate_trace_id(trace_id)
        except TraceError:
            return jsonify(error="invalid_trace_id"), 400
        if request.args:
            return jsonify(error="unsupported_query_parameters"), 400
        if not enabled:
            return jsonify(error="monitoring_not_configured"), 503
        try:
            raw = read_trace(trace_id, environment="sit", max_bytes=MAX_BYTES, timeout_seconds=10)
        except Exception:
            # Provider exception text may contain auth headers, URLs or backend payloads.
            return jsonify(error="trace_backend_unavailable"), 502
        if raw is None:
            return jsonify(error="trace_not_available", cause="unknown_not_retained_or_not_yet_available"), 404
        try:
            result = summarize_trace(raw, trace_id, policy)
            result["log_correlation"] = (build_log_links(result, loki_uid=loki_datasource_uid)
                if loki_datasource_uid else {"status": "not_configured", "logs_verified": False})
            return jsonify(result)
        except ScopeError:
            # No partially redacted mixed-environment trace is returned.
            return jsonify(error="trace_not_available_in_sit_scope"), 404
        except TraceError:
            return jsonify(error="trace_payload_not_supported"), 502

    @bp.get("/sit/dashboard")
    def dashboard():
        if request.args: return jsonify(error="unsupported_query_parameters"), 400
        if not enabled or dashboard_reader is None: return jsonify(error="dashboard_not_configured"), 503
        try: return jsonify(dashboard_reader.dashboard())
        except Exception: return jsonify(error="dashboard_unavailable"), 502

    @bp.get("/sit/service-map")
    def service_map():
        # The observed call graph. Counted before sampling, so these rates are complete even though
        # the traces a user opens from the map are a sampled subset.
        if request.args: return jsonify(error="unsupported_query_parameters"), 400
        if not enabled or service_map_reader is None: return jsonify(error="service_map_not_configured"), 503
        try: return jsonify(service_map_reader.service_map())
        except Exception: return jsonify(error="service_map_unavailable"), 502

    @bp.get("/sit/rum")
    def rum():
        # Real-user numbers per website from the browser SDK, last hour. Deliberately its own route:
        # the endpoint dashboard's decoder is strict, and a Loki problem must not blank that page.
        if request.args: return jsonify(error="unsupported_query_parameters"), 400
        if not enabled or rum_reader is None: return jsonify(error="rum_not_configured"), 503
        try: return jsonify(rum_reader.rum())
        except Exception: return jsonify(error="rum_unavailable"), 502

    @bp.get("/sit/components/<namespace>/<service>/traces")
    def component_traces(namespace, service):
        from .dashboard_reader import trace_query
        if request.args: return jsonify(error="unsupported_query_parameters"), 400
        if not enabled or dashboard_reader is None: return jsonify(error="dashboard_not_configured"), 503
        try: trace_query(namespace + "/" + service)
        except ValueError: return jsonify(error="component_trace_search_not_configured"), 404
        try: return jsonify(dashboard_reader.traces(namespace + "/" + service))
        except Exception: return jsonify(error="component_trace_search_unavailable"), 502

    @bp.get("/sit/sites/<host>/requests")
    def site_requests(host):
        from .traffic_reader import SITES
        if (set(request.args) - {"window"} or len(request.args.getlist("window")) > 1
                or request.args.get("window", "5m") != "5m"):
            return jsonify(error="unsupported_query_parameters"), 400
        if host not in SITES:
            return jsonify(error="site_not_configured"), 404
        if not enabled or traffic_reader is None:
            return jsonify(error="traffic_not_configured"), 503
        try: return jsonify(traffic_reader.requests(host))
        except Exception: return jsonify(error="traffic_unavailable"), 502

    return bp
