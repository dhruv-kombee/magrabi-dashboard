"""Explicit isolated Gunicorn entrypoint, never import the deployment portal's app.py."""
import os
from .server import create_app
from .http_transport import stateless_get
from .synthetic_reader import SyntheticReader


app = create_app(identity_get=stateless_get, tempo_get=stateless_get, dashboard_get=stateless_get,
    enabled=os.environ.get("MONITORING_SIT_ENABLED") == "true",
    synthetic_reader=SyntheticReader(enabled=os.environ.get("SYNTHETIC_RESULTS_ENABLED") == "true"))
