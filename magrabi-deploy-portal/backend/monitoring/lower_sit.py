"""Versioned portal Lower Tempo adapter. No credential load, network at construction or app import.

Live GET checks on 2026-09-09 verified Tempo 2.5 legacy base64 span/trace IDs.
The public route still uses canonical 32-character hex IDs. Do not guess payload encoding.
"""
from .api import create_monitoring_blueprint
from .trace_model import TracePolicy, SIT_SERVICES

LOWER_LOKI_UID = "P8E80F9AEF21F6940"


def create_lower_sit_blueprint(*, current_role, read_trace=None, enabled=False, dashboard_reader=None,
        service_map_reader=None, rum_reader=None, traffic_reader=None):
    if not callable(current_role):
        raise TypeError("trusted_role_callback_required")

    def identity():
        role = current_role()
        return {"role": role} if role else None

    return create_monitoring_blueprint(identity=identity, read_trace=read_trace, enabled=enabled,
        policy=TracePolicy(SIT_SERVICES, id_encoding="base64"), loki_datasource_uid=LOWER_LOKI_UID, dashboard_reader=dashboard_reader,
        service_map_reader=service_map_reader, rum_reader=rum_reader, traffic_reader=traffic_reader)
