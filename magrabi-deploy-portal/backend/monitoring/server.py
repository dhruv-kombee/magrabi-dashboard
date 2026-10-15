"""Isolated monitoring HTTP service: no deployment jobs, secret files or background workers.

Same-host prefixes can route here while the existing portal continues unchanged. Identity
verification delegates to that portal. Internal Tempo is read-only; no Grafana password needed.
"""
from pathlib import Path
from flask import Flask, jsonify, request, send_from_directory

from .lower_sit import create_lower_sit_blueprint
from .portal_identity import PortalIdentity
from .tempo_reader import TempoTraceReader, CLUSTER_TEMPO_ORIGIN
from .request_budget import RequestBudget
from .dashboard_reader import DashboardReader
from .service_map import ServiceMapReader
from .rum_reader import RumReader
from .traffic_reader import TrafficReader
from .synthetic_api import create_synthetic_blueprint


def create_app(*, identity_get, tempo_get, enabled=False, static_dir=None, dashboard_get=None, synthetic_reader=None):
    app = Flask("isolated_sit_monitoring", static_folder=None)
    # Keep a fast burst from putting unbounded QPS on the existing single-worker portal or Tempo.
    # Budgets are per process; deployment is deliberately one worker/one replica, no HPA/surge.
    identity = PortalIdentity(get=RequestBudget(burst=8, per_second=2).wrap(identity_get))
    reader = TempoTraceReader(get=RequestBudget(burst=2, per_second=0.5).wrap(tempo_get),
        base_url=CLUSTER_TEMPO_ORIGIN, transport="cluster")
    static_dir = Path(static_dir) if static_dir else Path(__file__).with_name("static")
    def current_role(): return identity(request.cookies.get("session"))
    dashboard_reader = DashboardReader(get=RequestBudget(burst=2, per_second=0.2).wrap(dashboard_get)) if dashboard_get else None
    # Its own budget: a map refresh must never spend the endpoint dashboard's allowance, or one
    # screen open in a second tab starves the other.
    service_map_reader = ServiceMapReader(get=RequestBudget(burst=2, per_second=0.2).wrap(dashboard_get)) if dashboard_get else None
    # Seven Loki reads per refresh, cached for 60 s: the burst covers one refresh, the rate covers
    # the cadence with margin, and neither spends the dashboard's or the map's allowance.
    rum_reader = RumReader(get=RequestBudget(burst=8, per_second=0.5).wrap(dashboard_get)) if dashboard_get else None
    # Traffic has its own five-read burst and global budget. It cannot spend the trace lookup,
    # dashboard, RUM or service-map budgets. One selected site refresh is cached for ten seconds.
    traffic_reader = TrafficReader(get=tempo_get) if dashboard_get else None
    app.register_blueprint(create_lower_sit_blueprint(current_role=current_role, read_trace=reader, enabled=enabled,
        dashboard_reader=dashboard_reader, service_map_reader=service_map_reader, rum_reader=rum_reader,
        traffic_reader=traffic_reader))
    app.register_blueprint(create_synthetic_blueprint(current_role=current_role, reader=synthetic_reader))

    @app.before_request
    def html_gate():
        if request.path == "/monitoring" or request.path == "/monitoring/" or request.path.startswith("/monitoring-assets/"):
            try: role = current_role()
            except Exception: return jsonify(error="authentication_unavailable"), 503
            if not role: return jsonify(error="authentication_required"), 401
            if role != "admin": return jsonify(error="admin_required"), 403

    @app.after_request
    def headers(response):
        response.headers["Cache-Control"] = "private, no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "same-origin"
        response.headers["X-Frame-Options"] = "DENY"
        # No upstream Set-Cookie is relayed; this service cannot create/refresh portal sessions.
        return response

    @app.get("/healthz")
    def health(): return jsonify(status="ok", monitoring_enabled=enabled)

    @app.get("/monitoring")
    @app.get("/monitoring/")
    def page(): return send_from_directory(static_dir, "index.html")

    @app.get("/monitoring-assets/<path:filename>")
    def assets(filename): return send_from_directory(static_dir, filename)

    return app
