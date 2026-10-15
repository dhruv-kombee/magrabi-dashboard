"""Independent admin-only, GET-only synthetic view; never launches a browser job."""
import re
from flask import Blueprint, jsonify, request

from .synthetic_reader import SyntheticReader


def create_synthetic_blueprint(*, current_role, reader=None):
    reader = reader or SyntheticReader()
    bp = Blueprint("synthetic_monitoring", __name__, url_prefix="/api/monitoring/v1/sit")

    @bp.before_request
    def gate():
        try: role = current_role()
        except Exception: return jsonify(error="authentication_unavailable"), 503
        if not role: return jsonify(error="authentication_required"), 401
        if role != "admin": return jsonify(error="admin_required"), 403
        if request.method not in ("GET", "HEAD", "OPTIONS"):
            return jsonify(error="read_only_endpoint"), 405

    @bp.after_request
    def headers(response):
        response.headers["Cache-Control"] = "private, no-store"
        response.headers["Vary"] = "Cookie"
        return response

    @bp.get("/synthetics")
    def list_runs():
        if set(request.args) - {"limit", "offset"}: return jsonify(error="invalid_synthetic_query"), 400
        values = {}
        for key, default, low, high in (("limit", "20", 1, 50), ("offset", "0", 0, 10_000)):
            raw = request.args.get(key, default)
            if len(request.args.getlist(key)) > 1 or not re.fullmatch(r"0|[1-9][0-9]{0,4}", raw):
                return jsonify(error="invalid_synthetic_query"), 400
            value = int(raw)
            if not low <= value <= high: return jsonify(error="invalid_synthetic_query"), 400
            values[key] = value
        try: return jsonify(reader.read(**values))
        except Exception: return jsonify(error="synthetic_results_unavailable"), 502

    return bp
