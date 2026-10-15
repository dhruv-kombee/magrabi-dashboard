"""Authenticated reporting routes, independently testable without the deployment app."""
from urllib.parse import urlsplit
import json

from flask import Blueprint, Response, jsonify, request
from .service import Busy, InvalidRequest, csv_export


def make_blueprint(reports, require_role):
    bp = Blueprint("traffic_counts", __name__, url_prefix="/api/insights/traffic")

    @bp.after_request
    def no_cache(response):
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @bp.get("/sources")
    @require_role("admin", "viewer")
    def sources():
        return jsonify(reports.metadata())

    @bp.post("/reports")
    @require_role("admin", "viewer")
    def start():
        # Cross-origin forms cannot trigger costly collections. No CORS is enabled for this API.
        origin = request.headers.get("Origin")
        if (request.headers.get("X-Traffic-Request") != "1" or not request.is_json
                or request.headers.get("Sec-Fetch-Site") == "cross-site"
                or (origin and urlsplit(origin).netloc != request.host)):
            return jsonify(message="Use the same-origin traffic report form."), 403
        if (request.content_length or 0) > 4096:
            return jsonify(message="Report request is too large."), 413
        raw = request.stream.read(4097)
        if len(raw) > 4096:
            return jsonify(message="Report request is too large."), 413
        try:
            body = json.loads(raw)
        except (ValueError, UnicodeError):
            return jsonify(message="Provide a valid JSON report request."), 400
        try:
            result = reports.start(body)
            return jsonify(result), 202 if result["status"] == "running" else 200
        except InvalidRequest as exc:
            return jsonify(message=str(exc)), 400
        except Busy as exc:
            return jsonify(message=str(exc)), 429
        except OSError:
            return jsonify(message="Report storage is unavailable. Ask the portal operator to check the data volume."), 503

    @bp.get("/reports/<rid>")
    @require_role("admin", "viewer")
    def report(rid):
        data = reports.get(rid)
        return (jsonify(data), 200) if data else (jsonify(message="Report not found."), 404)

    @bp.get("/reports/<rid>/export.csv")
    @require_role("admin", "viewer")
    def export(rid):
        data = reports.get(rid)
        if not data:
            return jsonify(message="Report not found."), 404
        if data["status"] == "running":
            return jsonify(message="Wait for collection to finish before exporting."), 409
        return Response(csv_export(data), mimetype="text/csv", headers={
            "Content-Disposition": f'attachment; filename="traffic-counts-{rid}.csv"'})

    return bp
