#!/usr/bin/env python3
"""
Magrabi Deployment Portal -- backend API.

Rebuilt 2026-08-06 from the original local-only prototype (formerly
actual_work_communications/_tools/magrabi_deploy_portal.py) into a pure JSON API meant to be
containerized and run inside the Lower env AKS cluster, served behind a React frontend built in
../frontend. See ../README.md and C:\\Users\\Admin\\.claude\\plans\\tingly-gliding-cocoa.md for the
full rebuild plan.

Everything below PIPELINES/_resolve_pipeline/_refresh_live_status/_refresh_my_deployments/
_parse_deploy_text*/_new_deployment_worker is carried over UNCHANGED from the original prototype --
this logic was hard-won and already debugged across many real deployments; only the auth/serving
layer around it changed.

Auth model (explicit user decision 2026-08-06, overriding an earlier Entra ID recommendation): two
simple app-level accounts, no Azure AD. One admin (full access, including the mutating deploy/approve
routes), one shared "viewer" account for developers (read-only status view only). Credentials come
from environment variables (bcrypt hashes, never plaintext) so the real values live in a Kubernetes
Secret, never in this file or the image. Session state is a signed Flask cookie -- `get_identity()` is
the ONLY function anything else should call to find out who's asking; every route-level check goes
through `require_role()`, which is the actual security boundary. The React frontend's own role-based
UI hiding is cosmetic only and enforces nothing by itself.

This app still holds a real, write-scoped Azure DevOps PAT (loaded the same way as before, from
.secrets/azuredevops.env locally or from a mounted K8s Secret in the cluster) and can still trigger
real deployments to DEV/SIT/UAT via /api/new-deployment and /api/redeploy-approve -- production is
never touched, enforced independently of whatever a caller sends, same as always.
"""

import base64
import functools
import glob
import hashlib
import hmac
import json
import os
import pathlib
import re
import secrets
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests
from flask import Flask, Response, jsonify, request, send_from_directory, session

# ---------------------------------------------------------------------------------------------
# Config / secrets loading
# ---------------------------------------------------------------------------------------------
# Locally: read the same .secrets/azuredevops.env every other tool in this engagement uses.
# In the cluster: the Deployment mounts a Secret as env vars with these same names, so this
# loader only needs to run at all when that file exists -- os.environ already has everything
# otherwise (real env vars from a K8s Secret take precedence over anything a stray .env would set).
# Locally this file lives at .../Forchunex Projects/magrabi-deploy-portal/backend/app.py, so
# parents[2] is the outer project root where .secrets/ lives. In the container the file is copied
# to a flat /app/app.py with no such ancestry -- parents[2] doesn't exist there and would raise
# IndexError before we ever get to check whether the path exists. Guarded so the container path
# (where secrets come from real env vars / a K8s Secret, never a local .env file) just no-ops.
_file_parents = Path(__file__).resolve().parents
ROOT = _file_parents[2] if len(_file_parents) > 2 else Path(__file__).resolve().parent
_LOCAL_SECRETS = ROOT / ".secrets" / "azuredevops.env"
RUNS_DIR = Path(os.environ.get("RUNS_DIR", str(Path(__file__).resolve().parent / "deploy_runs")))
# Feedback lives on the same persistent volume as the runs directory in the cluster (see
# k8s/deployment.yaml -- the PVC is mounted at /data, not at the runs dir, precisely so a second
# directory can sit beside it). Like RUNS_DIR, neither of these is created at import time: the
# directory is made lazily on the first write, so a read-only replica or a cold container never
# touches the volume just by starting up.
FEEDBACK_DIR = Path(os.environ.get("FEEDBACK_DIR", str(Path(__file__).resolve().parent / "feedback")))
FEEDBACK_ATTACHMENTS_DIR = FEEDBACK_DIR / "attachments"
# Tiles an admin has hidden from the Live Deployments board, for EVERYONE. Deliberately a sibling of
# RUNS_DIR rather than a file inside it: the runs directory is globbed as RUNS_DIR/*.json and every
# match is parsed as a deployment run, so a bookkeeping file living there would be read back as a
# malformed row. /data is the PVC mount point (see k8s/deployment.yaml), so a sibling still persists.
HIDDEN_DEPLOYMENTS_FILE = Path(os.environ.get(
    "HIDDEN_DEPLOYMENTS_FILE", str(RUNS_DIR.parent / "hidden_deployments.json")))
API_VERSION = "7.1"


def _load_dotenv_if_present(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_dotenv_if_present(_LOCAL_SECRETS)

ORG = os.environ["ADO_ORG"]
ADO_PAT = os.environ["ADO_PAT"]
AUTH = base64.b64encode(f":{ADO_PAT}".encode()).decode()
HEADERS = {"Authorization": f"Basic {AUTH}", "Accept": "application/json"}

# Flask session signing key -- must come from a real Secret in the cluster (a fresh random value
# generated once at deploy time), never hardcoded there. Locally, falls back to a FIXED,
# clearly-labeled dev-only string rather than a fresh os.urandom() value each process start --
# using a fresh value every time silently invalidated every existing login cookie on every backend
# restart during development (confirmed live 2026-08-07: a restart to ship an unrelated fix logged
# the session out mid-use, but the already-rendered page kept showing stale cached data, so it
# looked like a live 403 bug rather than what it actually was). This fallback is only ever reached
# when SESSION_SECRET_KEY isn't set in the environment, which the real deployment always sets via
# a K8s Secret -- so this fixed string never reaches anything beyond a local `python app.py` run.
# static_folder deliberately NOT passed to Flask() here -- Flask auto-registers its own internal
# static route at the same shape as our custom catch-all below (/<path:filename> vs
# /<path:path>), and that automatic route wins for any path that isn't a literal file on disk
# (confirmed live 2026-08-06: "/status", a client-side React Router path with no matching file,
# hit Flask's own 404 handler before serve_react() ever ran -- "/" and real asset files worked
# fine, since those matched more-specific/literal rules instead). Handling static serving entirely
# inside serve_react() (below) avoids the conflict outright.
STATIC_DIR = Path(__file__).resolve().parent / "static"
app = Flask(__name__)
app.secret_key = os.environ.get("SESSION_SECRET_KEY") or "local-dev-only-fixed-key-never-used-if-SESSION_SECRET_KEY-is-set"
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    # Only force Secure over HTTPS -- set via env once this actually sits behind TLS in the cluster,
    # not before (Flask's local dev server has no TLS, so this must stay False for local dev).
    SESSION_COOKIE_SECURE=os.environ.get("SESSION_COOKIE_SECURE", "false").lower() == "true",
    # Hard ceiling on any request body, enforced by Werkzeug before the handler runs -- an
    # oversized feedback attachment is refused while it is still on the wire rather than buffered
    # into this pod's 256Mi memory limit first. Deliberately well above the 3MB per-attachment
    # limit checked in the route: the framework guard is the backstop for abuse, the route's own
    # check is what produces a useful message for an honest user who picked too big a screenshot.
    MAX_CONTENT_LENGTH=8 * 1024 * 1024,
)


def build_base(project: str) -> str:
    return f"https://dev.azure.com/{ORG}/{project}/_apis"


def release_base(project: str) -> str:
    return f"https://vsrm.dev.azure.com/{ORG}/{project}/_apis"


# ---------------------------------------------------------------------------------------------
# Pipeline registry -- UNCHANGED from the original prototype, carried over verbatim.
# ---------------------------------------------------------------------------------------------
PIPELINES = {
    "doctor-storefront": {
        "project": "ECom", "ci_id": 75, "cd_id": 45, "alias": "_CI-DrM-Storefront",
        # "doctorm-sf" / "doctor-sf" added 2026-09-17: the team pastes the Kubernetes workload name
        # (doctorm-sf), which matched nothing and was skipped as an unknown pipeline.
        "aliases": ["doctor-storefront", "doctorm-storefront", "doctorm storefront",
                    "doctor storefront", "drm-storefront", "drm storefront", "doctorm",
                    "drm-sf", "drm sf", "doctorm-sf", "doctorm sf", "doctor-sf", "doctor sf"],
    },
    "ecom search app": {
        "project": "ECom", "ci_id": 70, "cd_id": 37, "alias": "_CI-Ecom-Search-app",
        "aliases": ["ecom search app", "ecom-search-app", "search app"],
    },
    "ecom-tabby": {
        "project": "ECom", "ci_id": 71, "cd_id": 38, "alias": "_CI-Ecom-Tabby",
        # The team writes these as "Ecom-Tabby-app" in Teams, matching the ACR repo name
        # rather than the pipeline name (which is CD-Ecom-Tabby, no suffix). Both spellings
        # have to resolve or a pasted request is silently skipped as an unknown pipeline.
        "aliases": ["ecom-tabby", "ecom tabby", "tabby",
                    "ecom-tabby-app", "ecom tabby app", "tabby app"],
    },
    "ecom-dashboard": {
        "project": "ECom", "ci_id": 59, "cd_id": 33, "alias": "_CI-Ecom-Dashboard",
        "aliases": ["ecom-dashboard", "ecom dashboard", "dashboard"],
    },
    "ecom saleor core": {
        "project": "ECom", "ci_id": 66, "cd_id": 34, "alias": "_CI-Ecom-Saleor-Core",
        "aliases": ["ecom saleor core", "ecom-saleor-core", "saleor core", "saleor"],
    },
    "magrabi storefront": {
        "project": "ECom", "ci_id": 74, "cd_id": 41, "alias": "_CI-Magrabi-Storefront",
        "aliases": ["magrabi storefront", "magrabi-storefront", "magrabi-sf", "magrabi sf"],
    },
    "magrabi retail": {
        "project": "ECom", "ci_id": 118, "cd_id": 63, "alias": "_CI-Magrabi-Retail",
        "aliases": ["magrabi retail", "magrabi-retail", "retail"],
    },
    # Rivoli Eyezone -- fifth non-transactional brand site. CD 71 currently has SIT and UAT
    # stages only; DEV renders as "-" until a DEV stage is added, which is correct, not a fault.
    "magrabi rivoli": {
        "project": "ECom", "ci_id": 162, "cd_id": 71, "alias": "_CI-Magrabi-Rivoli",
        "aliases": ["magrabi rivoli", "magrabi-rivoli", "rivoli", "rivoli eyezone",
                    "rivoli-eyezone", "rivoli eyezone website", "rivoli storefront",
                    "rivoli-storefront", "magrabi rivoli eyezone", "eyezone"],
    },
    "magrabi sanity": {
        "project": "ECom", "ci_id": 34, "cd_id": 40, "alias": "_CI-Sanity",
        "aliases": ["magrabi sanity", "magrabi-sanity", "mag-sanity", "mag sanity",
                    "magrabi-sanity-cms", "magrabi sanity cms", "mag-sanity-cms", "mag sanity cms"],
    },
    "drm sanity": {
        "project": "ECom", "ci_id": 48, "cd_id": 32, "alias": "_CI-Doctorm-Sanity",
        # "doctor sanity"/"doctor-sanity" added 2026-08-07 -- its sibling pipeline
        # (doctor-storefront/doctorm-storefront) already aliased both DoctorM naming variants,
        # this one had only ever gotten the "doctorm" spellings, not the shorter "doctor" one
        # people also type in practice (confirmed live: a real deploy request used exactly this).
        "aliases": ["drm sanity", "drm-sanity", "doctorm sanity", "doctorm-sanity",
                    "doctor sanity", "doctor-sanity",
                    "doctorm-sanity-cms", "doctorm sanity cms", "drm-sanity-cms", "drm sanity cms"],
    },
    "ecom paymob": {
        "project": "ECom", "ci_id": 69, "cd_id": 36, "alias": "_CI-Ecom-Paymob",
        "aliases": ["ecom paymob", "ecom-paymob", "paymob",
                    "ecom-paymob-app", "ecom paymob app", "paymob app"],
    },
    "ecom-checkout-app": {
        "project": "ECom", "ci_id": 67, "cd_id": 35, "alias": "_CI-Ecom-Checkout",
        "aliases": ["ecom-checkout-app", "ecom checkout app", "ecom-checkout", "checkout app", "checkout"],
    },
    "macula batch-processor": {
        "project": "Macula", "ci_id": 64, "cd_id": 20, "alias": "_CI-Macula-Batch-Processor",
        "aliases": ["macula batch-processor", "macula batch processor", "batch-processor", "batch processor"],
    },
    "macula singlemicro": {
        "project": "Macula", "ci_id": 62, "cd_id": 22, "alias": "_CI-Macula-Singlemicro",
        "aliases": ["macula singlemicro", "macula single micro", "singlemicro", "single micro", "single-micro"],
    },
    "macula integrations": {
        "project": "Macula", "ci_id": 58, "cd_id": 16, "alias": "_CI-Macula-Integrations",
        "aliases": ["macula integrations", "integrations"],
    },
    "ecom tamara": {
        "project": "ECom", "ci_id": 72, "cd_id": 39, "alias": "_CI-Ecom-Tamara",
        "aliases": ["ecom tamara", "ecom-tamara", "tamara",
                    "ecom-tamara-app", "ecom tamara app", "tamara app"],
    },
    "ecom promotion dashboard": {
        "project": "ECom", "ci_id": 96, "cd_id": 61, "alias": "_CI-Ecom-Promotion-Dashboard",
        "aliases": ["ecom promotion dashboard", "ecom-promotion-dashboard", "promotion dashboard", "promo dashboard"],
    },
    # Rivoli Eyezone's own Sanity CMS. A SEPARATE pipeline to "magrabi rivoli" (the storefront,
    # def 71) and to the other three sanity pipelines -- the team writes it "Magrabi-Rivoli-sanity",
    # which normalises to "magrabi rivoli sanity" and matched nothing, so pasted requests for it
    # were silently skipped as an unknown pipeline. UAT is its only stage.
    "magrabi rivoli sanity": {
        "project": "ECom", "ci_id": 163, "cd_id": 72, "alias": "_CI-Magrabi-Rivoli-Sanity",
        "aliases": ["magrabi rivoli sanity", "magrabi-rivoli-sanity", "rivoli sanity",
                    "rivoli-sanity", "rivoli eyezone sanity", "rivoli-eyezone-sanity",
                    "magrabi rivoli sanity cms", "rivoli sanity cms"],
    },
    "magrabi retail sanity": {
        "project": "ECom", "ci_id": 117, "cd_id": 64, "alias": "_CI-Magrabi-Retail-Sanity",
        "aliases": ["magrabi retail sanity", "magrabi-retail-sanity", "retail sanity"],
    },
    "magrabi i-clinic": {
        "project": "ECom", "ci_id": 119, "cd_id": 65, "alias": "_CI-Magrabi-I-Clinic",
        "aliases": ["magrabi i-clinic", "magrabi iclinic", "i-clinic", "iclinic"],
    },
    "magrabi shodo": {
        "project": "ECom", "ci_id": 120, "cd_id": 66, "alias": "_CI-Magrabi-shodo",
        "aliases": ["magrabi shodo", "magrabi-shodo", "shodo"],
    },
    "magrabi zwei": {
        "project": "ECom", "ci_id": 121, "cd_id": 67, "alias": "_CI-Magrabi-zwei",
        "aliases": ["magrabi zwei", "magrabi-zwei", "zwei"],
    },
    "ecom adb2c functionapp": {
        "project": "ECom", "ci_id": 33, "cd_id": 17, "alias": "_CI.Adb2c",
        "aliases": ["ecom adb2c functionapp", "adb2c function app", "adb2c functionapp", "adb2c"],
    },
    "ecom order push function app": {
        "project": "ECom", "ci_id": 78, "cd_id": 46, "alias": "_CI.Order-Push-Function-App",
        "aliases": ["ecom order push function app", "order push function app", "order-push-function-app", "order push"],
    },
    "ecom graphql cache function app": {
        "project": "ECom", "ci_id": 81, "cd_id": 48, "alias": "_CI.GraphQL-Cache-Function-App",
        "aliases": ["ecom graphql cache function app", "graphql cache function app",
                    "graphql-cache-function-app", "graphql cache func app"],
    },
    "ecom graphql cache": {
        "project": "ECom", "ci_id": 83, "cd_id": 49, "alias": "_CI.GraphQL-Cache",
        "aliases": ["ecom graphql cache", "graphql cache", "graphql-cache"],
    },
    "ecom cart abandon report function app": {
        "project": "ECom", "ci_id": 90, "cd_id": 50, "alias": "_CI.Cart-Abandon-Report-Function-App",
        "aliases": ["ecom cart abandon report function app", "cart abandon report", "cart-abandon-report", "cart abandon"],
    },
    "macula db": {
        "project": "Macula", "ci_id": 22, "cd_id": 2, "alias": "_CI-DB",
        "aliases": ["macula db", "macula-db", "macula database"],
    },
    "macula dashboard": {
        "project": "Macula", "ci_id": 57, "cd_id": 15, "alias": "_CI-Macula-Dashboard",
        "aliases": ["macula dashboard", "macula-dashboard"],
    },
    "macula app-api": {
        "project": "Macula", "ci_id": 60, "cd_id": 17, "alias": "_CI-Macula-App-Api",
        "aliases": ["macula app-api", "macula app api", "macula-app-api", "app api"],
    },
    "macula api-gateway": {
        "project": "Macula", "ci_id": 65, "cd_id": 18, "alias": "_CI-Macula-Api-Gateway",
        "aliases": ["macula api-gateway", "macula api gateway", "macula-api-gateway", "api gateway"],
    },
    "macula auth-server": {
        "project": "Macula", "ci_id": 61, "cd_id": 19, "alias": "_CI-Macula-Auth-Server",
        "aliases": ["macula auth-server", "macula auth server", "macula-auth-server", "auth server"],
    },
    "macula external-api": {
        "project": "Macula", "ci_id": 63, "cd_id": 21, "alias": "_CI-Macula-External-Api",
        "aliases": ["macula external-api", "macula external api", "macula-external-api", "external api"],
    },
}


def _normalize_pipeline_name(name: str) -> str:
    # Trailing punctuation is stripped because these names are pasted out of Teams messages, where
    # a line routinely ends "Pipeline: Ecom-Tabby-app." -- and that single full stop was enough to
    # make the whole request resolve to nothing and be skipped as an unknown pipeline.
    cleaned = name.strip().strip(".,;:!?").strip()
    return re.sub(r"[\s\-_]+", " ", cleaned.lower())


_PIPELINE_ALIAS_INDEX = {
    _normalize_pipeline_name(alias): key
    for key, cfg in PIPELINES.items()
    for alias in cfg.get("aliases", [key])
}


def _resolve_pipeline(name: str):
    key = _PIPELINE_ALIAS_INDEX.get(_normalize_pipeline_name(name))
    return PIPELINES[key] if key else None


# Hard rule: this portal only ever ACTS ON (queues builds, triggers/approves/cancels deploys for)
# lower environments -- plus the short, explicit list of beta/production stages in
# PASTE_PROD_TARGETS below, and nothing else. Enforced here, not just assumed. Every mutating route
# (api_new_deployment, api_redeploy_approve, api_rebuild_deploy, api_cancel_deployment and the late
# approval sweeper) asks _env_allowed() -- never STATUS_ENVIRONMENTS below.
ENVIRONMENTS = ["DEV", "SIT", "UAT"]

# The ONE exception to the rule above: named beta/production stages the paste-a-request box may
# deploy exactly as it deploys DEV/SIT/UAT. Asked for by Sanskar on 2026-09-13 so Rivoli beta and
# Rivoli Sanity production can be pasted like any other request instead of going through the
# Production section.
#
# Keyed by (release definition id, exact stage name) -- never by the fuzzy BETA/PROD matchers -- so
# listing PROD for one pipeline cannot open production on any other. Each entry also pins the ONLY
# branch that may be deployed there: a typo that would put a feature branch on a live site is
# refused outright, never "corrected".
PASTE_PROD_TARGETS = {
    (71, "BETA"): {"branch": "master", "label": "Rivoli storefront beta (CD-Magrabi-Rivoli)"},
    # Rivoli storefront PRODUCTION. def 71's prod stage is named "PROD TAG" (not "PROD"), and since
    # 2026-09-15 it is a direct-to-cluster CD stage: build -> Push -> Tag Images(:prod) ->
    # Set env YAML (prod) -> Apply K8 to ns ecom-retail. Keyed by that exact stage name so the paste
    # box deploys Rivoli to production the same way it deploys beta. Branch pinned to master.
    # Token to paste: ENV: PROD TAG (the parser splits envs only on , & and, so the space survives).
    (71, "PROD TAG"): {"branch": "master", "label": "Rivoli storefront production (CD-Magrabi-Rivoli)"},
    (72, "PROD"): {"branch": "release/rivoli", "label": "Rivoli Sanity Studio production (CD-Magrabi-Rivoli-Sanity)"},
}


def _paste_prod_target(cfg, env_name):
    """The allowlist entry for a beta/production stage of this pipeline, or None."""
    if not cfg:
        return None
    return PASTE_PROD_TARGETS.get((cfg.get("cd_id"), (env_name or "").strip().upper()))


def _env_allowed(cfg, env_name) -> bool:
    """True when a mutating route may act on this pipeline's environment: any lower environment,
    or one of the stages explicitly listed in PASTE_PROD_TARGETS. The single place this rule lives."""
    env = (env_name or "").strip().upper()
    return env in ENVIRONMENTS or _paste_prod_target(cfg, env) is not None


def _env_not_allowed_message(env_name) -> str:
    extra = ", ".join(f"{e} on definition {d}" for (d, e) in sorted(PASTE_PROD_TARGETS))
    return (f"env '{env_name}' not allowed -- only {'/'.join(ENVIRONMENTS)}"
            + (f", plus {extra}" if extra else ""))


def _prod_branch_problem(cfg, env_name, branch):
    """Refusal text when a listed beta/production stage is asked for the wrong branch, else None."""
    target = _paste_prod_target(cfg, env_name)
    if target and (branch or "").strip() != target["branch"]:
        return (f"{target['label']} only deploys from {target['branch']}, not {branch!r} -- "
                f"refused so the wrong branch cannot reach a live site")
    return None

# Read-only status display only -- adding "PROD" here does NOT relax the write-side safety gate
# above; _refresh_live_status() is the only thing that reads this list. Each CD pipeline in this
# org names its production environment differently (confirmed live across the registry sweep:
# "PROD", "PROD_TAG", "PROD TAG", "DoctorM-Prod", "Magrabi PROD", ...) -- there is no single exact
# string to match, so the PROD row is resolved by fuzzy name matching in _refresh_live_status()
# instead of an exact lookup like DEV/SIT/UAT get, and always normalized to the display env "PROD"
# regardless of the pipeline's own literal environment name.
STATUS_ENVIRONMENTS = ENVIRONMENTS + ["BETA", "PROD"]

# Fuzzy matchers for the read-only display buckets, in the order they must be tried.
# BETA IS RESOLVED BEFORE PROD AND THIS ORDER IS LOAD-BEARING: a real stage in this org is literally
# named "BETA PROD" (seen live alongside "BETA_TAG", "PROD_TAG" and "PROD"), so a bare /prod/ match
# claims the beta stage and reports a beta build as what is live in production. The PROD matcher
# therefore also excludes anything containing "beta".
_STATUS_ENV_MATCHERS = {
    "BETA": lambda n: bool(re.search(r"beta", n, re.IGNORECASE)),
    "PROD": lambda n: bool(re.search(r"prod", n, re.IGNORECASE))
                      and not re.search(r"beta", n, re.IGNORECASE),
}


def _matches_status_env(env_name: str, raw_name: str) -> bool:
    """True when a pipeline's own environment name belongs in the given display bucket. DEV/SIT/UAT
    stay exact-match; BETA/PROD are fuzzy because every pipeline names them differently."""
    raw = raw_name or ""
    matcher = _STATUS_ENV_MATCHERS.get(env_name)
    return matcher(raw) if matcher else raw == env_name

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
OLLAMA_MODEL = "qwen2.5:7b-instruct"

# The container runs on UTC, but the team reads these "Last updated" strings as-is -- unlike the ISO
# timestamps elsewhere, which the browser localizes via toLocaleString(). Emitting server-local time
# meant the header clock disagreed with every timestamp on the cards. A fixed +05:30 offset is exact
# for India (no DST) and needs no tzdata package in the slim image.
IST = timezone(timedelta(hours=5, minutes=30))


def _ist_hms() -> str:
    return datetime.now(IST).strftime("%H:%M:%S")


_cache_lock = threading.Lock()
_cache = {
    "live_status": [], "my_deployments": [], "deployments": [],
    "live_status_updated": None, "my_deployments_updated": None, "deployments_updated": None,
    # Whether the last refresh could reach Azure DevOps at all. An empty board and a board the
    # portal cannot see are indistinguishable to a reader, and the difference matters enormously:
    # one means nothing is deploying, the other means every row on screen is frozen and a new
    # deployment may have started without appearing. Verified 2026-08-31, when egress from the
    # cluster to the ADO address range began timing out while the rest of the internet was fine --
    # the boards silently showed zeros and stale rows for hours.
    "ado_reachable": True, "ado_error": None, "ado_failed_since": None,
}


# One pooled HTTP session for every outbound call, instead of a fresh connection per request.
#
# WHY THIS EXISTS, and why it must not be reverted to bare _SESSION.get():
# _SESSION.get()/post()/patch() with no Session opens a NEW TCP connection every time and closes it
# straight after. Each closed connection then sits in TIME_WAIT for ~4 minutes holding a SNAT port
# on the AKS outbound load balancer. This portal polls hard -- My Deployments every 2 seconds, the
# feed every 10, builds every 3, across two thread pools -- so the connections accumulate far faster
# than they retire.
#
# Azure allocates SNAT ports PER (node, destination address, destination port). On 2026-08-31 the
# node running the portal exhausted its ports for the Azure DevOps endpoints specifically: every
# call to dev.azure.com and vsrm.dev.azure.com timed out for hours while login.microsoftonline.com
# and the rest of the internet stayed fine at ~100ms, and pods on other nodes reached Azure DevOps
# in 2ms. A snapshot of the pod at the time: 154 sockets to the two ADO IPs, every one of them in
# TIME_WAIT, none established. Every board silently showed zeros and rows frozen for days.
#
# A pooled session keeps a handful of connections alive and reuses them, so the port count stops
# growing with the poll rate. pool_maxsize covers the worst case: _my_deployments_pool (16) plus the
# two 8-worker pools plus request threads. max_retries stays 0 because _retry() already owns
# retrying and would otherwise multiply attempts.
_SESSION = requests.Session()
_SESSION.mount("https://", requests.adapters.HTTPAdapter(
    pool_connections=32, pool_maxsize=64, max_retries=0, pool_block=False))
_SESSION.mount("http://", requests.adapters.HTTPAdapter(
    pool_connections=8, pool_maxsize=16, max_retries=0, pool_block=False))


class _Transient(Exception):
    """A retryable ADO API hiccup -- connection error/timeout, a 5xx, or (confirmed live
    2026-08-07 on release 8363's initial build-queue call) a 200-status response with an empty or
    unparseable JSON body. A real 4xx is a permanent request problem, not this."""


def _retry(attempt, retries=3, backoff=2):
    for i in range(retries):
        try:
            return attempt()
        except _Transient:
            if i == retries - 1:
                raise
            time.sleep(backoff * (2 ** i))


def _check_transient(r, url):
    if r.status_code >= 500:
        raise _Transient(f"HTTP {r.status_code} from {url}")


def _get(url, params=None):
    def attempt():
        try:
            r = _SESSION.get(url, headers=HEADERS, params=params, timeout=30)
        except (requests.ConnectionError, requests.Timeout) as e:
            raise _Transient(str(e))
        _check_transient(r, url)
        r.raise_for_status()
        try:
            return r.json()
        except ValueError:
            raise _Transient(f"invalid/empty JSON body from {url}: {r.text[:200]!r}")

    return _retry(attempt)


def _artifact_branch(artifact: dict) -> str:
    """The branch a release artifact was built from.

    Azure DevOps reports this under TWO different keys and does not always send both. Sampled
    2026-09-08 across 80 build artifacts: 67 carried `branches` and `branch` together, and 13
    carried **`branch` alone**. Reading only `branches` rendered those 13 as "?" on the live-status
    board -- which reads as "nobody knows what is deployed" rather than "this portal looked in one
    place". magrabi-storefront DEV (Release-1156) and doctorm-storefront DEV (Release-1765) both sat
    like that while carrying a perfectly good branch.

    The two keys hold the SAME branch in different forms -- `branches` is the bare name
    ("release/sit"), `branch` is fully qualified ("refs/heads/release/sit"), differing on every one
    of the 67 that had both -- so the fallback is normalised to the bare form and the column stays
    consistent instead of showing refs/heads/ on some rows only.
    """
    ref = artifact.get("definitionReference") if isinstance(artifact, dict) else None
    if not isinstance(ref, dict):
        return "?"
    for key in ("branches", "branch"):
        node = ref.get(key)
        name = (node.get("name") or "").strip() if isinstance(node, dict) else ""
        if name:
            return name[len("refs/heads/"):] if name.startswith("refs/heads/") else name
    return "?"


# ---------------------------------------------------------------------------------------------
# Branch resolution.
#
# A pasted request spells a branch the way a human wrote it, and the repos in this org do not
# agree on how to write one. For the SAME release date, magrabi-omni-dashboard (Macula-Dashboard)
# uses release/07-09-2026 with hyphens, while magrabi-ecom-apps (Ecom-Tabby and friends) uses
# release/07.09.2026 with dots. Both are live and current, so there is no house style to enforce
# -- carrying one team's habit into the other team's request just produces a ref that does not
# exist.
#
# ADO fails that build before it ever reaches an agent: no commit, no timeline, no task log, and
# a portal row reading only "CI build failed (result=failed)" with nothing to open. Three
# identical builds (16804/16805/16806) were queued against release/07.09.2026 on Macula-Dashboard
# on 2026-09-04 for exactly this reason, and the actual cause was only visible in the build's
# validationResults, which nothing surfaced.
#
# So separators are treated as insignificant when MATCHING, and the repo's real spelling always
# wins. Nothing is rewritten blindly: a variant is only ever used when the repo genuinely has it.
# ---------------------------------------------------------------------------------------------
_BRANCH_SEPARATORS = re.compile(r"[.\-_]+")

# Provider slugs ADO's sourceProviders API expects, keyed by definition repository.type.
_SOURCE_PROVIDERS = {"GitHub": "github", "TfsGit": "tfsgit",
                     "GitHubEnterprise": "githubenterprise", "Bitbucket": "bitbucket"}

BRANCH_CACHE_SECONDS = 300
_BRANCH_CACHE = {}
_BRANCH_CACHE_LOCK = threading.Lock()


def _branch_key(name: str) -> str:
    """Separator-insensitive form, used ONLY for comparison and never for queueing."""
    bare = (name or "").strip().lower().replace("refs/heads/", "")
    return _BRANCH_SEPARATORS.sub("-", bare)


def _list_source_branches(cfg: dict) -> list:
    """Every branch the CI definition's repository actually has.

    Deliberately routed through ADO's sourceProviders API rather than GitHub directly: ADO already
    holds the service connection for these repos, so this needs no second credential and behaves
    identically for GitHub-backed and ADO-hosted definitions. Cached per CI definition because a
    pasted batch resolves several combos against the same repo in one request.
    """
    cache_key = (cfg["project"], cfg["ci_id"])
    now = time.time()
    with _BRANCH_CACHE_LOCK:
        hit = _BRANCH_CACHE.get(cache_key)
        if hit and now - hit[0] < BRANCH_CACHE_SECONDS:
            return hit[1]

    bbase = build_base(cfg["project"])
    try:
        definition = _get(f"{bbase}/build/definitions/{cfg['ci_id']}?api-version={API_VERSION}")
        repo = definition.get("repository") or {}
        provider = _SOURCE_PROVIDERS.get(repo.get("type") or "")
        if not provider or not repo.get("id"):
            branches = []
        else:
            params = {"repository": repo["id"], "api-version": "7.1-preview.1"}
            connection = (repo.get("properties") or {}).get("connectedServiceId")
            if connection:
                params["serviceEndpointId"] = connection
            resp = _get(f"{bbase}/sourceProviders/{provider}/branches", params=params)
            branches = [b for b in (resp.get("value") or []) if isinstance(b, str)]
    except Exception:
        # Never block a deployment because the branch list could not be fetched. Falling back to
        # an empty list means ADO validates the ref itself -- exactly the old behaviour.
        branches = []

    with _BRANCH_CACHE_LOCK:
        _BRANCH_CACHE[cache_key] = (now, branches)
    return branches


def _resolve_branch(cfg: dict, branch: str):
    """Maps a requested branch onto the repository's real spelling.

    Returns (resolved, note, candidates):
      resolved   -- the branch to queue, or None when it genuinely does not exist
      note       -- human text when the spelling was corrected, otherwise ""
      candidates -- near matches worth offering when nothing resolved
    """
    want = (branch or "").strip().replace("refs/heads/", "")
    branches = _list_source_branches(cfg)
    if not branches:
        return want, "", []
    if want in branches:
        return want, "", []

    key = _branch_key(want)
    same = [b for b in branches if _branch_key(b) == key]
    if len(same) == 1:
        return same[0], f"'{want}' does not exist, used '{same[0]}'", []
    if len(same) > 1:
        # Two real branches differing only by separator. Picking one would be a coin flip on
        # which code ships, so this stops and makes a person choose.
        return None, "", same

    # Nothing matched even ignoring separators. Offer anything sharing the trailing segment,
    # which is almost always the date or ticket the request actually meant.
    tail = key.rsplit("/", 1)[-1]
    near = [b for b in branches if tail and tail in _branch_key(b)][:5]
    return None, "", near


# ---------------------------------------------------------------------------------------------
# Deployment feed normalization (MLC-2112). Everything the frontend renders about a deployment's
# identity, environment and status is decided HERE, once, so the UI never re-derives it and the
# two views can't disagree about what a row means.
# ---------------------------------------------------------------------------------------------
# Release-definition ids are only unique WITHIN an ADO project, never across the org: ECom's
# "ecom adb2c functionapp" and Macula's "macula app-api" are BOTH cd_id 17, and cd_id 15/16/18/19
# collide the same way. Keying this reverse map on the bare id would silently relabel a chunk of
# the Macula feed with ECom pipeline names, so the key is (project, cd_id). Built once at import
# rather than scanned per row -- the feed re-normalizes ~400 deployments on every refresh.
_CD_DEFINITION_INDEX = {(cfg["project"], cfg["cd_id"]): key for key, cfg in PIPELINES.items()}

# One bulk /release/deployments call per project returns deployments across EVERY pipeline in it
# (~1.3s), so a full feed refresh is two calls -- not one per pipeline like live-status needs.
DEPLOYMENT_PROJECTS = ("ECom", "Macula")
DEPLOYMENT_FEED_TOP = 200

# How often the background refresher rebuilds that cache -- and therefore the real freshness the
# feed page can ever show, no matter how fast it polls. Lowered from 20s when the UI moved to a 2s
# poll: polling four times faster than the data behind it changes only re-serves identical rows.
# Deliberately NOT applied to the live-status refresher, which is orders of magnitude heavier (31
# pipelines x up to 15 sequential release reads, versus the two bulk calls here).
DEPLOYMENT_FEED_REFRESH_SECONDS = 10

# A date-filtered query can reach outside that 200-row window, so it goes straight to ADO with the
# range pushed down (see api_deployments). It needs a bigger page than the cached feed -- wide enough
# that a month-long range comes back whole, small enough that one filter change is still a single
# call per project. ADO caps $top server-side, so asking for more than it allows just returns less.
DEPLOYMENT_RANGE_TOP = 500

# The feed page polls on a short user-configurable interval, so without this every poll with a date
# filter set would re-hit ADO for a range whose answer barely moves. Pinned to the feed's own
# refresh period rather than restated as a number, so a dated query always carries exactly the
# staleness the cached path already has -- the two must not drift apart.
DEPLOYMENT_RANGE_TTL_SECONDS = DEPLOYMENT_FEED_REFRESH_SECONDS
_range_lock = threading.Lock()
_range_cache = {}

# The canonical status vocabulary. Exposed via /api/meta so the filter dropdown is stable even
# while the feed cache is still cold.
NORMALIZED_STATUSES = ["succeeded", "inProgress", "failed", "canceled", "queued", "waiting",
                       "rejected", "notDeployed"]

# Statuses where the deployment hasn't finished, so "how long has this been going" is measured
# against now rather than a completion timestamp that doesn't exist yet.
_RUNNING_STATUSES = ("inProgress", "queued", "waiting")

# Terminal, unsuccessful states whose local bookkeeping row the user is allowed to delete off My
# Deployments. Deliberately excludes "succeeded" (that is history worth keeping) and every live
# state (deleting the row would orphan a deployment that is still running in ADO).
DISMISSABLE_STATUSES = {"failed", "canceled"}

# ADO's null-date sentinel. In-flight deployments carry completedOn "0001-01-01T00:00:00Z" rather
# than omitting the field or sending null, which renders as "year 1" if passed through verbatim.
_DATE_SENTINEL = "0001-01-01"

# A deployment is flagged stuck rather than merely slow past these thresholds -- long enough that
# every normal deploy in this org has finished, short enough to still be actionable.
_STUCK_RUNNING_SECONDS = 45 * 60
_STUCK_WAITING_SECONDS = 60 * 60

# PROD is matched fuzzily and FIRST for the same reason STATUS_ENVIRONMENTS documents: every CD
# pipeline names its production environment differently ("PROD", "PROD_TAG", "DoctorM-Prod",
# "Magrabi PROD"). No real lower-env name contains "prod", so checking it first is safe. The
# lower envs are matched on token boundaries so a stray substring (e.g. "development-notes")
# doesn't pull an unrelated environment into the DEV bucket.
_ENV_BUCKET_PATTERNS = (
    # BETA first, and this ordering is load-bearing for the same reason _STATUS_ENV_MATCHERS
    # documents: the stage named "BETA PROD" contains "prod", so a PROD-first scan buckets beta
    # deployments as production. Beta stages ("BETA_TAG", "BETA PROD") previously fell through to
    # OTHER or PROD and so never appeared as themselves anywhere in the UI.
    ("BETA", re.compile(r"beta", re.IGNORECASE)),
    ("PROD", re.compile(r"prod", re.IGNORECASE)),
    ("UAT", re.compile(r"(?:^|[^A-Za-z])uat(?:[^A-Za-z]|$)", re.IGNORECASE)),
    ("SIT", re.compile(r"(?:^|[^A-Za-z])sit(?:[^A-Za-z]|$)", re.IGNORECASE)),
    ("DEV", re.compile(r"(?:^|[^A-Za-z])dev(?:[^A-Za-z]|$)", re.IGNORECASE)),
)


def _env_bucket(raw_env) -> str:
    """Collapses a pipeline's own environment name into the four display buckets the UI filters
    on, plus OTHER for the handful of one-off environments in the org that are none of them."""
    name = (raw_env or "").strip() if isinstance(raw_env, str) else ""
    if not name:
        return "OTHER"
    if name.upper() in STATUS_ENVIRONMENTS:
        return name.upper()
    for bucket, pattern in _ENV_BUCKET_PATTERNS:
        if pattern.search(name):
            return bucket
    return "OTHER"


def _normalize_deployment_status(deployment_status, operation_status) -> str:
    """The single source of truth for a deployment's status. ADO splits the real state across two
    independent fields -- deploymentStatus is coarse (it sits on "notDeployed" for everything from
    "queued" through "waiting on an approval" to "rejected") while operationStatus carries the
    detail -- so both are consulted. Precedence order below is load-bearing: a terminal
    deploymentStatus always wins over whatever operationStatus happened to be left behind."""
    ds = (deployment_status or "").strip().lower() if isinstance(deployment_status, str) else ""
    ops = (operation_status or "").strip().lower() if isinstance(operation_status, str) else ""
    if ds in ("succeeded", "partiallysucceeded"):
        return "succeeded"
    if ds == "failed" or ops in ("phasefailed", "gatefailed"):
        return "failed"
    if ds == "inprogress" or ops in ("phaseinprogress", "cancelling"):
        return "inProgress"
    # "canceled"/"rejected" as a *deploymentStatus* never appears in the bulk feed (only the six
    # values ADO documents there do), but the same normalizer is reused for a release
    # environment's deploySteps[-1].status in the timeline route, where they do -- accepting them
    # here keeps one status vocabulary across both endpoints instead of two near-identical ones.
    if ds == "canceled" or ops in ("canceled", "phasecanceled"):
        return "canceled"
    if ops in ("queued", "queuedforagent", "queuedforpipeline", "scheduled", "deferred"):
        return "queued"
    if ops in ("pending", "manualinterventionpending", "evaluatinggates"):
        return "waiting"
    if ds == "rejected" or ops == "rejected":
        return "rejected"
    return "notDeployed"


def _clean_ado_date(value):
    """Every timestamp leaving this backend goes through here, so the 0001-01-01 sentinel can
    never reach the frontend as a real-looking date."""
    if not isinstance(value, str) or not value.strip():
        return None
    return None if value.startswith(_DATE_SENTINEL) else value


def _parse_ado_dt(value):
    """Parses an ADO timestamp to an aware datetime, or None. ADO is inconsistent about the
    trailing Z and about how many fractional-second digits it sends (7 shows up on some release
    payloads), neither of which datetime.fromisoformat accepts on every Python it might run on."""
    raw = _clean_ado_date(value)
    if not raw:
        return None
    text = raw.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    text = re.sub(r"(\.\d{6})\d+", r"\1", text)
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _earliest(values):
    dated = [(v, _parse_ado_dt(v)) for v in values]
    dated = [pair for pair in dated if pair[1]]
    return min(dated, key=lambda pair: pair[1])[0] if dated else None


def _latest(values):
    dated = [(v, _parse_ado_dt(v)) for v in values]
    dated = [pair for pair in dated if pair[1]]
    return max(dated, key=lambda pair: pair[1])[0] if dated else None


def _duration_seconds(started, completed, running: bool = False):
    """Elapsed seconds, or None when it genuinely can't be known. A finished deployment measures
    to its completion; an in-flight one measures to now so the UI can tick. A terminal deployment
    with no completion timestamp deliberately returns None rather than measuring to now -- that
    would show a "duration" that keeps growing for something that already stopped."""
    start = _parse_ado_dt(started)
    if not start:
        return None
    end = _parse_ado_dt(completed)
    if end is None:
        if not running:
            return None
        end = datetime.now(timezone.utc)
    elapsed = int((end - start).total_seconds())
    return elapsed if elapsed >= 0 else None


def _stuck_state(status: str, started, queued):
    """Flags the two ways a deployment silently stops making progress in this org: an agent job
    that hung, and an approval nobody noticed. Both are things a human needs to go look at."""
    now = datetime.now(timezone.utc)
    if status == "inProgress":
        start = _parse_ado_dt(started)
        if start and (now - start).total_seconds() > _STUCK_RUNNING_SECONDS:
            return True, "running over 45 min"
    if status == "waiting":
        queued_at = _parse_ado_dt(queued)
        if queued_at and (now - queued_at).total_seconds() > _STUCK_WAITING_SECONDS:
            return True, "awaiting approval over 60 min"
    return False, None


def _first_artifact(container) -> dict:
    """Both the bulk feed's release stub and a full release detail carry artifacts[], but some
    pipelines have none and ADO sometimes sends the key with an empty list -- so this never
    indexes [0] blindly (the pre-existing `artifacts[0]` in live-status could raise IndexError)."""
    artifacts = container.get("artifacts") if isinstance(container, dict) else None
    if not isinstance(artifacts, list):
        return {}
    for artifact in artifacts:
        if isinstance(artifact, dict) and isinstance(artifact.get("definitionReference"), dict):
            return artifact
    return artifacts[0] if artifacts and isinstance(artifacts[0], dict) else {}


def _artifact_refs(artifact) -> dict:
    """Pulls build provenance out of one artifact's definitionReference. The node shapes differ
    per artifact type (a Build artifact carries all of these, a Git artifact only some), so every
    lookup tolerates the key being absent or not a dict at all."""
    ref = artifact.get("definitionReference") if isinstance(artifact, dict) else None
    if not isinstance(ref, dict):
        ref = {}

    def field(key: str, name: str = "name") -> str:
        node = ref.get(key)
        return (node.get(name) or "") if isinstance(node, dict) else ""

    # repository.name arrives fully qualified as "Org/repo-name"; the UI wants just the repo.
    repository = field("repository")
    return {
        "buildNumber": field("version"),
        # version.name is the human-facing build NUMBER ("15186"); version.id is the actual ADO
        # build id. They are different values and only the id makes a working _build/results link,
        # so the two are kept separate rather than reusing buildNumber for both.
        "buildId": field("version", "id"),
        "commitId": field("sourceVersion", "id")[:8],
        # Full 40-char SHA alongside the short one. The column shows the short form because
        # a full hash is unreadable at a glance and blows the column width; the dialog behind
        # it is what you actually paste into a git command.
        "commitFull": field("sourceVersion", "id"),
        "application": repository.split("/")[-1] if repository else "",
        "branch": field("branches"),
    }


def _ado_release_url(project: str, release_id, environment_id=None) -> str:
    """Link to a release, and to the STAGE this row is actually about.

    Without environmentId, Azure DevOps opens the release and chooses a stage itself -- in practice
    the most recently touched one. On a definition where later stages auto-queue, that is routinely
    NOT the stage the row describes: clicking a SIT row landed on the UAT stage that had queued
    itself and been auto-rejected, which reads as "my SIT deploy failed" when SIT had succeeded.
    Verified 2026-08-31 on the Macula pipelines. Always pass the environment id when it is known.
    """
    if not release_id:
        return ""
    url = (f"https://dev.azure.com/{ORG}/{project}/_releaseProgress"
           f"?_a=release-pipeline-progress&releaseId={release_id}")
    if environment_id:
        url += f"&environmentId={environment_id}"
    return url


def _ado_env_logs_url(project: str, release_id, environment_id) -> str:
    if not (release_id and environment_id):
        return ""
    return (f"https://dev.azure.com/{ORG}/{project}/_releaseProgress"
            f"?_a=release-environment-logs&releaseId={release_id}&environmentId={environment_id}")


def _ado_build_url(project: str, build_id) -> str:
    if not build_id:
        return ""
    return f"https://dev.azure.com/{ORG}/{project}/_build/results?buildId={build_id}&view=logs"


def _deploy_step_actor(environment) -> str:
    """Who actually ran the latest attempt on a release environment. deploySteps is append-only
    across retries, so index -1 is the current attempt -- the same convention _find_failed_tasks()
    already relies on."""
    steps = environment.get("deploySteps") if isinstance(environment, dict) else None
    if not isinstance(steps, list) or not steps:
        return ""
    latest = steps[-1] if isinstance(steps[-1], dict) else {}
    for key in ("requestedFor", "requestedBy"):
        actor = latest.get(key)
        if isinstance(actor, dict) and actor.get("displayName"):
            return actor["displayName"]
    return ""


def _deploy_step_trigger(environment) -> str:
    """"automated" or "manual" for the latest attempt on a release environment.

    This has to be a separate field because the ACTOR CANNOT CARRY IT: sampled across 200 real
    deployments in both projects, ADO records a human in requestedFor/requestedBy on every single
    row, automated ones included (Ankita Singh appears on 105 automated and 84 manual deployments).
    So "who deployed this" and "was this a pipeline trigger or a person clicking deploy" are
    genuinely independent, and only `reason` answers the second."""
    steps = environment.get("deploySteps") if isinstance(environment, dict) else None
    if not isinstance(steps, list) or not steps:
        return ""
    latest = steps[-1] if isinstance(steps[-1], dict) else {}
    return (latest.get("reason") or "").strip().lower()


def _deployment_row(item, project: str):
    """Normalizes one /release/deployments item into the DeploymentRow shape the frontend
    consumes. Returns None for anything missing the two identifiers the UI keys rows off
    (deployment id and release id) -- one malformed item must never take the whole feed down."""
    if not isinstance(item, dict):
        return None
    deployment_id = item.get("id")
    release = item.get("release") if isinstance(item.get("release"), dict) else {}
    release_id = release.get("id")
    if not deployment_id or not release_id:
        return None

    definition = item.get("releaseDefinition") if isinstance(item.get("releaseDefinition"), dict) else {}
    environment = item.get("releaseEnvironment") if isinstance(item.get("releaseEnvironment"), dict) else {}
    refs = _artifact_refs(_first_artifact(release))

    definition_name = definition.get("name") or ""
    # Friendly registry name where we know the CD definition, ADO's own name where we don't --
    # the org has release definitions outside the pipeline registry and they still belong in the
    # feed rather than rendering as a blank cell.
    pipeline = _CD_DEFINITION_INDEX.get((project, definition.get("id"))) or definition_name

    raw_env = environment.get("name") or ""
    raw_status = item.get("deploymentStatus") or ""
    operation_status = item.get("operationStatus") or ""
    status = _normalize_deployment_status(raw_status, operation_status)

    queued_on = _clean_ado_date(item.get("queuedOn"))
    started_on = _clean_ado_date(item.get("startedOn"))
    completed_on = _clean_ado_date(item.get("completedOn"))
    is_stuck, stuck_reason = _stuck_state(status, started_on, queued_on)

    requested_for = item.get("requestedFor") if isinstance(item.get("requestedFor"), dict) else {}
    requested_by = item.get("requestedBy") if isinstance(item.get("requestedBy"), dict) else {}

    try:
        attempt = int(item.get("attempt") or 0)
    except (TypeError, ValueError):
        attempt = 0

    return {
        "id": deployment_id,
        "releaseId": release_id,
        "releaseName": release.get("name") or "",
        "pipeline": pipeline,
        "definitionName": definition_name,
        "application": refs["application"],
        "env": _env_bucket(raw_env),
        "rawEnv": raw_env,
        "branch": refs["branch"],
        "buildNumber": refs["buildNumber"],
        "buildId": refs["buildId"],
        "commitId": refs["commitId"],
        "status": status,
        "rawStatus": raw_status,
        "operationStatus": operation_status,
        "attempt": attempt,
        "reason": item.get("reason") or "",
        # ADO's own trigger reason. Cannot be inferred from the actor -- a real person is recorded
        # as requestedFor on automated deployments too.
        "automated": (item.get("reason") or "").strip().lower() in ("automated", "schedule"),
        "triggeredBy": requested_for.get("displayName") or requested_by.get("displayName") or "",
        "queuedOn": queued_on,
        "startedOn": started_on,
        "completedOn": completed_on,
        "durationSeconds": _duration_seconds(started_on, completed_on, running=status in _RUNNING_STATUSES),
        "isStuck": is_stuck,
        "stuckReason": stuck_reason,
        "project": project,
        "adoReleaseUrl": _ado_release_url(project, release_id, environment.get("id")),
        "adoLogsUrl": _ado_env_logs_url(project, release_id, environment.get("id")),
        "adoBuildUrl": _ado_build_url(project, refs["buildId"] or refs["buildNumber"]),
    }


def _deployment_sort_key(row):
    when = _parse_ado_dt(row.get("startedOn")) or _parse_ado_dt(row.get("queuedOn"))
    return when or datetime.min.replace(tzinfo=timezone.utc)


def _live_status_row_from_feed(pipeline_name: str, env_name: str, rows: list):
    """The most recent SUCCEEDED feed row for one pipeline + environment bucket, mapped into the
    live-status row shape -- or None if the feed doesn't have one either. Rows are cached
    newest-first, so the first match is the deployment currently sitting in that environment."""
    for row in rows:
        if row.get("status") != "succeeded":
            continue
        if row.get("pipeline") != pipeline_name or row.get("env") != env_name:
            continue
        return {
            "pipeline": pipeline_name, "env": env_name,
            "release": row.get("releaseName") or "-",
            "branch": row.get("branch") or "-",
            # The release walk reports the environment's modifiedOn; the feed's equivalent instant
            # is when the deployment finished. startedOn only covers the rare succeeded row that
            # arrived without a completion timestamp.
            "deployedOn": row.get("completedOn") or row.get("startedOn") or "",
            "releaseId": row.get("releaseId"),
            "buildNumber": row.get("buildNumber") or "",
            "commitId": row.get("commitId") or "",
            "application": row.get("application") or "",
            # The feed's triggeredBy is requestedFor/requestedBy on the deployment itself, which is
            # the same person _deploy_step_actor() reads off the environment's latest deploy step.
            "deployedBy": row.get("triggeredBy") or "",
            # Same distinction as _deploy_step_trigger(): the feed carries ADO's own `reason`.
            "trigger": (row.get("reason") or "").strip().lower(),
            "adoReleaseUrl": row.get("adoReleaseUrl") or "",
            "adoBuildUrl": row.get("adoBuildUrl") or "",
        }
    return None


def _live_status_rows_for_pipeline(name: str, cfg: dict) -> list:
    """Resolves one pipeline's row per status environment: the newest SUCCEEDED deployment in each.

    Uses a single `release/deployments` query filtered to succeeded, newest-first, rather than
    walking release details. The previous implementation fetched the definition's 15 most recent
    releases and inspected each one, which had two problems:

    * **It missed anything older than 15 releases.** A pipeline that deploys to DEV/SIT constantly
      but to UAT rarely pushed its last good UAT release out of the window and the row fell through
      to a bare "-", which reads as "nothing is deployed there" -- the opposite of the truth.
      Measured 2026-08-18 on `ecom saleor core`: its newest succeeded UAT was at position **19** and
      its newest succeeded PROD_TAG at position **37**, so both showed "-" while ADO plainly had
      them.
    * It cost up to ~16 API calls per pipeline per refresh.

    One query returns every stage's newest succeeded deployment with the branch, build, timestamp
    and actor already attached, so this is both correct and roughly 16x cheaper.
    """
    rbase = release_base(cfg["project"])
    try:
        payload = _get(f"{rbase}/release/deployments", params={
            "definitionId": cfg["cd_id"], "deploymentStatus": "succeeded",
            "$top": 200, "queryOrder": "descending", "api-version": API_VERSION,
        })
        items = payload.get("value", []) if isinstance(payload, dict) else []
    except Exception:
        items = []

    resolved = {}
    for item in items:
        if len(resolved) == len(STATUS_ENVIRONMENTS):
            break
        stage_name = (item.get("releaseEnvironment") or {}).get("name") or ""
        bucket = next((e for e in STATUS_ENVIRONMENTS
                       if e not in resolved and _matches_status_env(e, stage_name)), None)
        if not bucket:
            continue
        release = item.get("release") if isinstance(item.get("release"), dict) else {}
        refs = _artifact_refs(_first_artifact(release))
        actor = item.get("requestedFor") if isinstance(item.get("requestedFor"), dict) else {}
        actor_alt = item.get("requestedBy") if isinstance(item.get("requestedBy"), dict) else {}
        resolved[bucket] = {
            "pipeline": name, "env": bucket,
            "release": release.get("name") or "-",
            "branch": _artifact_branch(_first_artifact(release)) or "-",
            # completedOn is when it actually finished; startedOn covers the rare row without one.
            "deployedOn": _clean_ado_date(item.get("completedOn"))
                          or _clean_ado_date(item.get("startedOn")) or "",
            "releaseId": release.get("id"),
            "buildNumber": refs["buildNumber"],
            "commitId": refs["commitId"],
            "application": refs["application"],
            "deployedBy": actor.get("displayName") or actor_alt.get("displayName") or "",
            "trigger": (item.get("reason") or "").strip().lower(),
            "adoReleaseUrl": _ado_release_url(cfg["project"], release.get("id"),
                                              (item.get("releaseEnvironment") or {}).get("id")),
            "adoBuildUrl": _ado_build_url(cfg["project"], refs["buildId"] or refs["buildNumber"]),
        }

    # Second source for anything still unresolved -- reads the already-cached cross-pipeline feed,
    # no extra ADO call. Kept because a pipeline can deploy through a path this query misses.
    missing = [e for e in STATUS_ENVIRONMENTS if e not in resolved]
    if missing:
        with _cache_lock:
            feed = list(_cache["deployments"])
        for env_name in missing:
            row = _live_status_row_from_feed(name, env_name, feed)
            if row:
                resolved[env_name] = row

    # Unresolved buckets still emit a full-shaped row: the Status page guarantees one row per
    # pipeline per environment, so the fields have to be present-but-empty rather than missing.
    return [resolved.get(env_name, {
        "pipeline": name, "env": env_name, "release": "-", "branch": "-", "deployedOn": "",
        "releaseId": None, "buildNumber": "", "commitId": "", "application": "",
        "deployedBy": "", "trigger": "", "adoReleaseUrl": "", "adoBuildUrl": "",
    }) for env_name in STATUS_ENVIRONMENTS]



def _refresh_live_status():
    # On the very first pass the cache is empty and the page has nothing to show, so results are
    # published pipeline-by-pipeline as they land -- the table fills in progressively instead of
    # staying blank until every pipeline is done. Later passes swap the whole list in atomically at
    # the end, so a refresh never makes an already-populated table shrink and regrow.
    with _cache_lock:
        first_pass = not _cache["live_status"]

    rows = []
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = [pool.submit(_live_status_rows_for_pipeline, n, c) for n, c in PIPELINES.items()]
        for fut in as_completed(futures):
            try:
                rows.extend(fut.result())
            except Exception as e:
                print("live_status pipeline error:", e)
            if first_pass:
                with _cache_lock:
                    _cache["live_status"] = list(rows)
                    _cache["live_status_updated"] = _ist_hms() + " (loading…)"

    with _cache_lock:
        _cache["live_status"] = rows
        _cache["live_status_updated"] = _ist_hms()


def _portal_names_by_release():
    """(releaseId, ENV) -> the Name someone set on that run in this portal.

    The deployment feed comes straight from ADO, which knows nothing about the portal's own Name
    field, so the two have to be joined here. Without it a deployment labelled "Shaad" in My
    Deployments showed as anonymous on the live tiles -- the same deployment, named in one view and
    not the other.
    """
    with _cache_lock:
        rows = list(_cache["my_deployments"])
    index = {}
    for row in rows:
        name = (row.get("requestedBy") or "").strip()
        rid, env_name = row.get("releaseId"), row.get("env")
        if not name or name == "-------" or not rid or not env_name:
            continue
        index[(rid, str(env_name).upper())] = name
    return index


def _portal_owned_releases():
    """(releaseId, ENV) pairs a person started from this portal, named or not.

    Deliberately NOT _portal_names_by_release with the name check removed: that index answers "what
    label did someone type", this one answers "did a human ask for this deployment", and the second
    must not depend on whether they bothered to fill in the optional Name field.

    Why it is needed at all: ADO frequently records a portal-started deployment as
    `reason: "automated"`, `requestedBy: Microsoft.VisualStudio.Services.ReleaseManagement`.
    Confirmed live on deployment 15406 / release 8851 (def 45 UAT, 2026-08-20). The sequence is:
    the portal queues the CI build, the build lands, the CD trigger auto-STARTS the stage on
    ReleaseStarted before the portal's own trigger PATCH gets there (the worker tolerates the
    resulting "InProgress" error by design), and the portal then approves that already-running
    attempt instead of opening a second one. ADO is describing who pressed the button on that
    attempt, which really was the release engine -- but the deployment exists because a person
    asked for it here, so the board must not badge it as a pipeline that ran itself.
    """
    with _cache_lock:
        rows = list(_cache["my_deployments"])
    owned = set()
    for row in rows:
        rid, env_name = row.get("releaseId"), row.get("env")
        if rid and env_name:
            owned.add((rid, str(env_name).upper()))
    return owned


# Portal phases that exist BEFORE Azure DevOps has created a release.
_PRE_RELEASE_PHASES = {"queued", "building", "creating-release", "rebuilding"}


def _prerelease_deployment_rows():
    """Portal runs that have not produced a release yet, shaped as deployment-feed rows.

    The Live Deployments board reads ADO's `release/deployments` API, which by definition knows
    nothing about a run whose CI build is still going -- there is no release, so there is no
    deployment record to return. A deployment started from the portal was therefore invisible on
    that board for the entire build (often several minutes), then appeared abruptly. It was not a
    refresh delay: the data did not exist.

    These synthesise the missing rows from the portal's own state so a build shows up the moment it
    is queued. They can never duplicate a real feed row, because they exist only while releaseId is
    empty and every ADO row has one.
    """
    with _cache_lock:
        rows = list(_cache["my_deployments"])
    out = []
    for r in rows:
        if r.get("releaseId"):
            continue
        status = r.get("status")
        if status not in _PRE_RELEASE_PHASES:
            continue
        cfg = _resolve_pipeline(r.get("pipeline") or "")
        build_id = r.get("buildId")
        build_no = r.get("buildNumber") or ""
        started = r.get("startedAt")
        running = status in ("building", "rebuilding")
        name = (r.get("requestedBy") or "").strip()
        out.append({
            # Negative so it can never collide with a real ADO deployment id.
            "id": -(int(build_id) if build_id else abs(hash(r.get("runId") or "")) % 1_000_000),
            "releaseId": 0,
            # No release exists yet, so name the build -- the same thing My Deployments shows.
            "releaseName": f"Build {build_no}" if build_no else "Build queued",
            "pipeline": r.get("pipeline") or "",
            "definitionName": r.get("releaseDefinitionName") or "",
            "application": "",
            "env": str(r.get("env") or "").upper(),
            "rawEnv": r.get("env") or "",
            "branch": r.get("branch") or "",
            "buildNumber": build_no,
            "buildId": build_id,
            "commitId": "",
            # "building", never "inProgress": the CI build is not a deployment. Calling it in
            # progress on the board implied the release was already rolling out, which it is not --
            # nothing deploys until the build finishes and a release exists.
            "status": "building" if running else "queued",
            "rawStatus": status,
            "operationStatus": status,
            "attempt": r.get("attempt") or 1,
            "reason": "manual",
            "triggeredBy": "" if name in ("", "-------") else name,
            "queuedOn": started,
            "startedOn": started if running else None,
            "completedOn": None,
            "durationSeconds": _duration_seconds(started, None, running=True) if running else None,
            "isStuck": False,
            "stuckReason": "",
            "project": cfg["project"] if cfg else "ECom",
            "adoReleaseUrl": "",
            "adoLogsUrl": "",
            "adoBuildUrl": r.get("buildUrl") or "",
            "portalName": name if name and name != "-------" else "",
            # Lets the UI mark it as "build in progress, no release yet" rather than implying a
            # deployment is under way.
            "preRelease": True,
        })
    return out


# Some pipelines deploy INSIDE the build instead of handing off to a classic release: a merge to
# their branch triggers a YAML build whose own stages include Deploy. Those never create a release,
# so `release/deployments` -- the source of the whole Live Deployments board -- is structurally
# incapable of showing them. Confirmed live 2026-08-19: ECom build definitions 155
# (Magrabi-digital.magrabi-storefront, stages Publish Artifact / Build & Push / Deploy / Notify) and
# 151 (magrabi-content-management, stage "Deploy to SIT") both deploy this way on `individualCI`
# triggers, and neither had ever appeared on the board.
#
# Which definitions do this is DISCOVERED rather than hardcoded -- the set changes as teams migrate
# pipelines, and a hardcoded list silently goes stale into the same blind spot this fixes.
_CI_DEPLOY_TTL_SECONDS = 1800
_ci_deploy_lock = threading.Lock()
_ci_deploy_cache = {}          # project -> (fetched_at, {definitionId: name})
_build_stage_cache = {}        # (project, buildId) -> [(stageName, result, state)]
_CI_DEPLOY_FEED_TOP = 30


def _build_stages(project: str, build_id, completed: bool):
    """Stage names and results for one build. Completed builds are immutable, so their timeline is
    cached forever; a running build is re-read each time."""
    key = (project, int(build_id))
    if completed:
        with _ci_deploy_lock:
            hit = _build_stage_cache.get(key)
        if hit is not None:
            return hit
    try:
        data = _get(f"{build_base(project)}/build/builds/{build_id}/timeline"
                    f"?api-version={API_VERSION}")
    except Exception:
        return []
    stages = [(r.get("name"), r.get("result"), r.get("state"))
              for r in (data.get("records") or []) if r.get("type") == "Stage"]
    if completed:
        with _ci_deploy_lock:
            # Bounded so a long-lived process cannot grow this without limit.
            if len(_build_stage_cache) > 2000:
                _build_stage_cache.clear()
            _build_stage_cache[key] = stages
    return stages


def _discover_ci_deploy_definitions(project: str) -> dict:
    """Build definitions whose recent builds contain a stage named like a deploy."""
    with _ci_deploy_lock:
        hit = _ci_deploy_cache.get(project)
    if hit and (time.monotonic() - hit[0]) < _CI_DEPLOY_TTL_SECONDS:
        return hit[1]
    found = {}
    try:
        recent = _get(f"{build_base(project)}/build/builds", params={
            "api-version": API_VERSION, "$top": 120,
            "queryOrder": "queueTimeDescending"}).get("value", [])
    except Exception:
        recent = []
    # One representative build per definition is enough to classify the definition.
    rep = {}
    for b in recent:
        d = b.get("definition") or {}
        if d.get("id") and d["id"] not in rep:
            rep[d["id"]] = (d.get("name") or "", b)
    for def_id, (name, b) in rep.items():
        stages = _build_stages(project, b.get("id"), b.get("status") == "completed")
        if any("deploy" in (s[0] or "").lower() for s in stages):
            found[def_id] = name
    with _ci_deploy_lock:
        _ci_deploy_cache[project] = (time.monotonic(), found)
    return found


def _ci_deploy_rows():
    """Builds that deploy inside themselves, shaped as deployment-feed rows and marked automated."""
    out = []
    for project in DEPLOYMENT_PROJECTS:
        defs = _discover_ci_deploy_definitions(project)
        if not defs:
            continue
        try:
            builds = _get(f"{build_base(project)}/build/builds", params={
                "api-version": API_VERSION,
                "definitions": ",".join(str(i) for i in defs),
                "$top": _CI_DEPLOY_FEED_TOP,
                "queryOrder": "queueTimeDescending"}).get("value", [])
        except Exception:
            continue

        for b in builds:
            build_id = b.get("id")
            if not build_id:
                continue
            completed = b.get("status") == "completed"
            stages = _build_stages(project, build_id, completed)
            deploy = next(((n, res, st) for n, res, st in stages
                           if "deploy" in (n or "").lower()), None)
            if not deploy:
                continue
            stage_name, stage_result, stage_state = deploy

            branch = (b.get("sourceBranch") or "").replace("refs/heads/", "")
            # Environment from the STAGE name first ("Deploy to SIT"), falling back to the branch
            # ("release/sit"). Getting this wrong is worse than admitting it, so anything that
            # matches neither lands in OTHER rather than being guessed into a real environment.
            env_bucket = _env_bucket(stage_name)
            if env_bucket == "OTHER":
                env_bucket = _env_bucket(branch)

            if b.get("status") != "completed":
                status = "inProgress" if (stage_state or "").lower() == "inprogress" else "building"
            elif (stage_result or "").lower() == "succeeded":
                status = "succeeded"
            elif (stage_result or "").lower() in ("failed", "abandoned"):
                status = "failed"
            elif (stage_result or "").lower() in ("canceled", "cancelled"):
                status = "canceled"
            elif (b.get("result") or "").lower() == "succeeded":
                status = "succeeded"
            else:
                status = "failed" if (b.get("result") or "") else "queued"

            started = _clean_ado_date(b.get("startTime")) or _clean_ado_date(b.get("queueTime"))
            finished = _clean_ado_date(b.get("finishTime"))
            actor = (b.get("requestedFor") or {}).get("displayName") or ""
            # ADO records the CI service account as the requester on a merge-triggered build, which
            # is the giveaway that nobody clicked anything.
            reason = (b.get("reason") or "").lower()
            automated = reason in ("individualci", "batchedci", "schedule", "pullrequest")

            out.append({
                # Distinct negative range so these can never collide with an ADO deployment id or
                # with the pre-release rows (which use -buildId).
                "id": -(2_000_000 + int(build_id)),
                "releaseId": 0,
                "releaseName": f"Build {b.get('buildNumber') or build_id}",
                "pipeline": defs.get((b.get("definition") or {}).get("id"), "") or
                            (b.get("definition") or {}).get("name") or "",
                "definitionName": (b.get("definition") or {}).get("name") or "",
                "application": "",
                "env": env_bucket,
                "rawEnv": stage_name or branch,
                "branch": branch,
                "buildNumber": str(b.get("buildNumber") or ""),
                "buildId": build_id,
                "commitId": (b.get("sourceVersion") or "")[:8],
                "status": status,
                "rawStatus": b.get("status") or "",
                "operationStatus": stage_result or stage_state or "",
                "attempt": 1,
                "reason": "automated" if automated else "manual",
                "triggeredBy": actor,
                "queuedOn": _clean_ado_date(b.get("queueTime")),
                "startedOn": started,
                "completedOn": finished,
                "durationSeconds": _duration_seconds(started, finished,
                                                     running=not completed),
                "isStuck": False,
                "stuckReason": "",
                "project": project,
                "adoReleaseUrl": "",
                "adoLogsUrl": _ado_build_url(project, build_id),
                "adoBuildUrl": _ado_build_url(project, build_id),
                "portalName": "",
                # Drives the AUTOMATED banner on the tile.
                "automated": automated,
                "ciDeploy": True,
            })
    return out


def _refresh_deployments():
    """Rebuilds the whole cross-pipeline deployment feed from two bulk calls. Unlike live-status
    this is cheap enough (~2.6s total) to run whole on every refresh, so there's no progressive
    publish -- the list swaps in atomically."""
    rows = []
    any_project_succeeded = False
    last_error = None
    for project in DEPLOYMENT_PROJECTS:
        try:
            payload = _get(f"{release_base(project)}/release/deployments", params={
                "api-version": API_VERSION, "$top": DEPLOYMENT_FEED_TOP, "queryOrder": "descending",
            })
        except Exception as e:
            print("deployments fetch error:", project, e)
            last_error = f"{project}: {type(e).__name__}: {str(e)[:180]}"
            continue
        any_project_succeeded = True
        names = _portal_names_by_release()
        owned = _portal_owned_releases()
        for item in payload.get("value", []) if isinstance(payload, dict) else []:
            try:
                row = _deployment_row(item, project)
                if row:
                    key = (row.get("releaseId"), str(row.get("env") or "").upper())
                    row["portalName"] = names.get(key, "")
                    if key in owned:
                        # A person started this from the portal, so it is not a pipeline that ran
                        # itself -- whatever ADO's own `reason` says. See _portal_owned_releases.
                        row["automated"] = False
                        row["portalInitiated"] = True
            except Exception as e:
                print("deployments row error:", project, e)
                continue
            if row:
                rows.append(row)

    # A total ADO outage must not blank an already-populated page. Publishing an empty list here
    # would look identical to "nothing has deployed recently", which is a very different thing --
    # so on a failed pass the previous rows and their timestamp are simply left in place, and the
    # stale "updated" time is what tells the user something is wrong.
    if not any_project_succeeded:
        # Returning early leaves the previous rows in place, which is right -- stale data beats no
        # data. But the reader has to be told, or the frozen board reads as a quiet one.
        with _cache_lock:
            if _cache.get("ado_reachable"):
                _cache["ado_failed_since"] = datetime.now(timezone.utc).isoformat()
            _cache["ado_reachable"] = False
            _cache["ado_error"] = last_error
        return

    with _cache_lock:
        _cache["ado_reachable"] = True
        _cache["ado_error"] = None
        _cache["ado_failed_since"] = None

    # Builds that have not produced a release yet are not in ADO's feed at all -- add them so the
    # board shows work the moment it starts, not once a release finally exists.
    pre = _prerelease_deployment_rows()
    rows.extend(pre)

    # Pipelines that deploy inside the build never create a release at all, so they are a third
    # source entirely. Deduped by build number so a portal-started run cannot appear twice.
    seen_builds = {r.get("buildNumber") for r in rows if r.get("buildNumber")}
    for row in _ci_deploy_rows():
        if row.get("buildNumber") and row["buildNumber"] in seen_builds:
            continue
        rows.append(row)

    rows.sort(key=_deployment_sort_key, reverse=True)
    with _cache_lock:
        _cache["deployments"] = rows
        _cache["deployments_updated"] = _ist_hms()


# deployStep statuses that mean "this attempt is happening right now". Used to let the newest
# attempt override the environment-level summary status.
_IN_FLIGHT_STEP_STATUSES = ("inProgress", "queued", "notStarted", "scheduled")

# The service identity ADO records as the approver when it auto-rejects an approval nobody actioned.
_ADO_SYSTEM_APPROVER = "Microsoft.VisualStudio.Services.ReleaseManagement"


def _approval_timed_out(approval: dict) -> bool:
    """True when ADO auto-rejected this approval on its ~1 minute timeout rather than a person
    rejecting it. Both look identical in `status`; the approver identity and the generated comment
    are what separate them (verified live 2026-08-13, approval 29923 on release 8579)."""
    if approval.get("status") != "rejected":
        return False
    approved_by = (approval.get("approvedBy") or {}).get("displayName") or ""
    if approved_by == _ADO_SYSTEM_APPROVER:
        return True
    return "because of timeout" in (approval.get("comments") or "")


# (project, definitionId) -> (fetched_at_monotonic, {lowercased stage name: {...}}).
# Pre-deploy approval config lives on the DEFINITION, not on the release, so both the countdown and
# the "is there a gate here at all" test need this second lookup -- cached because it changes about
# never and the refresher runs every 2s.
_approval_timeout_lock = threading.Lock()
_approval_timeout_cache = {}
_APPROVAL_TIMEOUT_TTL_SECONDS = 900


def _stage_approval_table(project: str, definition_id):
    """Per-stage pre-deploy approval config for one release definition, or None if unreadable.

    Shape: {stage_name_lowercased: {"timeout": minutes_or_None, "manual": bool}}.

    One definition fetch serves both callers. They look like separate concerns -- a UI countdown
    and a gate test -- but they need the identical document, and doing it twice would double the
    API cost of every deployment for nothing.

    Keys are case-folded: the release reports a stage name and the definition reports it again,
    and nothing in the API guarantees the two agree on case.
    """
    if not definition_id:
        return None
    key = (project, definition_id)
    with _approval_timeout_lock:
        hit = _approval_timeout_cache.get(key)
        if hit and (time.monotonic() - hit[0]) < _APPROVAL_TIMEOUT_TTL_SECONDS:
            return hit[1]
    try:
        # Deliberately NOT inside the lock. _get retries with backoff and can take ~90s in the
        # worst case; holding the lock across it would queue every my-deployments worker thread
        # behind one slow call.
        d = _get(f"{release_base(project)}/release/definitions/{definition_id}"
                 f"?api-version={API_VERSION}")
    except Exception:
        return None
    table = {}
    for e in d.get("environments", []) or []:
        pre = e.get("preDeployApprovals") or {}
        opts = pre.get("approvalOptions") or {}
        mins = opts.get("timeoutInMinutes")
        # A stage is gated when ADO records an approval step that is not automated. This is the
        # AUTHORITATIVE answer to "does this stage have a gate", and it is precisely what runtime
        # state cannot tell you in the seconds after a trigger -- see _environment_has_no_gate.
        manual = any(not a.get("isAutomated") for a in (pre.get("approvals") or [])
                     if isinstance(a, dict))
        table[(e.get("name") or "").strip().lower()] = {
            # 0 is ADO's "no timeout", a real answer and a different one from "not configured".
            # It used to be dropped here, which collapsed it into None and quietly cost those
            # stages the LONG wait budget the ceiling was written to give them.
            "timeout": mins if isinstance(mins, int) and mins >= 0 else None,
            "manual": manual,
        }
    with _approval_timeout_lock:
        _approval_timeout_cache[key] = (time.monotonic(), table)
    return table


def _approval_timeout_minutes(project: str, definition_id, env_name: str):
    """Configured pre-deploy approval timeout for one stage, in minutes, or None.

    Measured live 2026-08-17: these are set to 1 minute on nearly every stage in ECom (def 41's
    UAT is the lone 10-minute exception), and 95% of all rejected approvals in the project are
    ADO auto-rejects against that limit. A countdown is only meaningful because the window is
    that tight."""
    table = _stage_approval_table(project, definition_id)
    if not table:
        return None
    return (table.get((env_name or "").strip().lower()) or {}).get("timeout")


def _snapshot_has_manual_gate(current_env):
    """True / False / None, from the approval config FROZEN INTO THIS RELEASE.

    This is the best oracle available, and it beats reading the definition on both counts:

    RACE-FREE. `preApprovalsSnapshot` is written when the release is created, so it is already
    correct in the seconds after a trigger when `preDeployApprovals` is still empty. Verified on
    267 of 267 environment objects across 60 captured release payloads, including 8 caught in the
    exact state that broke releases 8949/8951/8953 -- no approval record yet, operationStatus
    "Queued" -- where the snapshot already said isAutomated false. The answer was sitting in the
    payload the polling loop was fetching anyway.

    CORRECT FOR THE RELEASE IN HAND. A definition lookup returns its LATEST revision, which is not
    necessarily the one this release runs: releases 8949 and 8951 were created at definition 41
    revision 362 while the definition had already moved on to 363. Re-triggering an older release
    would consult a configuration it does not actually honour, in either direction.
    """
    if not isinstance(current_env, dict):
        return None
    snap = current_env.get("preApprovalsSnapshot")
    if not isinstance(snap, dict):
        return None
    approvals = snap.get("approvals")
    if not isinstance(approvals, list):
        return None
    # An ungated stage still carries a placeholder entry -- {"rank":1,"isAutomated":true,"id":0} --
    # so "no approvals at all" is not how gate-free presents. isAutomated is the discriminator.
    return any(not a.get("isAutomated") for a in approvals if isinstance(a, dict))


def _stage_has_manual_gate(project, definition_id, env_name: str):
    """True / False from the release DEFINITION, or None when it cannot be determined.

    The definition is the only race-free source for this. Runtime state is not: for the first
    seconds after a stage is triggered, ADO reports it queued with no approval record yet, which
    is byte-for-byte indistinguishable from a stage that has no gate at all.
    """
    table = _stage_approval_table(project, definition_id)
    if not table:
        return None
    entry = table.get((env_name or "").strip().lower())
    if entry is None:
        return None
    return bool(entry["manual"])


# Phases that only a live worker thread can ever advance. A run sitting in one of these with no
# worker is stranded: nothing will move it again for as long as the file exists.
#
# Deliberately excludes every phase from "ready-for-approval" onwards -- those rows already carry a
# releaseId, so _resolve_deployment_row reads their real state straight from ADO and they self-heal
# without anyone resuming them.
#
# Defined HERE, not next to _recover_orphaned_runs() which is its other consumer: the background
# refresher thread starts at module level well above that point, and it calls
# _resolve_deployment_row -- so a definition further down the file can be reached before it exists.
_RESUMABLE_PHASES = {"queued", "building", "creating-release", "rebuilding"}

# build_id -> (fetched_at_monotonic, (status, result)). Short TTL: this is consulted on every
# refresher cycle (2s) for any row that has a build but no release yet, and without it a handful of
# in-flight rows would each cost an ADO call every two seconds.
_build_state_lock = threading.Lock()
_build_state_cache = {}
_BUILD_STATE_TTL_SECONDS = 10


def _build_state(project: str, build_id):
    """(status, result) for one CI build, or None. Read-only."""
    if not build_id:
        return None
    key = (project, int(build_id))
    with _build_state_lock:
        hit = _build_state_cache.get(key)
        if hit and (time.monotonic() - hit[0]) < _BUILD_STATE_TTL_SECONDS:
            return hit[1]
    try:
        b = _get(f"{build_base(project)}/build/builds/{build_id}?api-version={API_VERSION}")
    except Exception:
        return None
    state = (b.get("status"), b.get("result"))
    with _build_state_lock:
        _build_state_cache[key] = (time.monotonic(), state)
    return state


def _eta_seconds(pipeline: str, env_name: str):
    """Median duration of past SUCCEEDED deployments of this pipeline to this environment.

    Median rather than mean: deployment times here are heavily skewed by the occasional run that
    sat waiting on an agent for minutes, and one of those drags a mean far enough to make the
    estimate useless. Read straight from the already-cached cross-pipeline deployment feed, so this
    costs no extra ADO call.

    Returns None when there is not enough history to say anything honest -- fewer than three past
    runs and the UI shows no estimate at all rather than a confident-looking guess off one sample.
    """
    if not pipeline or not env_name:
        return None
    with _cache_lock:
        feed = list(_cache["deployments"])
    want_env = str(env_name).upper()
    durations = [row.get("durationSeconds") for row in feed
                 if row.get("pipeline") == pipeline
                 and str(row.get("env") or "").upper() == want_env
                 and row.get("status") == "succeeded"
                 and isinstance(row.get("durationSeconds"), (int, float))
                 and row["durationSeconds"] > 0]
    if len(durations) < 3:
        return None
    durations.sort()
    mid = len(durations) // 2
    median = (durations[mid] if len(durations) % 2
              else (durations[mid - 1] + durations[mid]) / 2)
    return int(median)


# (project, cd_id, build_id) -> (fetched_at, releaseId or None)
_release_for_build_lock = threading.Lock()
_release_for_build_cache = {}
_RELEASE_FOR_BUILD_TTL_SECONDS = 20


def _find_release_for_build(project: str, cd_id, build_id):
    """The release ADO created from this build, if there is one. READ-ONLY -- it never creates one.

    Exists so a row can recover on its own when the worker that was driving it no longer exists.
    Worker state lives in a thread, so any pod restart -- a portal redeploy, an eviction, a node
    upgrade -- strands the run at whatever phase it had reached. Observed twice: build 15978's
    release (8795) had been sitting in ADO for minutes while the row still reported "creating
    release", because the only thing that ever wrote releaseId into the run file was the dead
    worker.

    Looking it up here means the row tells the truth regardless of whether anything is driving it.
    """
    if not cd_id or not build_id:
        return None
    key = (project, int(cd_id), int(build_id))
    with _release_for_build_lock:
        hit = _release_for_build_cache.get(key)
        if hit and (time.monotonic() - hit[0]) < _RELEASE_FOR_BUILD_TTL_SECONDS:
            return hit[1]
    release_id = None
    try:
        found = _get(f"{release_base(project)}/release/releases", params={
            "definitionId": cd_id, "artifactTypeId": "Build",
            "artifactVersionId": build_id, "api-version": API_VERSION})
        values = found.get("value") or []
        if values:
            release_id = values[0].get("id")
    except Exception:
        release_id = None
    with _release_for_build_lock:
        _release_for_build_cache[key] = (time.monotonic(), release_id)
    return release_id


def _resolve_deployment_row(path: str, audit: dict) -> dict:
    """Resolves one deploy_runs/*.json audit file into the row shape /api/my-deployments returns.
    Factored out of _refresh_my_deployments() so api_dismiss_deployment() can call the exact same
    logic to re-check a row's CURRENT status live, rather than trust whatever the frontend last
    rendered before the delete button was clicked (that cache could be a few seconds stale)."""
    req = audit.get("request", {})
    # Explicit ids first: the worker now records them the moment ADO hands them over, so a row can
    # name its build and release while they are still running. The scan below stays as a fallback
    # for run files written before those fields existed.
    release_id = audit.get("releaseId")
    build_id = audit.get("buildId")
    build_number = audit.get("buildNumber") or ""
    if not release_id or not build_id:
        for call in audit.get("calls", []):
            resp = call.get("response")
            if not isinstance(resp, dict):
                continue
            if not release_id and resp.get("id") and "environments" in resp:
                release_id = resp["id"]
            if not build_id and resp.get("id") and resp.get("buildNumber"):
                build_id = resp["id"]
                build_number = build_number or resp.get("buildNumber") or ""

    req_cfg = _resolve_pipeline(req.get("pipeline") or "")
    project = req_cfg["project"] if req_cfg else "ECom"

    status = audit.get("phase") or "unknown"
    approval_status = None
    approval_note = ""
    failure_reason = None
    # Populated only while an approval is actually pending -- see the pendingApproval branch below.
    approval_created_on = None
    approval_timeout_minutes = None
    approval_deadline = None
    deploy_started_on = None
    # Release identity for the Release column. Empty until ADO has actually created the release --
    # while the CI build is still running there is nothing to name yet, which is exactly why the
    # build number is carried alongside it.
    release_name = ""
    release_definition_name = ""
    environment_id = None
    ado_attempt = None
    ado_attempt_count = 0
    if release_id:
        try:
            rbase = release_base(project)
            detail = _get(f"{rbase}/release/releases/{release_id}?api-version={API_VERSION}")
            release_name = detail.get("name") or ""
            release_definition = detail.get("releaseDefinition")
            if isinstance(release_definition, dict):
                release_definition_name = release_definition.get("name") or ""
            env = next((e for e in detail.get("environments", []) if e["name"] == req.get("env")), None)
            if env:
                environment_id = env.get("id")
                status = env.get("status", "unknown")

                # A redeployed environment accumulates deploySteps -- ADO's own UI reads the LAST
                # one ("Deployment attempt #2 of 2") and so must this. Reading only the environment
                # status left a row that was actively deploying its second attempt still showing
                # the first attempt's outcome (observed live 2026-08-13 on release 8579/env 28190:
                # attempt 1 rejected, attempt 2 inProgress).
                deploy_steps = env.get("deploySteps") or []
                latest_step = deploy_steps[-1] if deploy_steps else {}
                ado_attempt_count = len(deploy_steps)
                # When THIS attempt actually began in ADO. The row's own startedAt is when the
                # portal was asked, which on a retried run can be many minutes earlier -- using it
                # for a countdown would show a deployment as hopelessly overdue the moment it
                # started.
                deploy_started_on = (latest_step.get("queuedOn")
                                     or latest_step.get("lastModifiedOn") or None)

                # Approvals are per attempt too, so match on the attempt rather than assuming the
                # highest id is the relevant one.
                appr = env.get("preDeployApprovals", [])

                # Which attempt this row is really on is the highest number EITHER source knows
                # about, not just the newest deployStep. Retriggering an environment creates the
                # new approval record BEFORE ADO adds the matching deployStep, so for a few seconds
                # deploySteps[-1] still names the previous attempt. Keying only off the step meant
                # a row the user had just approved kept resolving the OLD attempt's approval and
                # went on rendering APPROVAL TIMED OUT -- and because that status is treated as
                # terminal it was then cached for another 30s on top. Observed live on release
                # 8646/env 28459 (2026-08-17): approvals [(1,'rejected'),(2,'approved')] while
                # deploySteps still held only attempt 1.
                approval_attempts = [a.get("attempt") for a in appr
                                     if isinstance(a.get("attempt"), int)]
                _attempts = [n for n in (latest_step.get("attempt"),
                                         max(approval_attempts, default=None))
                             if isinstance(n, int)]
                ado_attempt = max(_attempts) if _attempts else None
                # Keep "attempt N of M" self-consistent when the approval is ahead of the steps.
                ado_attempt_count = max(ado_attempt_count, ado_attempt or 0)

                current_approval = None
                if appr:
                    if ado_attempt is not None:
                        current_approval = next(
                            (a for a in appr if a.get("attempt") == ado_attempt), None)
                    if current_approval is None:
                        current_approval = max(appr, key=lambda a: a.get("id", 0))
                    approval_status = current_approval.get("status")

                # An approval nobody actioned is auto-rejected by ADO after ~1 minute, by a service
                # account, and the classic API records that as a plain "rejected" -- indistinguishable
                # from a human refusing the deployment. Verified live on 8579: approvedBy was
                # "Microsoft.VisualStudio.Services.ReleaseManagement" with the comment "This approval
                # was rejected because of timeout 1 minute(s)". Reporting that as REJECTED sends
                # people looking for whoever rejected it; nobody did.
                if current_approval is not None and _approval_timed_out(current_approval):
                    approval_status = "timedOut"
                    approval_note = (current_approval.get("comments")
                                     or "Approval expired before anyone actioned it")
                    if status == "rejected":
                        status = "approvalTimedOut"

                # The newest attempt is what is happening NOW; the environment-level status is a
                # summary that can still read terminal while a retry is under way.
                if latest_step.get("status") in _IN_FLIGHT_STEP_STATUSES:
                    status = latest_step["status"]

                # An environment PARKED on a pre-deploy approval is reported by ADO as
                # env.status "inProgress" -- while deploySteps[-1] is "notDeployed" with
                # operationStatus "Pending". Verified live 2026-08-17 on releases 8649 and 8651.
                # Taking that at face value made the row claim it was deploying when nothing was
                # running, and -- because the UI treats inProgress as in flight -- it HID the
                # approve button for the whole ~60s window in which the gate could still be
                # actioned. The approval then auto-rejected on ADO's 1-minute timeout, which is
                # where the APPROVAL TIMED OUT rows were coming from: the portal was hiding the
                # only control that could have prevented them.
                #
                # A pending approval outranks every status ADO reports for the stage: nothing is
                # deploying until a human approves. The sibling feed already draws this
                # distinction (_normalize_deployment_status maps operationStatus "pending" to
                # "waiting"); this row shape simply never used it.
                if approval_status == "pending":
                    status = "pendingApproval"
                    # Everything the UI needs to run a countdown. The deadline is computed here
                    # rather than in the browser so it is anchored to ADO's own createdOn instead
                    # of to whenever the page happened to poll.
                    approval_created_on = current_approval.get("createdOn")
                    approval_timeout_minutes = _approval_timeout_minutes(
                        project, (detail.get("releaseDefinition") or {}).get("id"),
                        env.get("name"))
                    if approval_created_on and approval_timeout_minutes:
                        try:
                            started = datetime.fromisoformat(
                                approval_created_on.replace("Z", "+00:00"))
                            approval_deadline = (
                                started + timedelta(minutes=approval_timeout_minutes)
                            ).isoformat()
                        except ValueError:
                            approval_deadline = None
                # Azure DevOps' classic Release API overloads environment status "rejected" for
                # two very different things: a genuinely rejected approval, and a deployment that
                # actually ran and failed a task -- there is no distinct "failed" value in that
                # field. Confirmed live 2026-08-07 against two real releases (8307, 8355): both
                # showed environment status "rejected" while their own deploySteps[-1] clearly had
                # a failed task (e.g. "build") and an APPROVED, not rejected, approval. Showing
                # "rejected" verbatim in that case is actively misleading -- it reads as "someone
                # rejected this" when the real story is "the build failed." Only keep the
                # "rejected" label when the approval itself was actually rejected; if it was
                # approved (or there's no approval on this environment at all) and the latest
                # deployment attempt shows a real task failure, report "failed" instead -- that's
                # what actually happened.
                if status == "rejected" and approval_status != "rejected":
                    deploy_steps = env.get("deploySteps", [])
                    if deploy_steps and deploy_steps[-1].get("status") == "failed":
                        status = "failed"
                # Short, human-readable reason for a failed/rejected row -- reuses the same
                # failed-task lookup the log-download feature already verified live, so a row
                # that failed because e.g. its "build" task errored shows that directly instead of
                # a bare status badge with no explanation.
                if status in ("failed", "rejected"):
                    failed_tasks = _find_failed_tasks(env)
                    if failed_tasks:
                        failure_reason = f"'{failed_tasks[0][2]}' task failed"

                # An approve/retrigger this portal just performed outranks a terminal status ADO
                # has not caught up on yet -- see _action_grace. Only the superseded set is
                # overridden, and only while the short grace window holds.
                if status in _SUPERSEDED_BY_ACTION and _action_in_flight(release_id, req.get("env")):
                    status = "queued"
                    failure_reason = None
                    if approval_status in ("rejected", "timedOut"):
                        approval_status = "approved"
                        approval_note = ""
        except Exception as e:
            # A 404 here means the release was DELETED in Azure DevOps after this row was created.
            # Swallowing it left the row frozen on whatever phase the worker last wrote -- typically
            # "approved", which is not a status the UI knows, so the row rendered with no badge, no
            # explanation and (because it was not `failed` or `canceled`) no Delete button either.
            # It could never be cleared. Observed on release 8883. Call it what it is instead.
            if "404" in str(e) or "Not Found" in str(e):
                status = "failed"
                failure_reason = (f"release {release_id} no longer exists in Azure DevOps "
                                  f"(deleted) -- this row can be removed")
            # Anything else is transient (a timeout, a 5xx) and must NOT rewrite a good row's
            # status: the next poll two seconds later will get the real answer.

    # No release yet: the row's status is whatever phase the worker last wrote, which is only as
    # fresh as the worker still being alive. If that worker died (pod replaced mid-run) the row
    # would sit on BUILDING indefinitely while the CI build ran to completion without it -- exactly
    # what happened to build 15777 on 2026-08-17. Reading the build directly keeps the row honest
    # in that window, independently of whether orphan recovery has picked it up yet.
    elif build_id and status in _RESUMABLE_PHASES:
        build_state = _build_state(project, build_id)
        if build_state:
            b_status, b_result = build_state
            if b_status == "completed":
                if b_result == "succeeded":
                    # Build is done. Before settling for "creating release", check whether ADO
                    # already HAS the release -- it usually does, and only the (possibly dead)
                    # worker was ever going to write it into the run file.
                    discovered = _find_release_for_build(
                        project, (req_cfg or {}).get("cd_id"), build_id)
                    if discovered:
                        audit["releaseId"] = discovered
                        try:
                            Path(path).write_text(json.dumps(audit, indent=2, default=str),
                                                  encoding="utf-8")
                        except Exception:
                            pass        # display still corrects itself next cycle
                        # Re-resolve now that the row has a release; the release branch above
                        # produces the real status, approvals and attempt information.
                        return _resolve_deployment_row(path, audit)
                    # Genuinely no release yet.
                    status = "creating-release"
                elif b_result:
                    status = "failed"
                    failure_reason = f"CI build {build_id} finished with result '{b_result}'"
            elif b_status in ("notStarted", "postponed"):
                status = "queued"

    # Fall back to the worker's own recorded error when nothing more specific was found above --
    # this is the ONLY source of a reason for a row that never got as far as creating a release at
    # all (e.g. the CI build itself failed to queue or didn't succeed; _new_deployment_worker
    # records exactly this in audit["error"] already, it was just never being surfaced to the
    # frontend before now).
    if status == "failed" and not failure_reason:
        err = audit.get("error")
        if err:
            # Distinguish "the ADO API itself hiccupped talking to the portal" (retried 3x and
            # still failed -- rare after the 2026-08-07 retry fix, but possible on a real outage)
            # from a genuine pipeline/build problem, so this doesn't read as a mysterious crash.
            if "Expecting value" in err or "invalid/empty JSON body" in err or err.startswith("HTTP 5"):
                failure_reason = "Azure DevOps API error (transient, retried automatically) -- try deploying again"
            else:
                failure_reason = err if len(err) <= 150 else err[:150] + "…"

    return {
        "pipeline": req.get("pipeline"), "branch": req.get("branch"), "env": req.get("env"),
        "startedAt": audit.get("startedAt"), "releaseId": release_id, "status": status,
        "approvalStatus": approval_status, "approvalUrl": audit.get("readyForApprovalUrl"),
        "approvalNote": approval_note,
        # Groups rows submitted together in one paste. Empty for a standalone deployment.
        "batchId": _batch_key_for(audit) if audit.get("batchId") else "",
        # Countdown inputs: when this attempt started, and how long this pipeline+env usually
        # takes. etaSeconds is null when there is too little history to be honest about it.
        "deployStartedOn": deploy_started_on,
        "etaSeconds": _eta_seconds(req.get("pipeline") or "", req.get("env") or ""),
        # Countdown inputs. All three are null unless an approval is pending right now.
        "approvalCreatedOn": approval_created_on,
        "approvalTimeoutMinutes": approval_timeout_minutes,
        "approvalDeadline": approval_deadline,
        "failureReason": failure_reason, "runId": Path(path).stem,
        # ADO's own deploy-attempt numbering, so the row matches what the release page says
        # ("Deployment attempt #2", "Attempt # 2 of 2") instead of silently showing one attempt's
        # outcome while a later one runs.
        "adoAttempt": ado_attempt,
        "adoAttemptCount": ado_attempt_count,
        # Falls back to "-------" for runs started before this field existed, same default as a
        # blank Name field on the form.
        "requestedBy": req.get("requestedBy") or "-------",
        # Release identity (MLC-2113 follow-up). ADO's own release name ("Release-156") plus the CD
        # definition that produced it, so a row says which pipeline run it is actually deploying
        # rather than only which registry pipeline it was requested against.
        "releaseName": release_name,
        "releaseDefinitionName": release_definition_name,
        "releaseUrl": _ado_release_url(project, release_id, environment_id),
        "buildId": build_id,
        "buildNumber": build_number,
        "buildUrl": _ado_build_url(project, build_id),
        "environmentId": environment_id,
        "project": project,
        # 1 for a first run; a rebuild that reused this row bumps it, which is what makes an
        # in-place retry visibly different from "nothing happened".
        "attempt": len(audit.get("attempts") or []) + 1,
    }


# Statuses a row will not leave on its own. Re-read from disk every cycle but not re-queried
# against ADO for a short while -- see _refresh_my_deployments.
_TERMINAL_ROW_STATUSES = {"succeeded", "failed", "canceled", "rejected", "partiallySucceeded",
                          "approvalTimedOut"}

# ...but "terminal" only means nothing WE did will change it. A release environment can always be
# redeployed straight from Azure DevOps, which touches no run file and fires no invalidation --
# exactly what happened on release 8579 (a CI-triggered attempt 1 auto-rejected, then attempt 2 ran
# from ADO). Caching those rows indefinitely would have frozen the stale status on screen forever.
# A short TTL keeps ~93% of the calls saved at a 2s cycle while capping that staleness.
_TERMINAL_ROW_TTL_SECONDS = 30

# Statuses where the user is either waiting on the row or acting on it RIGHT NOW. These are never
# cached -- they are re-read from ADO on every cycle.
#
# Everything else gets a short cache, and that split is the point. Measured 2026-08-18: 46 of the 50
# rows in the display window carried a releaseId, so each cycle was paying ~46 live ADO
# release-detail calls through 8 workers. A single pass therefore took several seconds instead of
# the nominal 2, and an approval the user had already granted stayed on screen as "awaiting
# approval" while its refresh sat queued behind forty other rows. Observed on release 8728/UAT:
# approved at 07:35:21, still showing pending with the countdown running well afterwards.
#
# With this split only the handful of genuinely live rows cost an ADO call per cycle, so they
# update within one tick.
_HOT_ROW_STATUSES = {
    "pendingApproval", "inProgress", "queued", "scheduled", "notStarted",
    "building", "creating-release", "rebuilding",
}

# Non-terminal but not actionable either (e.g. ready-for-approval rows whose release already
# finished). Fresh enough to be honest, cheap enough not to crowd out the hot rows.
_WARM_ROW_TTL_SECONDS = 20

# How many run files get resolved against ADO at once. The lookups are pure network wait, so this
# is not CPU parallelism -- it is what stops a 50-file window from serializing 50 round trips.
# One long-lived pool, not one per cycle: at a 2s cadence, standing up and tearing down 8 threads
# every pass costs more than the work it does.
_MY_DEPLOYMENTS_WORKERS = 16
_my_deployments_pool = ThreadPoolExecutor(
    max_workers=_MY_DEPLOYMENTS_WORKERS, thread_name_prefix="my-deployments"
)

# Set by anything that changes a run's state (a run file being written, a deploy/cancel/approve
# call landing) to make the refresher publish immediately instead of waiting out its poll interval.
_my_deployments_wake = threading.Event()
# Was 2. At two seconds this loop alone opened thousands of connections an hour; with
# pooling that is survivable, but two seconds was never worth it -- a release status does
# not change that fast, and the UI polls on its own cadence anyway.
MY_DEPLOYMENTS_REFRESH_SECONDS = 5

# Woken whenever a run is seeded or changes phase, so the Live Deployments board picks up a
# pre-release build straight away instead of waiting out its own 10s timer.
_deployments_wake = threading.Event()

# path -> (mtime, cached_at_monotonic, resolved row), holding ONLY rows whose status is terminal.
# Rewriting a run file changes its mtime and so busts its own entry, which is what makes an
# in-place rebuild show up immediately.
_row_cache_lock = threading.Lock()
_row_cache = {}


# (releaseId, ENV) -> monotonic expiry. Set the moment an approve/retrigger succeeds against ADO.
#
# Why this exists: after a successful approve, ADO's release projection keeps reporting the PREVIOUS
# attempt's terminal outcome for a few seconds. The row therefore re-resolved to approvalTimedOut,
# which is in _TERMINAL_ROW_STATUSES, so it was cached again for the full 30s TTL -- the row sat on
# a stale "approval timed out" long after the user had approved it and ADO had moved to queued.
# That is the "clicked redeploy, portal didn't update, then later showed running" report.
#
# During the grace window a row is never cached as terminal, and a *stale* terminal status is not
# allowed to win over the action we know succeeded. It is deliberately short: after it lapses ADO
# is the only source of truth again, so a deployment that really did fail still surfaces.
_action_grace_lock = threading.Lock()
_action_grace = {}
_ACTION_GRACE_SECONDS = 90

# Terminal statuses that an in-flight action supersedes. A genuine `failed` is NOT here: if the
# redeployed build fails again we must say so immediately rather than sit on an optimistic "queued".
_SUPERSEDED_BY_ACTION = {"rejected", "approvalTimedOut", "canceled"}


def _mark_action(release_id, env_name) -> None:
    if not release_id or not env_name:
        return
    with _action_grace_lock:
        _action_grace[(int(release_id), str(env_name).upper())] = (
            time.monotonic() + _ACTION_GRACE_SECONDS)


def _action_in_flight(release_id, env_name) -> bool:
    if not release_id or not env_name:
        return False
    key = (int(release_id), str(env_name).upper())
    with _action_grace_lock:
        expiry = _action_grace.get(key)
        if expiry is None:
            return False
        if time.monotonic() > expiry:
            del _action_grace[key]
            return False
        return True


def _invalidate_row_cache(release_id=None, env_name=None):
    """Drops cached rows and wakes the refresher.

    Needed because two routes change a deployment's real state in ADO without touching its run
    file -- redeploy-approve re-triggers an existing release, cancel-deployment stops one -- so
    mtime alone would not notice, and a row cached as failed/canceled would stay that way on
    screen for as long as the process lived.

    TARGETED when the caller knows which deployment it touched. Clearing everything looked harmless
    but was actively counter-productive: an uncached row is treated as hot and resolved in phase 1,
    so wiping all 50 put the entire window into the fast phase at exactly the moment the user was
    waiting on ONE row -- the approve they just clicked then queued behind 49 others. Clearing only
    the affected row keeps that phase down to the row that actually changed.
    """
    with _row_cache_lock:
        if release_id and env_name:
            want = (int(release_id), str(env_name).upper())
            for key in [k for k, v in _row_cache.items()
                        if (v[2].get("releaseId"), str(v[2].get("env") or "").upper()) == want]:
                del _row_cache[key]
        else:
            _row_cache.clear()
    _my_deployments_wake.set()


# runId -> last status this process actually PUBLISHED for it. Only used to log transitions.
#
# Exists so the portal's own lag is measurable without needing to authenticate against it: the log
# line carries the UTC instant a status change became visible in /api/my-deployments, which can be
# lined up directly against ADO's own approval/deployStep timestamps. Diagnosing "the UI showed
# awaiting approval for 30s after I approved" was otherwise guesswork, because the published output
# is behind a login and the resolver being correct says nothing about WHEN its answer got out.
_published_status = {}
_published_lock = threading.Lock()


def _log_status_transitions(rows, phase_label):
    """Logs any row whose published status changed since the last publish."""
    stamp = datetime.now(timezone.utc).isoformat(timespec="milliseconds")
    for row in rows:
        run_id = row.get("runId")
        if not run_id:
            continue
        status = row.get("status")
        approval = row.get("approvalStatus")
        key = f"{status}/{approval}"
        with _published_lock:
            previous = _published_status.get(run_id)
            if previous == key:
                continue
            _published_status[run_id] = key
        if previous is None:
            continue        # first sighting is not a transition
        print(f"[status] {stamp} {phase_label:5} run={run_id} "
              f"release={row.get('releaseId')} {row.get('pipeline')}/{row.get('env')} "
              f"{previous} -> {key}", flush=True)


def _refresh_my_deployments():
    """Publishes the my-deployments rows, hot ones FIRST.

    Two things used to make a live row lag badly behind ADO even though its own resolve was fast:

    * **The publish was atomic at end of cycle.** Every row was resolved, then the whole list was
      swapped in. A hot row that resolved in 0.2s was therefore invisible until the other ~49 had
      finished too -- measured at ~6s when the caches expired together, and worse when ADO was slow
      (individual release-detail calls measured 1.1-2.8s on 2026-08-18).
    * **The caches expired in lockstep.** All 50 rows were first cached in the same cycle, so they
      all fell due in the same later cycle -- one pass paying for everything, with the row the user
      was watching stuck in that batch.

    So: resolve the hot rows on their own and publish immediately, then do the rest and publish
    again. A row with no cache entry at all is by definition hot, because hot rows are never
    cached -- that is what makes the split possible without resolving anything first. TTLs are
    also spread per row so they stop coming due all at once.
    """
    # DISPLAY cap only -- run files are never pruned, and nothing outside this window is
    # deleted or lost. What the cap actually bounds is cost: every file inside it can cost a live
    # ADO release-detail lookup, so this number is the per-cycle call budget, not a retention
    # policy.
    paths = sorted(glob.glob(str(RUNS_DIR / "*.json")), reverse=True)[:50] if RUNS_DIR.exists() else []
    if not paths:
        with _cache_lock:
            _cache["my_deployments"] = []
            _cache["my_deployments_updated"] = _ist_hms()
        return

    def cached_fresh(path):
        """The cached row if it is still inside its own TTL, else None."""
        with _row_cache_lock:
            entry = _row_cache.get(path)
        if not entry:
            return None
        mtime_cached, cached_at, row, ttl = entry
        try:
            if os.path.getmtime(path) != mtime_cached:
                return None      # the run file changed -- always re-resolve
        except OSError:
            return None
        return row if (time.monotonic() - cached_at) < ttl else None

    def resolve(path):
        try:
            mtime = os.path.getmtime(path)
            audit = json.loads(Path(path).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        row = _resolve_deployment_row(path, audit)
        status = row.get("status")
        # Hot rows are never cached -- they are what someone is actually watching, and a stale
        # "awaiting approval" on a gate that expires in 60s is the whole problem this avoids.
        # A row just acted on is likewise never frozen while ADO's state settles.
        if (status not in _HOT_ROW_STATUSES
                and not _action_in_flight(row.get("releaseId"), row.get("env"))):
            base = (_TERMINAL_ROW_TTL_SECONDS if status in _TERMINAL_ROW_STATUSES
                    else _WARM_ROW_TTL_SECONDS)
            # Deterministic per-path spread (0-40% on top) so rows cached in the same cycle do not
            # all fall due in the same later one. Deterministic rather than random so a row's TTL
            # does not jitter between cycles.
            ttl = base * (1.0 + (hash(path) % 41) / 100.0)
            with _row_cache_lock:
                _row_cache[path] = (mtime, time.monotonic(), row, ttl)
        return row

    resolved, fresh, needs = {}, {}, []
    for pth in paths:
        row = cached_fresh(pth)
        if row is not None:
            fresh[pth] = row
        else:
            needs.append(pth)

    # Last known row for every path that has one, captured BEFORE any re-resolve overwrites the
    # cache. This is what keeps the published list a constant length across both phases.
    with _row_cache_lock:
        known = set(_row_cache)
        stale = {pth: _row_cache[pth][2] for pth in paths if pth in _row_cache}

    def publish(phase_label):
        out = []
        for pth in paths:
            # `stale` is the load-bearing fallback. Without it, a row whose cache had just lapsed
            # was in neither `resolved` (not re-read yet) nor `fresh` (rejected as stale), so it was
            # silently DROPPED from the phase-1 list and reappeared in phase 2 a second later. At a
            # 2s browser poll that showed up as rows and counts flickering up and down every cycle.
            # A row a few seconds out of date is far better than one that vanishes and returns.
            row = resolved.get(pth) or fresh.get(pth) or stale.get(pth)
            if row is not None:
                out.append(row)
        with _cache_lock:
            _cache["my_deployments"] = out
            _cache["my_deployments_updated"] = _ist_hms()
        _log_status_transitions(out, phase_label)

    # Phase 1 -- anything with no cache entry: hot last cycle, or brand new. Publish as soon as
    # these land rather than making them wait on the rest.
    hot_first = [pth for pth in needs if pth not in known]
    if hot_first:
        for pth, row in zip(hot_first, _my_deployments_pool.map(resolve, hot_first)):
            if row is not None:
                resolved[pth] = row
        publish("hot")

    # Phase 2 -- cached rows whose TTL has lapsed. Slower and nobody is waiting on them.
    rest = [pth for pth in needs if pth in known]
    if rest:
        for pth, row in zip(rest, _my_deployments_pool.map(resolve, rest)):
            if row is not None:
                resolved[pth] = row
    publish("full")

    # Entries for files that dropped out of the window (or were dismissed) would otherwise be kept
    # alive forever by a dict that only ever grows.
    live = set(paths)
    with _row_cache_lock:
        for stale in [key for key in _row_cache if key not in live]:
            del _row_cache[stale]



def _background_refresher():
    while True:
        try:
            _refresh_my_deployments()
        except Exception as e:
            print("my_deployments refresh error:", e)
        # wait() rather than sleep() so a state change (a worker writing its next phase, a deploy
        # action landing) republishes within milliseconds instead of after a full interval. The
        # timeout is the idle floor, not the latency of a real change.
        _my_deployments_wake.wait(timeout=MY_DEPLOYMENTS_REFRESH_SECONDS)
        _my_deployments_wake.clear()


def _background_refresher_live_status():
    while True:
        try:
            _refresh_live_status()
        except Exception as e:
            print("live_status refresh error:", e)
        time.sleep(30)


def _background_refresher_deployments():
    while True:
        try:
            _refresh_deployments()
        except Exception as e:
            print("deployments refresh error:", e)
        # wait() not sleep(): a newly seeded run republishes the board within milliseconds. The
        # timeout is the idle floor, not the latency of a real change.
        _deployments_wake.wait(timeout=DEPLOYMENT_FEED_REFRESH_SECONDS)
        _deployments_wake.clear()


# Threads used to only start under `if __name__ == "__main__"`, which never runs under a production
# WSGI server (gunicorn imports this module, it doesn't execute it as __main__) -- that silently left
# _cache empty forever with no error anywhere. Starting them here, at module level, guarded against
# double-start, fixes that for both `python app.py` and `gunicorn app:app`.
# ---------------------------------------------------------------------------------------------
# Late-gate sweeper
#
# _approve_environment waits a BOUNDED time for the approval to appear after the stage is
# triggered, capped by _APPROVAL_APPEAR_SECONDS_MAX. That cap exists so a worker thread cannot sit
# on a release for ten minutes -- but it means a gate that surfaces later than the cap is never
# approved by the portal at all, and ADO eventually auto-rejects it.
#
# Measured, release 9025 (def 41 UAT, 2026-08-25): the portal triggered the stage at 10:04, waited
# its 150s budget, gave up and wrote phase "ready-for-approval". ADO did not create the approval
# until 10:15:03 -- about eleven minutes after the trigger, on a stage with NO conditions and NO
# gates, so nothing in the definition explains the delay. It then auto-rejected it at 10:25:03 on
# the 10-minute timeout, and the deployment had to be approved by hand on a second attempt.
#
# Raising the cap does not fix this; it just moves it, and blocks a worker thread for longer. The
# fix is to stop treating "approve it" as something that has to happen inside the worker's
# lifetime. This sweeper runs on its own, re-reads the run files the portal itself wrote, and
# approves any pending gate belonging to a deployment a person started here with auto-approve on --
# however late that gate turns up.
#
# Scope is deliberately narrow, and each condition is checked here rather than assumed:
#   * the run file must exist, i.e. the deployment was started from this portal
#   * it must have been submitted with auto-approve on
#   * the environment must be DEV, SIT or UAT, or a stage listed in PASTE_PROD_TARGETS -- no other
#     BETA or PROD stage, ever
#   * the approval must be genuinely pending right now
# ---------------------------------------------------------------------------------------------
AUTO_APPROVE_SWEEP_SECONDS = 20

# A run stops being swept once it is this old. A gate that has not appeared within the window is
# not going to, and the release has almost certainly been dealt with by hand by then.
AUTO_APPROVE_SWEEP_MAX_AGE_SECONDS = 60 * 60

# Phases where a pending gate is still worth answering. "approved" and "failed" are terminal for
# this purpose; anything else may still be sitting in front of a gate.
_SWEEPABLE_PHASES = {"ready-for-approval", "deploying", "creating-release", "queued", "building"}


def _sweep_late_approvals():
    """Approve pending gates on portal-started lower-environment deployments. Read-mostly."""
    if not RUNS_DIR.exists():
        return
    now = datetime.now(timezone.utc)
    paths = sorted(glob.glob(str(RUNS_DIR / "*.json")), reverse=True)[:60]
    for path in paths:
        try:
            audit = json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
        except Exception:
            continue
        if not audit.get("autoApprove"):
            continue
        if (audit.get("phase") or "") not in _SWEEPABLE_PHASES:
            continue
        release_id = audit.get("releaseId")
        req = audit.get("request") or {}
        env_name = (req.get("env") or "").strip().upper()
        pipeline = req.get("pipeline") or ""
        if not release_id or not env_name:
            continue
        # _env_allowed() is the portal-wide rule for what anything mutating may act on: DEV/SIT/UAT
        # plus the stages listed in PASTE_PROD_TARGETS. Reusing it keeps that rule in one place --
        # and a listed beta/production run whose gate appears late still gets approved.
        cfg = _resolve_pipeline(pipeline)
        if not cfg or not _env_allowed(cfg, env_name):
            continue
        started = audit.get("startedAt") or ""
        try:
            age = (now - datetime.fromisoformat(started)).total_seconds()
        except Exception:
            age = 0
        if age > AUTO_APPROVE_SWEEP_MAX_AGE_SECONDS:
            continue

        rbase = release_base(cfg["project"])
        try:
            data = _get(f"{rbase}/release/approvals"
                        f"?releaseIdsFilter={release_id}&statusFilter=pending"
                        f"&api-version={API_VERSION}")
        except Exception:
            continue
        match = None
        for a in (data.get("value") or []):
            if (a.get("releaseEnvironment") or {}).get("name", "").strip().upper() == env_name:
                match = a
                break
        if not match:
            continue

        ok, message = _approve_environment(rbase, release_id, env_name,
                                           cfg.get("project"), cfg.get("cd_id"))
        audit["approvalResult"] = (f"{message} (approved by the late-gate sweeper, "
                                   f"{int(age)}s after the deployment was started)")
        audit["phase"] = "approved" if ok else audit.get("phase")
        try:
            pathlib.Path(path).write_text(json.dumps(audit, indent=2), encoding="utf-8")
        except Exception:
            pass
        _my_deployments_wake.set()
        print(f"late-gate sweeper: release {release_id} {env_name} -> {message}")


def _background_auto_approve_sweeper():
    while True:
        try:
            _sweep_late_approvals()
        except Exception as e:
            print("late-gate sweeper error:", e)
        time.sleep(AUTO_APPROVE_SWEEP_SECONDS)


_refreshers_started = False


def _start_background_refreshers():
    global _refreshers_started
    if _refreshers_started:
        return
    _refreshers_started = True
    threading.Thread(target=_background_refresher, daemon=True).start()
    threading.Thread(target=_background_refresher_live_status, daemon=True).start()
    threading.Thread(target=_background_refresher_deployments, daemon=True).start()
    threading.Thread(target=_background_auto_approve_sweeper, daemon=True).start()


_start_background_refreshers()


def _validate_body(r, url):
    # Callers immediately do r.json() on a success-status response -- confirmed live 2026-08-07
    # that ADO can return HTTP 200 with an empty/garbled body on an otherwise-valid POST, which
    # blew up with "Expecting value: line 1 column 1" and permanently failed the whole deployment
    # run. A real 4xx is returned as-is (not transient) so existing status-code checks at call
    # sites keep working unchanged.
    if r.status_code < 400 and r.text.strip():
        try:
            r.json()
        except ValueError:
            raise _Transient(f"invalid JSON body from {url}: {r.text[:200]!r}")


def _post(url, body):
    def attempt():
        try:
            r = _SESSION.post(url, headers={**HEADERS, "Content-Type": "application/json"}, json=body, timeout=30)
        except (requests.ConnectionError, requests.Timeout) as e:
            raise _Transient(str(e))
        _check_transient(r, url)
        _validate_body(r, url)
        return r

    return _retry(attempt)


def _patch(url, body):
    def attempt():
        try:
            r = _SESSION.patch(url, headers={**HEADERS, "Content-Type": "application/json"}, json=body, timeout=30)
        except (requests.ConnectionError, requests.Timeout) as e:
            raise _Transient(str(e))
        _check_transient(r, url)
        _validate_body(r, url)
        return r

    return _retry(attempt)


def _put(url, body):
    """PUT with the same transient-retry semantics as _post/_patch.

    Used only for release-definition writes. Retrying is safe here specifically BECAUSE the body
    carries the definition's `revision`: ADO rejects a second write against a revision that has
    already been consumed, so a retry after a genuine partial failure cannot double-apply."""
    def attempt():
        try:
            r = _SESSION.put(url, headers={**HEADERS, "Content-Type": "application/json"},
                             json=body, timeout=60)
        except (requests.ConnectionError, requests.Timeout) as e:
            raise _Transient(str(e))
        _check_transient(r, url)
        _validate_body(r, url)
        return r

    return _retry(attempt)


def _split_list(raw: str) -> list:
    parts = re.split(r"\s*(?:,|&|\band\b)\s*", raw.strip(), flags=re.IGNORECASE)
    return [p.strip() for p in parts if p.strip()]


_FIELD_LABEL_RE = re.compile(
    r"(Pipelines?|Branch|ENVs?)\s*:\s*(.+?)(?=\n|$|\s+(?:ENVs?|Pipelines?|Branch)\s*:)",
    re.IGNORECASE,
)
_FIELD_KIND = {"pipeline": "pipeline", "pipelines": "pipeline", "branch": "branch", "env": "env", "envs": "env"}


def _parse_deploy_text(text: str):
    matches = list(_FIELD_LABEL_RE.finditer(text))
    if not matches:
        return None

    blocks = []
    current = {}
    for m in matches:
        kind = _FIELD_KIND.get(m.group(1).strip().lower())
        value = m.group(2).strip()
        if not kind or not value:
            continue
        if kind in current:
            blocks.append(current)
            current = {}
        current[kind] = value
    if current:
        blocks.append(current)

    combos = []
    for b in blocks:
        pipeline_raw, branch, env_raw = b.get("pipeline"), b.get("branch"), b.get("env")
        if not (pipeline_raw and branch and env_raw):
            continue
        branch = branch.split()[0]
        for p in _split_list(pipeline_raw):
            for e in _split_list(env_raw):
                combos.append((p, branch, e.upper()))

    if not combos:
        return None
    return {"combos": combos}


def _parse_deploy_text_ai(text: str):
    prompt = (
        "Extract a deployment request from the text below into ONLY this JSON shape, nothing else:\n"
        '{"pipelines": ["..."], "envs": ["..."], "branch": "..."}\n\n'
        "Rules:\n"
        "- \"pipelines\": every pipeline/app name mentioned. Pipeline names are often TWO words "
        "(e.g. \"drm sanity\", \"magrabi storefront\", \"ecom tabby\") -- extract the FULL name, "
        "never just the first word.\n"
        "- \"envs\": every environment mentioned (e.g. DEV, SIT, UAT, PROD), uppercase.\n"
        "- \"branch\": the single branch name mentioned -- copy it exactly, including any slashes.\n"
        "- CRITICAL: only extract what is EXPLICITLY written in the text. Do NOT add any pipeline, "
        "environment, or branch that isn't literally mentioned.\n"
        "- Output ONLY the JSON object. No explanation, no markdown fences.\n\n"
        f"Text:\n{text}"
    )
    try:
        r = _SESSION.post(f"{OLLAMA_URL}/api/generate", json={
            "model": OLLAMA_MODEL, "prompt": prompt, "stream": False, "format": "json",
            "options": {"temperature": 0},
        }, timeout=30)
        r.raise_for_status()
        data = json.loads(r.json().get("response", ""))
        pipelines = [p.strip() for p in data.get("pipelines", []) if isinstance(p, str) and p.strip()]
        envs = [e.strip().upper() for e in data.get("envs", []) if isinstance(e, str) and e.strip()]
        branch = (data.get("branch") or "").strip()
        if not (pipelines and envs and branch):
            return None
        return {"pipelines": pipelines, "branch": branch, "envs": envs}
    except Exception:
        return None


# How long to wait for ADO to materialise the pending approval after triggering an environment.
#
# This used to be a flat 25s, chosen to stay comfortably under a 1-minute auto-reject -- correct for
# the stages that actually use a 1-minute gate, which is most of ECom. It silently broke every stage
# with a longer gate. Release 8864 (CD-Ecom-Checkout def 35, DEV, 2026-08-20): that definition gives
# its stages TEN minutes, and ADO took ~32s to surface the approval through either the approvals list
# or the release detail. The portal gave up at 25s on a gate that had nine and a half minutes left,
# and the deployment sat waiting for a human. Three sibling pipelines in the same submission
# (paymob 8862, search-app 8863, tabby 8865) approved first time -- their releases were not slow.
#
# So the budget is derived from the stage's own configured timeout, floored at a value taken from
# how long gates ACTUALLY take to appear: 95 approvals measured on 1-minute gates, median 7.2s but
# worst case 59.9s. The floor was 25s, and the old formula then subtracted a 15s margin from the
# stage timeout, giving a 1-minute stage a 45s budget -- shorter than that measured worst case, so
# anything in the tail was abandoned seconds before its gate appeared. 90s covers the tail with
# room to spare and still bounds the thread.
_APPROVAL_APPEAR_SECONDS_FLOOR = 90
# Ceiling regardless of the configured gate: some stages have no timeout at all (timeoutInMinutes 0),
# and a worker thread must not park for hours holding the run's (pipeline, branch, env) claim.
_APPROVAL_APPEAR_SECONDS_MAX = 150
# Kept for the redeploy-approve route, which runs inside a request and must answer quickly.
_APPROVAL_APPEAR_TIMEOUT_SECONDS = 25


def _approval_wait_budget(project=None, definition_id=None, env_name: str = "") -> float:
    """Seconds to wait for a gate to APPEAR after the stage was triggered.

    Falls back to the floor whenever the timeout cannot be read. The floor is measured, not
    guessed -- see _APPROVAL_APPEAR_SECONDS_FLOOR.
    """
    minutes = None
    if project and definition_id:
        try:
            minutes = _approval_timeout_minutes(project, definition_id, env_name)
        except Exception:
            minutes = None
    if minutes is None:
        return float(_APPROVAL_APPEAR_SECONDS_FLOOR)
    if minutes <= 0:
        # 0 means "no timeout configured" in ADO, not "expires immediately" -- verified live on
        # stages that held an approval for over five hours. Those get the ceiling, not the floor.
        # Reachable only since the definition table started storing 0 instead of discarding it.
        return float(_APPROVAL_APPEAR_SECONDS_MAX)
    # No margin is subtracted. These are two INDEPENDENT clocks: ADO starts the gate's countdown
    # when it CREATES the approval, not when the stage was triggered, so time spent here waiting
    # for the gate to appear never eats into the window we have to answer it in. Subtracting a
    # margin only ever made us give up early.
    return float(max(_APPROVAL_APPEAR_SECONDS_FLOOR, min(minutes * 60, _APPROVAL_APPEAR_SECONDS_MAX)))

# operationStatus values that mean the deployment is genuinely under way, i.e. no gate is holding it.
_REALLY_RUNNING_OPS = {"queuedforagent", "queuedforpipeline", "phaseinprogress", "approved",
                       "queued", "succeeded"}
# ...and the ones that mean the exact opposite: it is parked waiting on a person.
_WAITING_OPS = {"pending", "manualinterventionpending", "evaluatinggates"}
# ...and the ones that only mean "ADO accepted the trigger". They are inside _REALLY_RUNNING_OPS
# because for a genuinely gate-free stage they DO mean the work started -- but they are worthless
# as EVIDENCE that no gate exists, because ADO sets them before it creates the approval record.
# That is the whole of the 2026-08-24 defect (releases 8949/8951/8953).
_JUST_TRIGGERED_OPS = {"queued", "queuedforagent", "queuedforpipeline"}


def _environment_has_no_gate(current_env, strict: bool = False) -> bool:
    """True only when this environment genuinely has no pre-deploy approval to wait for.

    THIS MUST NOT BE INFERRED FROM env.status. The old test was
    `status not in ("notStarted", "scheduled")` -- but ADO reports an environment PARKED ON A
    PENDING APPROVAL as status "inProgress" (verified repeatedly, and it is the same trap behind the
    original "Deploying... with no approve button" defect). So on the very first poll, a fraction of
    a second after the trigger PATCH and before ADO had created the approval record, that test saw
    "inProgress", concluded there was no gate, returned SUCCESS to the user, and never approved
    anything. The gate then auto-rejected 60 seconds later.

    Observed end to end on release 8676 / env 28555 (DEV) on 2026-08-17: attempt 2 was queued by the
    portal at 11:32:59 (reason=manual), its approval 30273 was created at 11:32:59.827 and was never
    approved, auto-rejecting at 11:33:59.9. The user's own successful approval came from ADO
    directly at 11:34:48 -- with an empty comment, where a portal approval always writes
    "Approved via Magrabi Deployment Portal". That is the signature of this bug.

    The safe reading: a gate exists if ADO has recorded ANY pre-deploy approval, or if the latest
    attempt is sitting in a waiting operationStatus. Only call it no-gate when there are no approval
    records at all AND the deployment has visibly moved on to real work.

    That was still not enough, and the same bug returned on 2026-08-24 (releases 8949 SIT,
    8951 UAT, 8953 DEV): "visibly moved on to real work" was reading operationStatus "queued",
    which ADO sets BEFORE it creates the approval record. Empty approvals plus queued looked
    identical to a gate-free stage, so all three reported "no approval gate", approved nothing,
    and auto-rejected 60s later. Definition 41 rev 363 has a manual gate on every one of its five
    stages.

    THE REAL FIX IS NOT IN THIS FUNCTION. Runtime state cannot answer this question in the seconds
    after a trigger, no matter how the test is written. Callers must ask _stage_has_manual_gate
    first, which reads the definition, and only fall back to this heuristic when the definition
    says there is no gate (or could not be read, in which case pass strict=True).
    """
    if not isinstance(current_env, dict):
        return False
    if current_env.get("preDeployApprovals"):
        return False
    steps = current_env.get("deploySteps") or []
    op = ((steps[-1].get("operationStatus") or "").strip().lower()) if steps else ""
    if op in _WAITING_OPS:
        return False
    # A finished deployment is proof whatever it was, and stays proof in strict mode.
    if current_env.get("status") in ("succeeded", "partiallySucceeded", "failed"):
        return True
    # strict=True is for when the DEFINITION could not be read, so we have no authoritative answer
    # and are back to inferring. In that state a merely-triggered stage must not count.
    if strict and op in _JUST_TRIGGERED_OPS:
        return False
    return op in _REALLY_RUNNING_OPS


def _approve_environment(rbase: str, release_id: int, env_name: str,
                         project=None, definition_id=None) -> tuple:
    """Waits for the pre-deploy approval gate to appear and approves it.

    Factored out of api_redeploy_approve so the rebuild path can reuse the exact same logic --
    including the no-gate detection, which was hard-won: some environments have no approval
    configured at all and their preDeployApprovals list stays empty forever, so "no approval
    appeared" has to be read as success rather than a timeout (confirmed live 2026-08-07).

    Returns (ok, message).
    """
    approval_id = None
    want = (env_name or "").strip().lower()
    deadline = time.monotonic() + _approval_wait_budget(project, definition_id, env_name)

    # Settled ONCE, before any polling. When a manual gate is configured, an empty approvals list
    # means "not yet" and never "there is none", so the runtime shortcut below is not allowed to
    # run at all.
    #
    # Without this, on 2026-08-24 releases 8949 SIT, 8951 UAT and 8953 DEV each reported
    # "no approval gate", approved nothing, and were auto-rejected 60s later -- while every stage
    # of definition 41 in fact had a manual gate. 5 of that day's 36 auto-approve runs were lost
    # the same way, and 4 of 27 on 2026-08-20.
    #
    # The release's own snapshot is preferred; the definition is only a fallback. See
    # _snapshot_has_manual_gate for why -- in short, the definition read is for the LATEST
    # revision, not the one this release was cut from.
    gate_configured = None
    try:
        gate_configured = _snapshot_has_manual_gate(_find_release_environment(
            _get(f"{rbase}/release/releases/{release_id}?api-version={API_VERSION}"), env_name))
    except Exception:
        gate_configured = None
    if gate_configured is None:
        gate_configured = _stage_has_manual_gate(project, definition_id, env_name)
    while time.monotonic() < deadline:
        data = _get(f"{rbase}/release/approvals?releaseIdsFilter={release_id}&statusFilter=pending&api-version={API_VERSION}")
        match = next((a for a in data.get("value", [])
                      if ((a.get("releaseEnvironment") or {}).get("name") or "").strip().lower() == want),
                     None)
        if match:
            approval_id = match["id"]
            break
        if gate_configured:
            # A gate is known to exist. Nothing the runtime state says can change that, so skip
            # the extra release GET entirely and just keep waiting for the approval to surface.
            time.sleep(0.5)
            continue
        current = _get(f"{rbase}/release/releases/{release_id}?api-version={API_VERSION}")
        current_env = _find_release_environment(current, env_name)
        # strict only when the definition could not be read at all (None). When it positively says
        # gate-free -- true for exactly 3 stages in this estate, CD-Magrabi-Sanity SIT and
        # CD-Ecom-Promotion-Dashboard UAT/PROD_TAG -- the ordinary test is correct and fast.
        if _environment_has_no_gate(current_env, strict=(gate_configured is None)):
            return True, f"{env_name} has no approval gate on this pipeline -- deployment is running, nothing to approve"
        time.sleep(0.5)

    if not approval_id:
        # Deliberately a FAILURE, not a shrug. The environment has been triggered and is sitting on
        # a gate we could not action, and the caller has to know a person may need to approve it.
        # The caller retries once before showing this, so reaching here means it stayed invisible.
        return False, ("triggered, but its approval did not appear in time to be approved -- "
                       "approve it in Azure DevOps if it is still waiting")

    _patch(f"{rbase}/release/approvals/{approval_id}?api-version={API_VERSION}",
           {"status": "approved", "comments": "Approved via Magrabi Deployment Portal"})
    check = _get(f"{rbase}/release/approvals/{approval_id}?api-version={API_VERSION}")
    if check.get("status") != "approved":
        return False, f"approval did not stick, read-back shows: {check.get('status')}"
    return True, f"{env_name} approved -- deployment is now running"


# In-flight (pipeline, branch, env) targets, so the same deployment cannot be started twice.
_active_runs_lock = threading.Lock()
_active_run_keys = set()


def _run_key(parsed: dict) -> tuple:
    return (
        _normalize_pipeline_name(parsed.get("pipeline") or ""),
        (parsed.get("branch") or "").strip(),
        (parsed.get("env") or "").strip().upper(),
    )


def _claim_run(parsed: dict) -> bool:
    """Marks a pipeline+branch+env as in flight; False when one already is.

    This is the fix for duplicate rows: a CI build takes minutes and the old UI gave no immediate
    feedback, so a second click ~20s later was routine and produced a second real build against the
    same target. Guarding on the live worker set rather than on run-file phases keeps a legitimate
    later rebuild of the same target working -- only an overlapping one is refused.
    """
    key = _run_key(parsed)
    with _active_runs_lock:
        if key in _active_run_keys:
            return False
        _active_run_keys.add(key)
        return True


def _release_run(parsed: dict) -> None:
    with _active_runs_lock:
        _active_run_keys.discard(_run_key(parsed))


def _batch_key_for(audit: dict) -> str:
    """Groups runs that were submitted together in one request.

    New runs carry an explicit `batchId` stamped by the route that created them. Runs written before
    that existed fall back to their start time truncated to the second plus the requester -- one
    paste creates all its run files inside the same millisecond, so that reconstructs the grouping
    for history without needing to rewrite old files."""
    bid = audit.get("batchId")
    if bid:
        return str(bid)
    started = (audit.get("startedAt") or "")[:19]      # to the second
    who = (audit.get("request") or {}).get("requestedBy") or ""
    return f"legacy:{started}:{who}" if started else ""


def _seed_run_file(parsed: dict, reuse_path=None, batch_id=None):
    """Writes a run's audit file in its initial queued state and returns the path.

    Called from the request thread, not the worker, so the row is already showing the new attempt
    by the time the POST returns. Previously the first write happened inside the background thread,
    which left the old (failed) row on screen until the next poll caught up -- the gap people were
    filling by clicking Rebuild again.

    With reuse_path set the SAME file is rewritten rather than a new one created, so a rebuild
    updates its row in place instead of appending a second row for the same thing. The superseded
    attempt is retained inside the file under "attempts", so the audit trail survives the reuse.
    """
    started_at = datetime.now(timezone.utc).isoformat()
    audit = {"startedAt": started_at, "request": parsed, "calls": [], "phase": "queued"}
    # Stamped by the caller when one submission fans out to several pipeline/env combos, so the UI
    # can show "these five were requested together" instead of five unrelated-looking rows.
    if batch_id:
        audit["batchId"] = batch_id

    if reuse_path is not None:
        try:
            previous = json.loads(Path(reuse_path).read_text(encoding="utf-8"))
        except Exception:
            previous = {}
        history = list(previous.get("attempts") or [])
        if previous.get("startedAt"):
            history.append({
                "startedAt": previous.get("startedAt"),
                "phase": previous.get("phase"),
                "releaseId": previous.get("releaseId"),
                "buildId": previous.get("buildId"),
                "error": previous.get("error"),
            })
        # Bounded: a row rebuilt all day should not grow a file the refresher has to re-parse.
        audit["attempts"] = history[-10:]
        # A rebuild must not fall out of the batch it was submitted with.
        if not batch_id and previous.get("batchId"):
            audit["batchId"] = previous["batchId"]
        path = Path(reuse_path)
    else:
        pipeline_key = re.sub(r"[^a-zA-Z0-9]+", "-", parsed["pipeline"].lower()).strip("-")
        path = RUNS_DIR / f"{started_at.replace(':', '-')}_{pipeline_key}.json"

    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(audit, indent=2, default=str), encoding="utf-8")
    _publish_run_seed(path, audit)
    _my_deployments_wake.set()
    _deployments_wake.set()
    return path


def _publish_run_seed(path, audit) -> None:
    """Patches the already-published row for this run to its restarted state, synchronously.

    The refresher gets there within a cycle anyway, but the frontend invalidates and refetches the
    moment the POST returns -- and a GET that lands before the next tick answers out of the cache
    with the PRE-rebuild snapshot, flashing the old REJECTED badge back onto a row the user just
    restarted. That flash is the thing this whole change exists to remove, so the window is closed
    here rather than left to timing.

    Rebuilds the list instead of mutating rows in place: another thread can be serializing these
    dicts for a response at the same moment.
    """
    run_id = Path(path).stem
    patch = {
        "status": audit.get("phase") or "queued",
        "startedAt": audit.get("startedAt"),
        "releaseId": None, "releaseName": "", "releaseDefinitionName": "", "releaseUrl": "",
        "buildId": None, "buildNumber": "", "buildUrl": "", "environmentId": None,
        "approvalStatus": None, "approvalUrl": None, "failureReason": None,
        "approvalCreatedOn": None, "approvalTimeoutMinutes": None, "approvalDeadline": None,
        "batchId": _batch_key_for(audit) if audit.get("batchId") else "",
        "attempt": len(audit.get("attempts") or []) + 1,
    }
    with _cache_lock:
        rows = _cache.get("my_deployments") or []
        _cache["my_deployments"] = [
            {**row, **patch} if row.get("runId") == run_id else row for row in rows
        ]


# How often a queued CI build is re-checked. Was 15s, which is most of why a finished build kept
# reading as "building" on the portal long after ADO showed it green.
BUILD_POLL_SECONDS = 3
# Same reasoning for the wait between "build finished" and "the release ADO auto-created for it
# exists". Attempt count raised to keep the overall ceiling at ~60s.
RELEASE_SEARCH_ATTEMPTS = 20
RELEASE_SEARCH_SECONDS = 3


def _new_deployment_worker(parsed: dict, cfg: dict, auto_approve: bool = False, run_path=None,
                           resume_build_id=None, batch_id=None):
    """Drives one deployment: queue CI build -> wait -> find/create release -> trigger -> (approve).

    `resume_build_id` re-enters this for a run whose worker no longer exists -- see
    _recover_orphaned_runs(). It skips only the queue-a-build step and picks the existing build up
    from the poll loop, so a resumed run follows exactly the same path as a fresh one.
    """
    if run_path is None:
        run_path = _seed_run_file(parsed, batch_id=batch_id)
    try:
        audit = json.loads(Path(run_path).read_text(encoding="utf-8"))
    except Exception:
        audit = {"startedAt": datetime.now(timezone.utc).isoformat(), "request": parsed,
                 "calls": [], "phase": "queued"}
    project = cfg["project"]
    bbase, rbase = build_base(project), release_base(project)

    def record(method, url, body, status, resp):
        # "at" matters more than it looks: without it the audit cannot show how long after the
        # trigger a gate appeared, which is the one number needed to size the approval wait budget.
        # Diagnosing the 2026-08-24 no-gate defect needed pod logs correlated by hand because
        # these records carried no time at all.
        audit["calls"].append({"at": datetime.now(timezone.utc).isoformat(), "method": method,
                               "url": url, "body": body, "status": status, "response": resp})

    def save():
        RUNS_DIR.mkdir(parents=True, exist_ok=True)
        Path(run_path).write_text(json.dumps(audit, indent=2, default=str), encoding="utf-8")
        # Publishes this phase change on the next refresher tick rather than up to a full interval
        # later -- the other half of why the table used to lag behind ADO.
        _my_deployments_wake.set()
        _deployments_wake.set()

    try:
        # Recorded so a resume knows whether the original request wanted the approval gate cleared
        # unattended. Without it a recovered run would have to guess, and guessing "yes" would
        # approve a deployment nobody asked this portal to approve.
        audit["autoApprove"] = bool(auto_approve)

        if resume_build_id:
            build_id = resume_build_id
            audit["buildId"] = build_id
            audit["phase"] = "building"
            audit["resumedAt"] = datetime.now(timezone.utc).isoformat()
            save()
        else:
            build_url = f"{bbase}/build/builds?api-version={API_VERSION}"
            build_body = {"definition": {"id": cfg["ci_id"]}, "sourceBranch": f"refs/heads/{parsed['branch']}"}
            r = _post(build_url, build_body)
            build = r.json()
            record("POST", build_url, build_body, r.status_code, build)
            build_id = build.get("id")
            if not build_id:
                audit["phase"] = "failed"
                audit["error"] = f"queue build failed: HTTP {r.status_code}: {json.dumps(build)[:300]}"
                return

            audit["phase"] = "building"
            # Recorded explicitly so the row can name and link its build while it is still running,
            # instead of the frontend having nothing to show until a release exists.
            audit["buildId"] = build_id
            audit["buildNumber"] = build.get("buildNumber") or ""
            save()

        poll_url = f"{bbase}/build/builds/{build_id}?api-version={API_VERSION}"
        last_seen = None
        while True:
            b = _get(poll_url)
            build_status = b.get("status")
            # Only every CHANGE gets recorded, not every poll. At a 3s cadence a ten-minute build
            # would otherwise append ~200 full API responses to this file -- which the refresher
            # re-parses on every cycle, so logging them all would have cost back more than the
            # faster polling gained.
            if build_status != last_seen:
                record("GET", poll_url, None, 200, b)
                last_seen = build_status
                audit["buildStatus"] = build_status
                save()
            if build_status == "completed":
                break
            time.sleep(BUILD_POLL_SECONDS)
        if b.get("result") != "succeeded":
            audit["phase"] = "failed"
            # ADO reports pre-flight failures -- a ref that does not resolve, a missing service
            # connection, a definition that will not validate -- in validationResults and NOWHERE
            # else. The build never reaches an agent, so there is no task log and no timeline to
            # open, and the row previously read "CI build failed (result=failed)" with no way to
            # find out why. This is the only place that text exists.
            problems = "; ".join(
                (v.get("message") or "").strip()
                for v in (b.get("validationResults") or [])
                if v.get("result") in ("error", "warning") and (v.get("message") or "").strip()
            )
            audit["error"] = (f"CI build failed: {problems}" if problems
                              else f"CI build failed (result={b.get('result')})")
            return

        audit["phase"] = "creating-release"
        save()

        release = None
        search_url = f"{rbase}/release/releases?api-version={API_VERSION}"
        for attempt_no in range(RELEASE_SEARCH_ATTEMPTS):
            found = _get(search_url, params={
                "definitionId": cfg["cd_id"], "artifactTypeId": "Build",
                "artifactVersionId": build_id, "statusFilter": "active",
            })
            # Only the decisive poll is recorded -- the hit, or the last miss before giving up.
            # Same reasoning as the build loop: 20 identical "not there yet" responses in the audit
            # file are pure weight on every subsequent refresh.
            if found.get("count", 0) > 0:
                record("GET", search_url, {"definitionId": cfg["cd_id"], "artifactVersionId": build_id}, 200, found)
                rid = found["value"][0]["id"]
                release = _get(f"{rbase}/release/releases/{rid}?api-version={API_VERSION}")
                record("GET", f"{rbase}/release/releases/{rid}", None, 200, release)
                break
            if attempt_no == RELEASE_SEARCH_ATTEMPTS - 1:
                record("GET", search_url, {"definitionId": cfg["cd_id"], "artifactVersionId": build_id}, 200, found)
                break
            time.sleep(RELEASE_SEARCH_SECONDS)

        if not release:
            create_url = f"{rbase}/release/releases?api-version={API_VERSION}"
            create_body = {
                "definitionId": cfg["cd_id"],
                "description": f"Automated deploy for build {build_id}",
                "artifacts": [{"alias": cfg["alias"], "instanceReference": {"id": str(build_id)}}],
                "isDraft": False, "reason": "manual",
            }
            r = _post(create_url, create_body)
            release = r.json()
            record("POST", create_url, create_body, r.status_code, release)

        release_id = release.get("id")
        # Saved before anything else happens to it: once a row carries a releaseId every refresh
        # reads that environment's status live from ADO, so this write is what switches the row
        # from portal-reported phases to real deployment status.
        audit["releaseId"] = release_id
        save()
        env_obj = next((e for e in release.get("environments", []) if e["name"] == parsed["env"]), None)
        if not env_obj:
            available = [e["name"] for e in release.get("environments", [])]
            audit["phase"] = "failed"
            audit["error"] = f"no environment named {parsed['env']!r} on release {release_id}. Available: {available}"
            return

        trigger_url = (f"{rbase}/Release/releases/{release_id}/environments/{env_obj['id']}"
                       f"?api-version={API_VERSION}")
        trigger_body = {"status": "inProgress", "comment": "Automated deploy via portal new-deployment box"}
        r = _patch(trigger_url, trigger_body)
        try:
            trigger_resp = r.json()
        except ValueError:
            trigger_resp = r.text[:300]
        record("PATCH", trigger_url, trigger_body, r.status_code, trigger_resp)
        if r.status_code >= 400 and "InProgress" not in str(trigger_resp):
            audit["phase"] = "failed"
            audit["error"] = f"trigger failed: HTTP {r.status_code}: {trigger_resp}"
            return

        approval_url = (f"https://dev.azure.com/{ORG}/{project}/_releaseProgress"
                         f"?_a=release-pipeline-progress&releaseId={release_id}")
        audit["readyForApprovalUrl"] = approval_url
        # The environment has been triggered at this point. An auto-approving run is on its way to
        # deploying, so say so instead of showing "ready-for-approval" for the seconds the gate
        # takes to clear; a hand-approved run really is waiting for a human.
        audit["phase"] = "deploying" if auto_approve else "ready-for-approval"
        save()

        # Every portal-started deployment clears its own gate, so the user is never asked to come
        # back and press a second button inside a 60-second window.
        #
        # Measured across 125 portal-driven stage instances (2026-07-20 to 2026-08-19): 64 of them
        # (51.2%) had their FIRST attempt auto-rejected by ADO's approval timeout and only succeeded
        # on a hand-driven second attempt -- and 48 of those were stages this worker had itself just
        # triggered and then left sitting on a gate it never tried to clear. Where it does approve,
        # it is never late: 95 approvals on 1-minute gates, median 7.2s, worst 59.9s.
        #
        # A failure to approve is recorded but deliberately does NOT mark the run failed: the build
        # and release both genuinely succeeded at this point, and the deployment is still sitting
        # there waiting to be approved by hand.
        if auto_approve:
            approve_args = (rbase, release_id, parsed["env"], cfg.get("project"), cfg.get("cd_id"))
            ok, message = _approve_environment(*approve_args)
            if not ok:
                audit["approvalResult"] = f"{message} -- checking the gate"
                save()
                current = _get(f"{rbase}/release/releases/{release_id}?api-version={API_VERSION}")
                current_env = _find_release_environment(current, parsed["env"]) or {}
                approvals = current_env.get("preDeployApprovals") or []
                latest = approvals[-1] if approvals else None
                latest_status = ((latest or {}).get("status") or "").strip().lower()

                if latest_status == "approved":
                    # Cleared while we were polling -- by a person in ADO, or by the portal's own
                    # Approve button, or by a sibling attempt. Either way the deployment is
                    # running. Reporting failure here would put a healthy release on the
                    # needs-attention list and invite a pointless second deployment.
                    ok = True
                    message = (f"{parsed['env']} was approved while the portal was waiting -- "
                               f"deployment is running")
                elif latest_status == "pending":
                    # The gate appeared AFTER we stopped looking -- ADO can take ~30s to surface an
                    # approval through either the approvals list or the release detail (release 8864,
                    # 2026-08-20). Approve it where it stands. Re-triggering here would abandon a
                    # perfectly good pending approval and start a needless second attempt.
                    ok, message = _approve_environment(*approve_args)
                    if ok:
                        message = f"{message} (the gate appeared late)"
                elif latest is not None and _approval_timed_out(latest):
                    # ADO's timeout robot killed it. Re-triggering opens a FRESH approval, which is
                    # exactly what "attempt 2 of 2" means on a release -- and is what the user was
                    # otherwise doing by hand.
                    r2 = _patch(trigger_url, trigger_body)
                    record("PATCH", trigger_url, trigger_body, r2.status_code,
                           f"re-triggered after: {message}")
                    ok, message = _approve_environment(*approve_args)
                    if ok:
                        message = f"{message} (second attempt -- the first gate expired)"
                # Anything else -- a person rejected it, or the stage already moved on -- is
                # deliberately left alone rather than answered by queuing the deployment again.
            audit["approvalResult"] = message
            audit["phase"] = "approved" if ok else "ready-for-approval"
    except Exception as e:
        audit["phase"] = "failed"
        audit["error"] = str(e)
    finally:
        save()
        # Frees the target for a future rebuild. Must be in the finally: a worker that dies on an
        # exception would otherwise block every later attempt at the same pipeline+branch+env for
        # the life of the process.
        _release_run(parsed)


# Resuming a stranded run is a WRITE to Azure DevOps: it creates a release and triggers the
# environment. That is exactly what the user asked for when they submitted the deployment, but it
# happens automatically at process start with nobody watching, so it is behind an explicit switch
# rather than on by default. Set RESUME_ORPHANED_RUNS=true to enable.
#
# With it off, recovery still runs and still corrects the row (a stranded run stops claiming to be
# BUILDING) -- it just will not act on ADO. Local file writes only.
RESUME_ORPHANED_RUNS = os.environ.get("RESUME_ORPHANED_RUNS", "false").strip().lower() == "true"

# Runs older than this are reported rather than resumed. Re-entering a day-old run would queue ADO
# work nobody is expecting any more, and its build has almost certainly been garbage collected.
_RESUME_MAX_AGE_HOURS = 6


def _recover_orphaned_runs():
    """Adopts deployments whose worker died with a previous process.

    Worker state lives only in a thread. When the pod is replaced -- a rollout, an eviction, a node
    upgrade, an OOM kill -- every in-flight run is stranded at whatever phase it had reached, and
    the row shows BUILDING forever even though the CI build went on to finish perfectly well.
    Observed 2026-08-17 on build 15777 (`Ecom-saleor-core`, SIT): the build succeeded at 11:49:48Z,
    but the pod owning its worker had been replaced at 11:41:34Z, so no release was ever created.

    Nothing here is destructive: it re-enters the same worker with the build id the run already
    recorded, so the run continues exactly where it left off. A run too old to resume, or one that
    never got as far as queuing a build, is marked failed with a plain reason instead of being left
    to look like it is still working.
    """
    if not RUNS_DIR.exists():
        return
    resumed = stale = skipped = 0
    for path in sorted(glob.glob(str(RUNS_DIR / "*.json")), reverse=True)[:100]:
        try:
            audit = json.loads(Path(path).read_text(encoding="utf-8"))
        except Exception:
            continue
        if audit.get("phase") not in _RESUMABLE_PHASES:
            continue
        # A releaseId means ADO is already the source of truth for this row; it is not stranded.
        if audit.get("releaseId"):
            continue

        parsed = audit.get("request") or {}
        cfg = _resolve_pipeline(parsed.get("pipeline") or "")
        started = audit.get("startedAt") or ""
        try:
            age_h = (datetime.now(timezone.utc)
                     - datetime.fromisoformat(started)).total_seconds() / 3600.0
        except ValueError:
            age_h = _RESUME_MAX_AGE_HOURS + 1

        build_id = audit.get("buildId")
        if not cfg or not build_id or age_h > _RESUME_MAX_AGE_HOURS:
            audit["phase"] = "failed"
            audit["error"] = (
                "the portal restarted while this deployment was running and it could not be "
                "resumed automatically -- start it again"
                if not build_id else
                f"the portal restarted while this deployment was running (build {build_id}); it was "
                f"{'too old' if age_h > _RESUME_MAX_AGE_HOURS else 'not resumable'} to pick back up "
                f"-- check the build in ADO and redeploy if it succeeded")
            try:
                Path(path).write_text(json.dumps(audit, indent=2, default=str), encoding="utf-8")
            except Exception:
                pass
            stale += 1
            continue

        if not RESUME_ORPHANED_RUNS:
            # Report only. The row already resolves honestly from the build's real state via
            # _build_state(), so nothing here needs to lie -- we simply do not touch ADO.
            skipped += 1
            continue

        # Claim the target so a user starting the same pipeline+branch+env right now does not race
        # the resumed worker. If it is already claimed, something live owns it -- leave it alone.
        if not _claim_run(parsed):
            continue
        threading.Thread(
            target=_new_deployment_worker,
            args=(parsed, cfg),
            kwargs={"auto_approve": bool(audit.get("autoApprove")), "run_path": path,
                    "resume_build_id": build_id},
            daemon=True,
        ).start()
        resumed += 1

    if resumed or stale or skipped:
        print(f"orphan recovery: resumed {resumed}, marked {stale} unrecoverable, "
              f"left {skipped} for a human (RESUME_ORPHANED_RUNS is off)")
    _my_deployments_wake.set()


# Runs once per process, on a thread so a slow ADO call cannot hold up gunicorn's startup. It has to
# live here rather than in _start_background_refreshers() (which executes far earlier in this
# module) because it depends on _new_deployment_worker, defined above.
#
# Safe with `--workers 1`, which is what the Dockerfile runs: a single process means a single
# recovery pass. Raising the worker count would need a lock outside the process, since two workers
# would otherwise both try to adopt the same run file.
_recovery_started = False


def _start_orphan_recovery():
    global _recovery_started
    if _recovery_started:
        return
    _recovery_started = True
    threading.Thread(target=_recover_orphaned_runs, daemon=True).start()


_start_orphan_recovery()


# ---------------------------------------------------------------------------------------------
# Auth -- two simple accounts, no Entra ID (explicit decision, 2026-08-06).
# ---------------------------------------------------------------------------------------------
# Credential *hashes* (bcrypt) come from the environment -- backed by a K8s Secret in the cluster,
# a .secrets/portal-auth.env file locally. Never store or log the plaintext passwords.
try:
    import bcrypt
except ImportError:  # pragma: no cover - see requirements.txt; fails loudly on purpose if missing
    bcrypt = None

_LOCAL_AUTH_SECRETS = ROOT / ".secrets" / "portal-auth.env"
_load_dotenv_if_present(_LOCAL_AUTH_SECRETS)

ADMIN_USERNAME = os.environ.get("ADMIN_USERNAME", "admin")
ADMIN_PASSWORD_HASH = os.environ.get("ADMIN_PASSWORD_HASH", "")
VIEWER_USERNAME = os.environ.get("VIEWER_USERNAME", "viewer")
VIEWER_PASSWORD_HASH = os.environ.get("VIEWER_PASSWORD_HASH", "")

_ACCOUNTS = {
    ADMIN_USERNAME: {"role": "admin", "hash": ADMIN_PASSWORD_HASH},
    VIEWER_USERNAME: {"role": "viewer", "hash": VIEWER_PASSWORD_HASH},
}


def _check_password(plain: str, hashed: str) -> bool:
    if not plain or not hashed or bcrypt is None:
        return False
    try:
        return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))
    except ValueError:
        return False


def get_identity():
    """The ONLY function anything else should call to find out who's asking. Returns 'admin',
    'viewer', or None. Everything downstream (require_role, /api/me) goes through this -- never
    read session['role'] directly elsewhere, so there's exactly one place this logic can be wrong."""
    return session.get("role")


def get_username() -> str:
    """The account name of whoever is logged in, for attribution only -- never an authorization
    input (that stays get_identity() + require_role()). Read from the signed session for the same
    reason the role is: a submitter must not be able to claim someone else's name in a request
    body. Falls back to the configured account name for sessions issued before the username was
    stored in the cookie, so an already-logged-in user doesn't start filing anonymous feedback."""
    name = session.get("username")
    if name:
        return name
    role = get_identity()
    if role == "admin":
        return ADMIN_USERNAME
    if role == "viewer":
        return VIEWER_USERNAME
    return ""


def require_role(*allowed_roles):
    def decorator(fn):
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            if get_identity() not in allowed_roles:
                return jsonify({"ok": False, "message": "forbidden"}), 403
            return fn(*args, **kwargs)
        return wrapper
    return decorator


@app.route("/api/login", methods=["POST"])
def api_login():
    payload = request.get_json(force=True) or {}
    username, password = payload.get("username", ""), payload.get("password", "")
    account = _ACCOUNTS.get(username)
    if not account or not _check_password(password, account["hash"]):
        return jsonify({"ok": False, "message": "Invalid username or password."}), 401
    session["role"] = account["role"]
    # Stored alongside the role purely so feedback can be attributed to a real account name; the
    # role remains the only thing any access decision is ever made from.
    session["username"] = username
    session.permanent = True
    return jsonify({"ok": True, "role": account["role"]})


@app.route("/api/logout", methods=["POST"])
def api_logout():
    session.clear()
    return jsonify({"ok": True})


@app.route("/api/me")
def api_me():
    """UX convenience for the React shell to decide nav visibility -- NEVER the real security
    boundary. Every actual gate is require_role() on the route itself."""
    return jsonify({"role": get_identity()})


@app.route("/api/health")
def api_health():
    """K8s liveness/readiness probe target. Deliberately NOT /api/live-status -- that reflects
    cache content (which can legitimately be empty right after startup), not process health."""
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------------------------
# Existing routes, gated. Two tiers only: viewers get the status view, nothing else.
# ---------------------------------------------------------------------------------------------
@app.route("/api/new-deployment", methods=["POST"])
@require_role("admin")
def api_new_deployment():
    payload = request.get_json(force=True)
    text = (payload.get("text") or "").strip()
    if not text:
        return jsonify({"ok": False, "message": "Paste a deployment request first."}), 400
    # Optional "who asked for this" tracking field, purely for the portal's own audit trail -- not
    # sent to ADO at all. Defaults to "-------" when left blank, per explicit ask.
    requested_by = (payload.get("name") or "").strip() or "-------"

    parsed = _parse_deploy_text(text)
    parse_method = "labeled fields"
    if parsed:
        combos = parsed["combos"]
    else:
        ai_parsed = _parse_deploy_text_ai(text)
        parse_method = "AI"
        combos = [(p, ai_parsed["branch"], e) for p in ai_parsed["pipelines"] for e in ai_parsed["envs"]] \
            if ai_parsed else None
    if not combos:
        return jsonify({
            "ok": False,
            "message": "Couldn't understand that request -- tried the labeled Pipeline(s): / "
                       "Branch: / ENV(s): format and AI parsing. Try rephrasing.",
        }), 400

    # One id for the whole submission. Only stamped when the paste actually fans out to more than
    # one target -- a single deployment is not a batch and should not render as a group of one.
    batch_id = secrets.token_hex(6) if len(combos) > 1 else None

    started, skipped, corrected = [], [], []
    for pipeline_name, branch, env_name in combos:
        cfg = _resolve_pipeline(pipeline_name)
        label = f"{pipeline_name} / {env_name}"
        # Pipeline first: whether an environment is allowed depends on WHICH pipeline it is, because
        # a few named beta/production stages are allowed for one definition and no other.
        if not cfg:
            skipped.append(f"{label} (unknown pipeline)")
            continue
        if not _env_allowed(cfg, env_name):
            skipped.append(f"{label} ({_env_not_allowed_message(env_name)})")
            continue
        # Check the branch against what the repo really has BEFORE anything is queued. A ref that
        # does not resolve fails inside ADO with no timeline and no log to open, so catching it
        # here is the difference between a usable message and an unexplained red row.
        branch, branch_note, near = _resolve_branch(cfg, branch)
        if branch is None:
            hint = f" Did you mean: {', '.join(near)}?" if near else ""
            skipped.append(f"{label} (branch not in the repo.{hint})")
            continue
        # A listed beta/production stage takes exactly one branch. Checked after resolution, so a
        # mistyped "Master" that resolves to master still goes through, but a real feature branch
        # never reaches a live site.
        problem = _prod_branch_problem(cfg, env_name, branch)
        if problem:
            skipped.append(f"{label} ({problem})")
            continue
        if branch_note:
            corrected.append(f"{label}: {branch_note}")
        run = {"pipeline": pipeline_name, "branch": branch, "env": env_name, "requestedBy": requested_by}
        # Same duplicate guard the rebuild route uses: pasting the same request twice (or a request
        # naming a target that is already mid-deploy) queued a second real build against it.
        if not _claim_run(run):
            skipped.append(f"{label} (already deploying -- watch the existing row)")
            continue
        # auto_approve is ON for everything started from this box. Submitting the request IS the
        # authorisation -- there is no second decision to make between pasting "deploy X to SIT" and
        # the deployment running, and the gate's 1-minute window turned that non-decision into a
        # race the user lost half the time. See the worker for the measured numbers.
        threading.Thread(target=_new_deployment_worker, args=(run, cfg),
                         kwargs={"batch_id": batch_id, "auto_approve": True}, daemon=True).start()
        started.append(label)

    message = f"[{parse_method}] Started {len(started)}: {', '.join(started)}." if started \
        else f"[{parse_method}] Nothing started."
    # Always said out loud. A silently corrected branch is still a different commit than the one
    # that was typed, and the person pasting the request is the only one who can tell whether the
    # spelling was the mistake or the intent.
    if corrected:
        message += f" Branch corrected -- {'; '.join(corrected)}."
    if skipped:
        message += f" Skipped {len(skipped)}: {'; '.join(skipped)}."
    return jsonify({"ok": bool(started), "message": message})


@app.route("/api/redeploy-approve", methods=["POST"])
@require_role("admin")
def api_redeploy_approve():
    payload = request.get_json(force=True)
    release_id, env_name, pipeline_name = payload.get("releaseId"), payload.get("env"), payload.get("pipeline")
    if not release_id or not env_name:
        return jsonify({"ok": False, "message": "releaseId and env are required"}), 400

    # The portal never acts on production or beta, and that has to be CHECKED, not assumed. Until
    # now this route relied on the argument that its button only ever appears on rows the portal
    # itself created for lower environments -- true of the UI, enforced nowhere. releaseId, env and
    # pipeline all arrive from the request body, so an admin session could name a production release
    # directly. The production section puts real production release ids on screen, which turns that
    # argument into a live hole. Same guard as the trigger route.
    pipeline_cfg = _resolve_pipeline(pipeline_name or "")
    if not pipeline_cfg:
        return jsonify({"ok": False, "message": f"unknown pipeline '{pipeline_name}' -- can't tell which ADO project to use"}), 400
    if not _env_allowed(pipeline_cfg, env_name):
        return jsonify({"ok": False, "message": _env_not_allowed_message(env_name)}), 403
    rbase = release_base(pipeline_cfg["project"])

    try:
        detail = _get(f"{rbase}/release/releases/{release_id}?api-version={API_VERSION}")
        env = next((e for e in detail.get("environments", []) if e["name"] == env_name), None)
        if not env:
            return jsonify({"ok": False, "message": f"no {env_name} environment on release {release_id}"}), 404

        r = _patch(f"{rbase}/Release/releases/{release_id}/environments/{env['id']}?api-version={API_VERSION}",
                   {"status": "inProgress"})
        if r.status_code >= 400 and "InProgress" not in r.text:
            return jsonify({"ok": False, "message": f"trigger failed: HTTP {r.status_code}: {r.text[:300]}"}), 502

        approval_id = None
        no_gate = False
        # Same authoritative check the worker does. This route carried the identical defect: it
        # could answer "nothing to approve" for a stage that is in fact gated.
        # `env` came out of the release detail fetched above, so reading its snapshot is free --
        # no second call, and no definition lookup on the common path.
        # The budget stays _APPROVAL_APPEAR_TIMEOUT_SECONDS, not the worker's, because this runs
        # inside a request and has to answer the browser quickly.
        gate_configured = _snapshot_has_manual_gate(env)
        if gate_configured is None:
            gate_configured = _stage_has_manual_gate(pipeline_cfg["project"],
                                                     pipeline_cfg.get("cd_id"), env_name)
        want = (env_name or "").strip().lower()
        deadline = time.monotonic() + _APPROVAL_APPEAR_TIMEOUT_SECONDS
        while time.monotonic() < deadline:
            data = _get(f"{rbase}/release/approvals?releaseIdsFilter={release_id}&statusFilter=pending&api-version={API_VERSION}")
            match = next((a for a in data.get("value", [])
                          if ((a.get("releaseEnvironment") or {}).get("name") or "").strip().lower() == want),
                         None)
            if match:
                approval_id = match["id"]
                break
            # No pending approval YET does not mean there is no gate -- see _environment_has_no_gate.
            # The previous test here read env.status and treated anything past "notStarted" as
            # gate-free, which fired instantly because ADO marks a gated environment "inProgress"
            # the moment it is triggered. That returned "nothing to approve", and the gate then
            # auto-rejected 60s later (release 8676/DEV attempt 2, 2026-08-17).
            if gate_configured:
                time.sleep(0.5)
                continue
            current = _get(f"{rbase}/release/releases/{release_id}?api-version={API_VERSION}")
            current_env = next((e for e in current.get("environments", []) if e["name"] == env_name), None)
            if _environment_has_no_gate(current_env, strict=(gate_configured is None)):
                no_gate = True
                break
            time.sleep(0.5)

        # This route changes ADO state without touching any run file, so the terminal-row cache
        # has to be told -- otherwise the row it just retriggered stays "failed" on screen.
        # _mark_action additionally stops the NEXT resolve from re-caching the stale terminal
        # status that ADO keeps reporting for a few seconds after a retrigger.
        _mark_action(release_id, env_name)
        _invalidate_row_cache(release_id, env_name)

        if no_gate:
            return jsonify({"ok": True, "message": f"{env_name} has no approval gate on this pipeline -- deployment triggered directly, nothing to approve"})

        if not approval_id:
            return jsonify({"ok": False, "message": (
                "retriggered, but its approval did not appear in time to be approved -- approve it "
                "in Azure DevOps now, it expires within a minute")}), 504

        r = _patch(f"{rbase}/release/approvals/{approval_id}?api-version={API_VERSION}",
                   {"status": "approved", "comments": "Approved via Magrabi Deployment Portal"})
        check = _get(f"{rbase}/release/approvals/{approval_id}?api-version={API_VERSION}")
        if check.get("status") != "approved":
            return jsonify({"ok": False, "message": f"approval did not stick, read-back shows: {check.get('status')}"}), 502

        # Re-anchor the grace window to the APPROVAL, not to the trigger above: the seconds that
        # matter for a stale row are the ones after ADO accepts the approval, and the polling loop
        # can burn several before it gets here.
        _mark_action(release_id, env_name)
        _invalidate_row_cache(release_id, env_name)
        return jsonify({"ok": True, "message": f"{env_name} approved -- deployment is now running"})
    except Exception as e:
        return jsonify({"ok": False, "message": str(e)}), 500


@app.route("/api/rebuild-deploy", methods=["POST"])
@require_role("admin")
def api_rebuild_deploy():
    """Full chain: queue a FRESH CI build off the branch, wait for it, create/find the resulting
    release, trigger the environment, and clear the approval gate.

    This exists because /api/redeploy-approve does not rebuild -- it re-triggers the release that
    already exists, which redeploys the SAME artifact. That is the right, fast action when a
    deployment failed for an infrastructure reason (agent lost, timeout), but it is useless when
    the build itself failed or when the branch has moved on: it just replays the identical broken
    artifact and fails the same way. This route is the answer for those cases.

    Runs in a background thread and returns immediately: a real CI build takes many minutes, far
    longer than any sane HTTP timeout.

    Progress is tracked IN PLACE on the row it was started from when the caller sends that row's
    runId -- the run file is rewritten rather than a second one created, so the table updates the
    existing row instead of growing a duplicate and pushing the original down. The superseded
    attempt is kept inside the same file under "attempts". Without a runId (or if that file has
    since been dismissed) it falls back to creating a new row, as before.
    """
    payload = request.get_json(force=True)
    pipeline_name = payload.get("pipeline")
    branch = (payload.get("branch") or "").strip()
    env_name = payload.get("env")
    run_id = (payload.get("runId") or "").strip()

    if not pipeline_name or not branch or not env_name:
        return jsonify({"ok": False, "message": "pipeline, branch and env are all required to rebuild"}), 400

    # Same hard safety gate as every other mutating route: a rebuild can only ever target the lower
    # environments, no matter what a caller sends.
    cfg = _resolve_pipeline(pipeline_name)
    if not cfg:
        return jsonify({"ok": False, "message": f"unknown pipeline '{pipeline_name}'"}), 400
    if not _env_allowed(cfg, env_name):
        return jsonify({"ok": False, "message": _env_not_allowed_message(env_name)}), 400
    problem = _prod_branch_problem(cfg, env_name, branch)
    if problem:
        return jsonify({"ok": False, "message": problem}), 400

    # Same path-safety check dismiss-deployment applies -- runId comes straight off a row and is
    # used to address a file.
    if run_id and any(c in run_id for c in ("/", "\\", "..")):
        return jsonify({"ok": False, "message": "invalid runId"}), 400
    reuse_path = RUNS_DIR / f"{run_id}.json" if run_id else None
    if reuse_path is not None and not reuse_path.is_file():
        # The row was dismissed between render and click. Rebuilding is still the right thing to
        # do, it just has nothing to update in place any more.
        reuse_path = None

    run = {
        "pipeline": pipeline_name,
        "branch": branch,
        "env": env_name,
        "requestedBy": (payload.get("name") or "").strip() or "-------",
    }

    if not _claim_run(run):
        return jsonify({
            "ok": False,
            "message": f"A rebuild of {pipeline_name} ({branch} -> {env_name}) is already running. "
                       f"Watch that row rather than starting a second build of the same thing.",
        }), 409

    try:
        run_path = _seed_run_file(run, reuse_path)
    except Exception as e:
        _release_run(run)
        return jsonify({"ok": False, "message": f"couldn't write the run file: {e}"}), 500

    threading.Thread(target=_new_deployment_worker, args=(run, cfg),
                     kwargs={"auto_approve": True, "run_path": run_path}, daemon=True).start()
    where = "this row" if reuse_path is not None else "a new row"
    return jsonify({
        "ok": True,
        "message": f"Rebuilding {pipeline_name} from {branch} for {env_name} -- new CI build queued. "
                   f"Tracking it on {where}; it will deploy and self-approve when the build finishes.",
    })


@app.route("/api/cancel-deployment", methods=["POST"])
@require_role("admin")
def api_cancel_deployment():
    """Cancel a not-yet-terminal release environment deployment -- same PATCH endpoint the trigger
    and redeploy-approve routes already use, just with status="canceled" instead of "inProgress".
    Same reasoning as those two: only ever acts on a specific releaseId+env the caller already
    knows about, never a bulk or by-pipeline cancel. DEV/SIT/UAT is now ENFORCED below rather than
    assumed from where the button appears -- the previous wording claimed the restriction held
    because the portal only ever hands this route its own lower-environment releases, which was a
    statement about the UI and not a check."""
    payload = request.get_json(force=True)
    release_id, env_name, pipeline_name = payload.get("releaseId"), payload.get("env"), payload.get("pipeline")
    if not release_id or not env_name:
        return jsonify({"ok": False, "message": "releaseId and env are required"}), 400

    # The portal never acts on production or beta, and that has to be CHECKED, not assumed. Until
    # now this route relied on the argument that its button only ever appears on rows the portal
    # itself created for lower environments -- true of the UI, enforced nowhere. releaseId, env and
    # pipeline all arrive from the request body, so an admin session could name a production release
    # directly. The production section puts real production release ids on screen, which turns that
    # argument into a live hole. Same guard as the trigger route.
    pipeline_cfg = _resolve_pipeline(pipeline_name or "")
    if not pipeline_cfg:
        return jsonify({"ok": False, "message": f"unknown pipeline '{pipeline_name}' -- can't tell which ADO project to use"}), 400
    if not _env_allowed(pipeline_cfg, env_name):
        return jsonify({"ok": False, "message": _env_not_allowed_message(env_name)}), 403
    rbase = release_base(pipeline_cfg["project"])

    try:
        detail = _get(f"{rbase}/release/releases/{release_id}?api-version={API_VERSION}")
        env = next((e for e in detail.get("environments", []) if e["name"] == env_name), None)
        if not env:
            return jsonify({"ok": False, "message": f"no {env_name} environment on release {release_id}"}), 404

        if env.get("status") in ("succeeded", "rejected", "canceled"):
            return jsonify({"ok": False, "message": f"{env_name} is already {env['status']} -- nothing to cancel"}), 409

        r = _patch(f"{rbase}/Release/releases/{release_id}/environments/{env['id']}?api-version={API_VERSION}",
                   {"status": "canceled", "comment": "Canceled via Magrabi Deployment Portal"})
        if r.status_code >= 400:
            return jsonify({"ok": False, "message": f"cancel failed: HTTP {r.status_code}: {r.text[:300]}"}), 502

        # Cancelling moves the row to a different terminal state, which the mtime-keyed cache
        # cannot see on its own (no run file changed).
        _invalidate_row_cache()

        check = _get(f"{rbase}/release/releases/{release_id}?api-version={API_VERSION}")
        check_env = next((e for e in check.get("environments", []) if e["id"] == env["id"]), None)
        if not check_env or check_env.get("status") != "canceled":
            return jsonify({
                "ok": False,
                "message": f"cancel sent, but read-back shows status: {check_env.get('status') if check_env else 'unknown'}",
            }), 502

        return jsonify({"ok": True, "message": f"{env_name} deployment canceled"})
    except Exception as e:
        return jsonify({"ok": False, "message": str(e)}), 500


def _find_failed_tasks(env_detail: dict):
    """Walk environments[].deploySteps[].releaseDeployPhases[].deploymentJobs[].tasks[] (confirmed
    live against a real failed release, 2026-08-06 -- releaseId 8307/environmentId 27117 on
    CD-Magrabi-Storefront) and return (deployPhaseId, taskId, taskName) for every failed task in
    the MOST RECENT deployment attempt only (deploySteps is append-only across retries; index -1 is
    the current/latest attempt, matching what the portal's own status column already reflects)."""
    deploy_steps = env_detail.get("deploySteps", [])
    if not deploy_steps:
        return []
    latest = deploy_steps[-1]
    failed = []
    for phase in latest.get("releaseDeployPhases", []):
        for job in phase.get("deploymentJobs", []):
            for task in job.get("tasks", []):
                if task.get("status") == "failed":
                    failed.append((phase["id"], task["id"], task.get("name") or f"task-{task['id']}"))
    return failed


def _resolve_release_project(release_id: int, pipeline_name: str):
    """The ADO project a release lives in, for callers that need only the project and not the
    release body. The pipeline hint alone is not enough: the feed deliberately carries release
    definitions that are outside the static registry, and for those DeploymentRow.pipeline is ADO's
    own definition name (e.g. "CD-DrM-Storefront"), which _resolve_pipeline() can never match.
    Falling back to the cached feed keeps the common case free of any ADO call, since every feed row
    already records its project; only a release that has aged out of the cached window reaches
    _fetch_release_detail(), which probes both projects. None means no project yielded it."""
    cfg = _resolve_pipeline(pipeline_name or "")
    if cfg:
        return cfg["project"]

    with _cache_lock:
        rows = list(_cache["deployments"])
    for row in rows:
        if row.get("releaseId") == release_id and row.get("project"):
            return row["project"]

    _detail, project = _fetch_release_detail(release_id, pipeline_name)
    return project


# Relaxed from admin-only to admin+viewer (MLC-2112/2113): the tickets exist precisely so
# developers can self-serve a failed deployment's logs instead of asking an admin. Reading a log
# is not a deployment-triggering action, so it belongs on the viewer side of the boundary.
@app.route("/api/deployment-logs/all")
@require_role("admin", "viewer")
def api_deployment_logs_all():
    """Full release log bundle -- same endpoint and same ZIP ADO's own "Download all logs" button
    uses (verified live 2026-08-06). Note this is scoped to the whole RELEASE (every environment
    on it), not just the one row it's downloaded from -- that's ADO's own behavior too, not a
    limitation introduced here."""
    release_id = request.args.get("releaseId", type=int)
    pipeline_name = request.args.get("pipeline", "")
    if not release_id:
        return jsonify({"ok": False, "message": "releaseId is required"}), 400
    # Not `_resolve_pipeline() or 400`: an unresolvable pipeline name is normal here, not an error.
    # The feed intentionally includes definitions outside the registry, and rejecting them left the
    # download button dead for every one of those rows even though the release is perfectly
    # fetchable once its project is known.
    project = _resolve_release_project(release_id, pipeline_name)
    if not project:
        return jsonify({"ok": False, "message": f"release {release_id} not found in any project"}), 404
    rbase = release_base(project)

    r = _SESSION.get(f"{rbase}/release/releases/{release_id}/logs",
                      headers=HEADERS, params={"api-version": API_VERSION}, timeout=60)
    if r.status_code >= 400:
        return jsonify({"ok": False, "message": f"HTTP {r.status_code} fetching logs"}), 502
    return Response(r.content, mimetype="application/zip", headers={
        "Content-Disposition": f'attachment; filename="release-{release_id}-all-logs.zip"',
    })


@app.route("/api/deployment-logs/failed-section")
@require_role("admin", "viewer")
def api_deployment_logs_failed_section():
    """Just the specific failed task's log (or logs, if more than one task failed in the same
    attempt), concatenated as plain text -- the "particular failed section" the download button
    offers as the lighter-weight alternative to the full-release zip."""
    release_id = request.args.get("releaseId", type=int)
    env_name = request.args.get("env", "")
    pipeline_name = request.args.get("pipeline", "")
    if not (release_id and env_name):
        return jsonify({"ok": False, "message": "releaseId and env are required"}), 400
    # Same reasoning as /deployment-logs/all above -- a pipeline outside the static registry is a
    # normal feed row, not a bad request. _fetch_release_detail() resolves the release and the
    # project it lives in together, and already tries both projects when the name doesn't resolve,
    # so this route needs no separate detail fetch of its own.
    detail, project = _fetch_release_detail(release_id, pipeline_name)
    if not detail or not project:
        return jsonify({"ok": False, "message": f"release {release_id} not found"}), 404
    rbase = release_base(project)

    # Matched through the shared helper rather than on exact name: callers reach this route with
    # either the row's rawEnv or its normalized bucket, and an exact-only match silently 404s the
    # download for every pipeline whose production environment is named something like "PROD_TAG".
    env = _find_release_environment(detail, env_name)
    if not env or not env.get("id"):
        return jsonify({"ok": False, "message": f"no {env_name} environment on release {release_id}"}), 404

    failed_tasks = _find_failed_tasks(env)
    if not failed_tasks:
        return jsonify({"ok": False, "message": "No failed task found on this environment's latest deployment attempt."}), 404

    parts = []
    for phase_id, task_id, task_name in failed_tasks:
        log_url = f"{rbase}/release/releases/{release_id}/environments/{env['id']}/deployPhases/{phase_id}/tasks/{task_id}/logs"
        r = _SESSION.get(log_url, headers=HEADERS, params={"api-version": API_VERSION}, timeout=30)
        body = r.text if r.status_code < 400 else f"(failed to fetch this task's log: HTTP {r.status_code})"
        parts.append(f"===== {task_name} (task {task_id}) =====\n{body}")

    content = "\n\n".join(parts)
    safe_env = re.sub(r"[^a-zA-Z0-9]+", "-", env_name.lower())
    return Response(content, mimetype="text/plain", headers={
        "Content-Disposition": f'attachment; filename="release-{release_id}-{safe_env}-failed-section.log"',
    })


@app.route("/api/deployment-name", methods=["POST"])
@require_role("admin")
def api_deployment_name():
    """Sets (or clears) a run's Name after it has already started.

    The name was previously capture-once, at submission. In practice nobody knows to fill it in
    until later -- a row becomes worth attributing when someone asks about it, which is always
    after the fact -- so every row read "-------" forever. This is portal bookkeeping only: it
    rewrites the run's own audit file and touches nothing in Azure DevOps.

    Allowed on any run, finished or not, for the same reason: the attribution question usually
    arrives once the deployment is long done.
    """
    payload = request.get_json(force=True) or {}
    run_id = payload.get("runId", "")
    # Same guard as dismiss: run_id names a file, so it must not be able to escape RUNS_DIR.
    if not run_id or any(c in run_id for c in ("/", "\\", "..")):
        return jsonify({"ok": False, "message": "invalid runId"}), 400

    name = (payload.get("name") or "").strip()
    if len(name) > 60:
        return jsonify({"ok": False, "message": "name is too long (60 characters max)"}), 400

    path = RUNS_DIR / f"{run_id}.json"
    if not path.is_file():
        return jsonify({"ok": False, "message": "run not found"}), 404
    try:
        audit = json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        return jsonify({"ok": False, "message": f"couldn't read run file: {e}"}), 500

    audit.setdefault("request", {})
    # Blank clears it back to the placeholder the rest of the UI already renders.
    audit["request"]["requestedBy"] = name or "-------"
    try:
        path.write_text(json.dumps(audit, indent=2, default=str), encoding="utf-8")
    except Exception as e:
        return jsonify({"ok": False, "message": f"couldn't save: {e}"}), 500

    # Rewriting the file changes its mtime, which busts this row's cache entry on its own -- but
    # Patch the PUBLISHED list synchronously as well as waking the refresher.
    #
    # Waking it alone was not enough and produced the "name disappears then comes back" flicker:
    # the browser optimistically shows the new name, invalidates, and refetches within
    # milliseconds -- faster than the refresher can rebuild and republish -- so the refetch served
    # the OLD cached row and the cell snapped back until the next 2s tick. Writing it here means
    # the very next GET already has it.
    with _cache_lock:
        for row in _cache.get("my_deployments") or []:
            if row.get("runId") == run_id:
                row["requestedBy"] = audit["request"]["requestedBy"]
                break
    _my_deployments_wake.set()
    return jsonify({"ok": True, "message": "saved", "requestedBy": audit["request"]["requestedBy"]})


@app.route("/api/dismiss-deployments", methods=["POST"])
@require_role("admin")
def api_dismiss_deployments():
    """Bulk version of dismiss, for the Backup failed tab's Flush button.

    Each run is re-checked independently and on its own terms -- a row that has quietly stopped
    being dead (someone redeployed it) is skipped and reported, not deleted along with the rest.
    Partial success is the normal outcome and is reported as such rather than as a failure.
    """
    payload = request.get_json(force=True) or {}
    run_ids = payload.get("runIds") or []
    if not isinstance(run_ids, list) or not run_ids:
        return jsonify({"ok": False, "message": "runIds is required"}), 400

    removed, skipped = [], []
    for run_id in run_ids[:500]:
        if not run_id or any(c in str(run_id) for c in ("/", "\\", "..")):
            skipped.append({"runId": run_id, "reason": "invalid runId"})
            continue
        path = RUNS_DIR / f"{run_id}.json"
        if not path.is_file():
            # Already gone is the desired end state, so count it as done rather than an error.
            removed.append(run_id)
            continue
        try:
            audit = json.loads(path.read_text(encoding="utf-8"))
            current = _resolve_deployment_row(str(path), audit)
        except Exception as e:
            skipped.append({"runId": run_id, "reason": f"unreadable: {e}"})
            continue
        if current["status"] not in DISMISSABLE_STATUSES:
            skipped.append({"runId": run_id, "reason": f"now '{current['status']}'"})
            continue
        try:
            path.unlink()
            removed.append(run_id)
        except Exception as e:
            skipped.append({"runId": run_id, "reason": str(e)})

    _my_deployments_wake.set()
    msg = f"removed {len(removed)}"
    if skipped:
        msg += f", kept {len(skipped)} that are no longer dead"
    return jsonify({"ok": True, "message": msg, "removed": len(removed), "skipped": skipped})


@app.route("/api/dismiss-deployment", methods=["POST"])
@require_role("admin")
def api_dismiss_deployment():
    """Removes a run's local audit file, taking it off My Deployments -- ONLY affects this
    portal's own bookkeeping (a JSON file in deploy_runs/); never touches Azure DevOps or any
    real deployment/environment/build state. Scoped by the frontend to dead rows only, but
    re-checked here too rather than trusted blindly: re-resolves the row's CURRENT status the
    same way the live list does before deleting, in case it stopped being dead in the few
    seconds between the last poll and the click (e.g. someone else just redeployed it)."""
    payload = request.get_json(force=True)
    run_id = payload.get("runId", "")
    if not run_id or any(c in run_id for c in ("/", "\\", "..")):
        return jsonify({"ok": False, "message": "invalid runId"}), 400

    path = RUNS_DIR / f"{run_id}.json"
    if not path.is_file():
        return jsonify({"ok": False, "message": "run not found"}), 404

    try:
        audit = json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        return jsonify({"ok": False, "message": f"couldn't read run file: {e}"}), 500

    # Canceled counts as removable alongside failed: both are terminal states the user chose to
    # walk away from, and a canceled run is exactly the kind of noise worth clearing. Still refuses
    # anything live or successful, so a running or completed deployment can never be dismissed.
    current = _resolve_deployment_row(str(path), audit)
    if current["status"] not in DISMISSABLE_STATUSES:
        return jsonify({
            "ok": False,
            "message": f"this run is now '{current['status']}' -- only "
                       f"{' or '.join(sorted(DISMISSABLE_STATUSES))} runs can be removed",
        }), 409

    path.unlink()
    # Republish without the row now, rather than leaving it on screen for another poll interval.
    _my_deployments_wake.set()
    return jsonify({"ok": True, "message": "removed"})


# ---------------------------------------------------------------------------------------------
# Deployment monitoring (MLC-2112). Every route below is a READ and is therefore admin+viewer --
# the deployment-TRIGGERING routes above stay admin-only. Nothing here can mutate ADO state.
# ---------------------------------------------------------------------------------------------
def _parse_filter_date(value, end_of_day: bool = False):
    """Parses a `from`/`to` filter value. A bare ISO date means the whole day, so `to=2026-08-10`
    has to include everything up to 23:59:59 on the 10th -- comparing against midnight would
    silently drop that day's deployments, which reads as data loss rather than a filter."""
    if not value or not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if end_of_day and "T" not in text and len(text) == 10:
        text = f"{text}T23:59:59"
    return _parse_ado_dt(text)


def _cached_deployment_for(release_id: int, raw_env: str):
    """The feed row for one release+environment, if it's still inside the cached window. Rows are
    stored newest-first, so the first match is the latest attempt."""
    with _cache_lock:
        rows = list(_cache["deployments"])
    wanted = (raw_env or "").strip().casefold()
    for row in rows:
        if row.get("releaseId") != release_id:
            continue
        if not wanted or (row.get("rawEnv") or "").strip().casefold() == wanted:
            return row
    return None


def _fetch_release_detail(release_id: int, pipeline_name: str):
    """Resolves a release id to (detail, project). Release ids are scoped per ADO project, so
    without a usable pipeline hint both projects have to be tried -- and a bare id can legitimately
    exist in BOTH, in which case the first hit wins and may be the wrong release. That ambiguity is
    why every caller in the frontend is expected to pass `pipeline`."""
    cfg = _resolve_pipeline(pipeline_name or "")
    projects = [cfg["project"]] if cfg else list(DEPLOYMENT_PROJECTS)
    for project in projects:
        try:
            detail = _get(f"{release_base(project)}/release/releases/{release_id}?api-version={API_VERSION}")
        except Exception:
            continue
        if isinstance(detail, dict) and detail.get("id"):
            return detail, project
    return None, None


def _find_release_environment(detail: dict, env_name: str):
    """Matches the caller's environment name against the release's own environments. Falls back to
    bucket matching so a caller that only has the normalized "PROD" still resolves a pipeline whose
    real environment is named "PROD_TAG"."""
    environments = [e for e in (detail.get("environments") or []) if isinstance(e, dict)]
    if not environments:
        return None
    wanted = (env_name or "").strip()
    if wanted:
        exact = next((e for e in environments
                      if (e.get("name") or "").strip().casefold() == wanted.casefold()), None)
        if exact:
            return exact
        bucket = _env_bucket(wanted)
        if bucket != "OTHER":
            return next((e for e in environments if _env_bucket(e.get("name")) == bucket), None)
        return None
    # No environment specified -- the most recent one that actually ran is the only sensible guess.
    ran = [e for e in environments if e.get("deploySteps")]
    return ran[-1] if ran else environments[-1]


def _ado_time_param(value: datetime) -> str:
    """A filter bound in the shape ADO's minStartedTime/maxStartedTime expect. They are compared
    server-side in UTC, so the value is converted rather than sent with whatever offset the caller
    happened to type -- a +04:00 bound sent verbatim would silently shift the window by 4 hours."""
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _cached_feed_covers(rows: list, date_from) -> bool:
    """Whether the cached feed already reaches back far enough to answer a range starting at
    date_from. The cache is the most recent DEPLOYMENT_FEED_TOP rows PER PROJECT and the two
    projects deploy at very different rates -- Macula's 200 rows can span months while ECom's span
    days -- so this is only true when EVERY project's oldest cached row predates the bound. Judging
    by the oldest row overall would claim coverage the busier project doesn't actually have."""
    if date_from is None:
        # An open lower bound means "everything up to date_to", which a fixed most-recent window
        # can never be known to cover.
        return False
    # Single pass -- the cache is ~400 rows and this runs per dated request, so it is not walked
    # once per project.
    oldest = {}
    for row in rows:
        project = row.get("project")
        if project not in DEPLOYMENT_PROJECTS:
            continue
        when = _parse_ado_dt(row.get("startedOn")) or _parse_ado_dt(row.get("queuedOn"))
        if when and (project not in oldest or when < oldest[project]):
            oldest[project] = when
    return all(project in oldest and oldest[project] <= date_from
               for project in DEPLOYMENT_PROJECTS)


def _fetch_deployments_range(date_from, date_to) -> list:
    """One live /release/deployments read per project with the date range pushed down into ADO's
    own minStartedTime/maxStartedTime, normalized through the same _deployment_row() the cached
    feed uses so both halves of the answer are identical in shape. Memoized for
    DEPLOYMENT_RANGE_TTL_SECONDS so a polling page doesn't re-issue it every few seconds.

    Worth knowing: ADO bounds these parameters on startedOn, so deployments that never started --
    the auto-rejected pre-deploy approvals, which are a large share of the feed -- are absent from
    the live half. Inside the cached window they still come from the cache, which filters on
    queuedOn as a fallback."""
    key = (date_from.isoformat() if date_from else "", date_to.isoformat() if date_to else "")
    now = time.time()
    with _range_lock:
        hit = _range_cache.get(key)
        if hit and now - hit[0] < DEPLOYMENT_RANGE_TTL_SECONDS:
            return list(hit[1])

    rows = []
    for project in DEPLOYMENT_PROJECTS:
        params = {"api-version": API_VERSION, "$top": DEPLOYMENT_RANGE_TOP,
                  "queryOrder": "descending"}
        if date_from:
            params["minStartedTime"] = _ado_time_param(date_from)
        if date_to:
            params["maxStartedTime"] = _ado_time_param(date_to)
        payload = _get(f"{release_base(project)}/release/deployments", params=params)
        for item in payload.get("value", []) if isinstance(payload, dict) else []:
            try:
                row = _deployment_row(item, project)
            except Exception as e:
                print("deployments range row error:", project, e)
                continue
            if row:
                rows.append(row)

    with _range_lock:
        # Bounded because the key is user-supplied -- every from/to combination the UI sends would
        # otherwise add an entry that never expires. Only a handful of ranges is ever live at once.
        if len(_range_cache) > 16:
            _range_cache.clear()
        _range_cache[key] = (now, list(rows))
    return rows


# Hidden-tile bookkeeping. Cached in memory because api_deployments consults it on every poll (every
# few seconds, per open tab) and the file changes about never; the mtime check keeps a second replica
# honest without re-reading the volume each time.
_hidden_lock = threading.Lock()
_hidden_cache = {"mtime": None, "keys": {}}


def _hidden_key(project, deployment_id) -> str:
    """Board rows are deduplicated on (project, id) because ADO deployment ids are only unique
    WITHIN a project -- the same reason _CD_DEFINITION_INDEX is keyed that way. Hiding on the bare id
    would hide a Macula tile whenever ECom happened to have a deployment with the same number."""
    return f"{(project or '').strip()}:{deployment_id}"


def _load_hidden() -> dict:
    """{key: {hiddenBy, hiddenAt, label}}. Never raises: a missing or corrupt file means nothing is
    hidden, which fails toward showing the board rather than blanking it."""
    try:
        stat = HIDDEN_DEPLOYMENTS_FILE.stat()
    except OSError:
        with _hidden_lock:
            _hidden_cache.update({"mtime": None, "keys": {}})
        return {}
    with _hidden_lock:
        if _hidden_cache["mtime"] == stat.st_mtime:
            return dict(_hidden_cache["keys"])
    try:
        data = json.loads(HIDDEN_DEPLOYMENTS_FILE.read_text(encoding="utf-8"))
        keys = data.get("hidden") if isinstance(data, dict) else None
        keys = keys if isinstance(keys, dict) else {}
    except Exception as e:
        print("hidden deployments read error:", e)
        keys = {}
    with _hidden_lock:
        _hidden_cache.update({"mtime": stat.st_mtime, "keys": keys})
    return dict(keys)


def _save_hidden(keys: dict) -> None:
    HIDDEN_DEPLOYMENTS_FILE.parent.mkdir(parents=True, exist_ok=True)
    # Write-then-replace: a torn write here would blank the board's hide list for every user, and
    # os.replace is atomic on the same filesystem.
    tmp = HIDDEN_DEPLOYMENTS_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps({"hidden": keys}, indent=2), encoding="utf-8")
    os.replace(tmp, HIDDEN_DEPLOYMENTS_FILE)
    with _hidden_lock:
        try:
            _hidden_cache.update({"mtime": HIDDEN_DEPLOYMENTS_FILE.stat().st_mtime, "keys": keys})
        except OSError:
            _hidden_cache.update({"mtime": None, "keys": keys})


def _hide_payload():
    """Shared request parsing for hide/unhide. Returns (key, label, error_response)."""
    payload = request.get_json(force=True) or {}
    deployment_id = payload.get("id")
    project = payload.get("project") or ""
    if deployment_id is None or str(deployment_id).strip() == "":
        return None, None, (jsonify({"ok": False, "message": "id is required"}), 400)
    try:
        deployment_id = int(deployment_id)
    except (TypeError, ValueError):
        return None, None, (jsonify({"ok": False, "message": "id must be a number"}), 400)
    # Purely for the admin's own "what did I hide" list -- never used to match a row.
    label = str(payload.get("label") or "").strip()[:200]
    return _hidden_key(project, deployment_id), label, None


@app.route("/api/deployments/hide", methods=["POST"])
@require_role("admin")
def api_hide_deployment():
    """Hides one board tile for EVERYONE, permanently, until an admin unhides it.

    This only affects what the portal draws. It does not touch Azure DevOps, and the deployment it
    describes still happened -- so hiding a real PROD release makes the board a less complete record
    of production than it was. That is the caller's call to make; it is recorded with who did it.
    """
    key, label, error = _hide_payload()
    if error:
        return error
    hidden = _load_hidden()
    hidden[key] = {
        "hiddenBy": get_username(),
        "hiddenAt": datetime.now(timezone.utc).isoformat(),
        "label": label,
    }
    _save_hidden(hidden)
    return jsonify({"ok": True, "message": "Hidden for everyone.", "hiddenCount": len(hidden)})


@app.route("/api/deployments/unhide", methods=["POST"])
@require_role("admin")
def api_unhide_deployment():
    key, _label, error = _hide_payload()
    if error:
        return error
    hidden = _load_hidden()
    if hidden.pop(key, None) is None:
        return jsonify({"ok": True, "message": "That tile was not hidden.",
                        "hiddenCount": len(hidden)})
    _save_hidden(hidden)
    return jsonify({"ok": True, "message": "Visible again.", "hiddenCount": len(hidden)})


@app.route("/api/deployments")
@require_role("admin", "viewer")
def api_deployments():
    """Serves the cached feed, filtered in Python. With no date filter this route never calls ADO:
    the page polls on a short interval and per-request bulk calls would multiply straight into ADO
    rate limits while making every filter change feel like a page load. A date range is the one
    question the cache genuinely cannot answer -- it holds only the most recent rows per project, so
    anything older than that window came back empty and the UI told the user to widen a range that
    was already correct. Only that case reaches out to ADO, with the range pushed down into the
    API and the result briefly memoized."""
    with _cache_lock:
        rows = list(_cache["deployments"])
        updated = _cache["deployments_updated"]

    env = (request.args.get("env") or "").strip().upper()
    pipeline = (request.args.get("pipeline") or "").strip().casefold()
    status = (request.args.get("status") or "").strip().casefold()
    application = (request.args.get("application") or "").strip().casefold()
    search = (request.args.get("search") or "").strip().casefold()
    date_from = _parse_filter_date(request.args.get("from"))
    date_to = _parse_filter_date(request.args.get("to"), end_of_day=True)

    top = request.args.get("top", type=int)
    if not top or top <= 0:
        top = DEPLOYMENT_FEED_TOP

    if (date_from or date_to) and not _cached_feed_covers(rows, date_from):
        try:
            live = _fetch_deployments_range(date_from, date_to)
        except Exception as e:
            # An ADO failure degrades to whatever the cache can answer. A partial list plus the
            # "updated" timestamp is a far better outcome here than a 500 on the whole page.
            print("deployments range fetch error:", e)
            live = []
        if live:
            # Keyed on (project, id), not the bare deployment id: ADO ids are only unique WITHIN a
            # project -- the same reason _CD_DEFINITION_INDEX is keyed that way -- so deduplicating
            # on the id alone would silently drop a Macula row whenever ECom happened to have a
            # deployment with the same number.
            def dedupe_key(row):
                return (row.get("project"), row["id"])

            merged = {dedupe_key(row): row for row in live}
            # Cached rows win a collision: same normalization from the same API, but it is the copy
            # the rest of the UI already agrees with (the detail drawer resolves its timestamps
            # through _cached_deployment_for), so preferring it keeps the two views consistent.
            merged.update({dedupe_key(row): row for row in rows})
            rows = sorted(merged.values(), key=_deployment_sort_key, reverse=True)

    search_fields = ("pipeline", "application", "branch", "releaseName", "buildNumber",
                     "triggeredBy", "commitId")

    def keep(row) -> bool:
        if env and row.get("env") != env:
            return False
        if pipeline and (row.get("pipeline") or "").casefold() != pipeline:
            return False
        if status and (row.get("status") or "").casefold() != status:
            return False
        if application and (row.get("application") or "").casefold() != application:
            return False
        if date_from or date_to:
            # startedOn is null for anything that never left the queue, so the date filter falls
            # back to queuedOn -- otherwise every waiting/queued row would vanish from a date range
            # that plainly contains it.
            when = _parse_ado_dt(row.get("startedOn")) or _parse_ado_dt(row.get("queuedOn"))
            if not when:
                return False
            if date_from and when < date_from:
                return False
            if date_to and when > date_to:
                return False
        if search and not any(search in str(row.get(field) or "").casefold() for field in search_fields):
            return False
        return True

    # Hiding is applied last, on top of every other filter, so "N hidden" always counts rows the
    # reader would otherwise be looking at right now rather than the whole store.
    hidden = _load_hidden()
    reveal = ((request.args.get("showHidden") or "").strip().lower() in ("1", "true", "yes")
              and get_identity() == "admin")

    matched = [row for row in rows if keep(row)]
    hidden_matched = sum(1 for row in matched
                         if _hidden_key(row.get("project"), row.get("id")) in hidden)

    if reveal:
        # Admins reviewing what has been hidden need the rows themselves, flagged, so each one can
        # carry an Unhide button. Everyone else never sees them at all.
        visible = [dict(row, hidden=_hidden_key(row.get("project"), row.get("id")) in hidden)
                   for row in matched]
    else:
        visible = [row for row in matched
                   if _hidden_key(row.get("project"), row.get("id")) not in hidden]

    with _cache_lock:
        reachable = _cache.get("ado_reachable", True)
        ado_error = _cache.get("ado_error")
        failed_since = _cache.get("ado_failed_since")
    return jsonify({
        "rows": visible[:top],
        "updated": updated,
        # Of the rows matching the current filters. hiddenTotal is the whole store, which is what an
        # admin needs to know a hide exists at all when the current filters exclude it.
        "hiddenCount": hidden_matched,
        "hiddenTotal": len(hidden),
        # An empty board means "nothing is deploying" ONLY if the portal could actually look.
        "adoReachable": reachable, "adoError": ado_error, "adoFailedSince": failed_since,
    })


@app.route("/api/builds/<int:build_id>/timeline")
@require_role("admin", "viewer")
def api_build_timeline(build_id: int):
    """A CI build's stages, jobs and tasks, in the SAME shape as the deployment timeline.

    Matching the contract deliberately: the drawer then renders a build with the identical live
    step view it already uses for a deployment, rather than a second bespoke component. Before
    this, a run that was still building had nothing to show but a "please wait" placeholder, even
    though ADO knows exactly which step is executing.

    Read-only.
    """
    project = (request.args.get("project") or "").strip()
    if project not in DEPLOYMENT_PROJECTS:
        cfg = _resolve_pipeline(request.args.get("pipeline") or "")
        project = cfg["project"] if cfg else DEPLOYMENT_PROJECTS[0]

    try:
        build = _get(f"{build_base(project)}/build/builds/{build_id}?api-version={API_VERSION}")
        data = _get(f"{build_base(project)}/build/builds/{build_id}/timeline"
                    f"?api-version={API_VERSION}")
    except Exception as e:
        return jsonify({"ok": False, "message": f"could not read build {build_id}: {e}"}), 502

    records = data.get("records") or []
    by_id = {r.get("id"): r for r in records}

    def duration(rec):
        return _duration_seconds(_clean_ado_date(rec.get("startTime")),
                                 _clean_ado_date(rec.get("finishTime")),
                                 running=(rec.get("state") or "").lower() == "inprogress")

    # ADO nests Stage -> Phase -> Job -> Task. The drawer wants two levels, so tasks are grouped
    # under whichever STAGE they ultimately belong to -- walking parents rather than assuming depth,
    # because not every pipeline defines explicit stages.
    def stage_of(rec):
        seen = set()
        cur = rec
        while cur is not None and cur.get("id") not in seen:
            seen.add(cur.get("id"))
            if cur.get("type") == "Stage":
                return cur
            cur = by_id.get(cur.get("parentId"))
        return None

    phases = {}
    for rec in records:
        if rec.get("type") != "Task":
            continue
        stage = stage_of(rec)
        # A pipeline with no stage records still has jobs; fall back to the job so the tasks are
        # grouped under something meaningful rather than all landing in one bucket.
        if stage is None:
            parent = by_id.get(rec.get("parentId"))
            stage = parent if parent else {"id": 0, "name": "Build", "order": 0}
        key = stage.get("id") or 0
        phase = phases.setdefault(key, {
            "id": abs(hash(str(key))) % 1_000_000,
            # ADO calls an implicit single phase "__default" -- never show that to a person.
            "name": (stage.get("name") or "Build") if not str(stage.get("name") or "").startswith("__") else "Build",
            "rank": stage.get("order") or 0,
            "status": (stage.get("result") or stage.get("state") or "").lower(),
            "startedOn": _clean_ado_date(stage.get("startTime")),
            "tasks": [],
        })
        phase["tasks"].append({
            "id": abs(hash(str(rec.get("id")))) % 1_000_000,
            "name": rec.get("name") or "",
            # ADO reports a running task as result=null/state=inProgress; report what it is doing.
            "status": (rec.get("result") or rec.get("state") or "").lower(),
            "startTime": _clean_ado_date(rec.get("startTime")),
            "finishTime": _clean_ado_date(rec.get("finishTime")),
            "durationSeconds": duration(rec),
            "agentName": (rec.get("workerName") or None),
            "issues": [{"type": i.get("type"), "message": i.get("message")}
                       for i in (rec.get("issues") or [])],
            # Build task logs are not served through this portal, so never offer a dead link.
            "hasLog": False,
            "phaseId": phase["id"],
        })

    ordered = sorted(phases.values(), key=lambda p: (p["rank"], p["name"]))
    for phase in ordered:
        phase["tasks"].sort(key=lambda t: (t["startTime"] or "", t["name"]))

    return jsonify({
        "ok": True,
        "releaseId": 0,
        "releaseName": f"Build {build.get('buildNumber') or build_id}",
        "env": (build.get("sourceBranch") or "").replace("refs/heads/", ""),
        "status": (build.get("result") or build.get("status") or "").lower(),
        "startedOn": _clean_ado_date(build.get("startTime")),
        "completedOn": _clean_ado_date(build.get("finishTime")),
        "durationSeconds": _duration_seconds(
            _clean_ado_date(build.get("startTime")), _clean_ado_date(build.get("finishTime")),
            running=build.get("status") != "completed"),
        "triggeredBy": (build.get("requestedFor") or {}).get("displayName") or "",
        "attempt": 1,
        "phases": ordered,
        "approvals": [],
    })


@app.route("/api/deployments/<int:release_id>/timeline")
@require_role("admin", "viewer")
def api_deployment_timeline(release_id):
    """Live ADO read, deliberately NOT cached or background-refreshed: this is opened one release
    at a time on demand, and the whole point is watching a running deployment progress -- a stale
    phase/task tree would be worse than the ~1.5s wait."""
    detail, _project = _fetch_release_detail(release_id, request.args.get("pipeline", ""))
    if not detail:
        return jsonify({"ok": False, "message": f"release {release_id} not found"}), 404

    env_param = request.args.get("env", "")
    environment = _find_release_environment(detail, env_param)
    if not environment:
        return jsonify({
            "ok": False,
            "message": f"no environment matching '{env_param}' on release {release_id}",
        }), 404

    steps = [s for s in (environment.get("deploySteps") or []) if isinstance(s, dict)]
    # deploySteps is append-only across retries; index -1 is the current attempt, the same
    # convention _find_failed_tasks() and _resolve_deployment_row() already use. Consequence worth
    # knowing: this route is addressed by releaseId+env, with no attempt or deployment id, so
    # opening an OLDER attempt's feed row shows the latest attempt's tree. Confirmed live on
    # release 8395/SIT, whose attempt 1 auto-rejected on an approval timeout and whose attempt 2
    # succeeded -- a "rejected" row there opens a "succeeded" timeline. That is the environment's
    # true current state, but it can only be made attempt-accurate by adding an attempt/deployment
    # id to this route's contract.
    latest = steps[-1] if steps else {}
    status = _normalize_deployment_status(
        latest.get("status") or environment.get("status") or "",
        latest.get("operationStatus") or "",
    )

    phases = []
    for phase in sorted([p for p in (latest.get("releaseDeployPhases") or []) if isinstance(p, dict)],
                        key=lambda p: p.get("rank") or 0):
        phase_id = phase.get("id")
        tasks = []
        for job in phase.get("deploymentJobs") or []:
            if not isinstance(job, dict):
                continue
            for task in job.get("tasks") or []:
                if not isinstance(task, dict) or not task.get("id"):
                    continue
                start = _clean_ado_date(task.get("startTime"))
                finish = _clean_ado_date(task.get("finishTime"))
                tasks.append({
                    "id": task.get("id"),
                    "name": task.get("name") or "",
                    "status": task.get("status") or "",
                    "startTime": start,
                    "finishTime": finish,
                    "durationSeconds": _duration_seconds(
                        start, finish, running=task.get("status") == "inProgress"),
                    # The agent is recorded on the task, but ADO leaves it off skipped/pending
                    # tasks -- the parent job still knows which agent the whole job landed on.
                    "agentName": task.get("agentName") or job.get("agentName") or None,
                    "issues": [
                        {"type": issue.get("issueType") or issue.get("type") or "",
                         "message": issue.get("message") or ""}
                        for issue in (task.get("issues") or []) if isinstance(issue, dict)
                    ],
                    # Only true when there is a real log to fetch -- a pending or skipped task has
                    # no logUrl, and offering a "view log" affordance that 404s is worse than none.
                    "hasLog": bool(task.get("logUrl")),
                    "phaseId": phase_id,
                })
        phases.append({
            "id": phase_id,
            "name": phase.get("name") or "",
            "rank": phase.get("rank") or 0,
            "status": phase.get("status") or "",
            "startedOn": _clean_ado_date(phase.get("startedOn")),
            "tasks": tasks,
        })

    approvals = []
    for kind, key in (("preDeploy", "preDeployApprovals"), ("postDeploy", "postDeployApprovals")):
        for approval in environment.get(key) or []:
            if not isinstance(approval, dict):
                continue
            actor = approval.get("approvedBy") or approval.get("approver") or {}
            approvals.append({
                "id": approval.get("id"),
                "status": approval.get("status") or "",
                "approver": (actor.get("displayName") if isinstance(actor, dict) else None) or None,
                "comments": approval.get("comments") or None,
                "type": approval.get("approvalType") or kind,
            })

    # The deployments API is the authority on these timestamps, and it's the same clock the list
    # view renders -- so when this release is still inside the cached window the detail panel
    # cannot disagree with the row that opened it. Older releases fall out of that window, and
    # only then are the times reconstructed from the phases/tasks themselves.
    cached = _cached_deployment_for(release_id, environment.get("name") or "") or {}
    started_on = cached.get("startedOn") or _earliest(
        [t["startTime"] for p in phases for t in p["tasks"] if t["startTime"]]
        + [p["startedOn"] for p in phases if p["startedOn"]]
    )
    completed_on = cached.get("completedOn")
    if not completed_on and status not in _RUNNING_STATUSES:
        completed_on = _latest([t["finishTime"] for p in phases for t in p["tasks"] if t["finishTime"]])

    try:
        attempt = int(latest.get("attempt") or cached.get("attempt") or 0)
    except (TypeError, ValueError):
        attempt = 0

    requested_for = latest.get("requestedFor") if isinstance(latest.get("requestedFor"), dict) else {}
    requested_by = latest.get("requestedBy") if isinstance(latest.get("requestedBy"), dict) else {}

    return jsonify({
        "ok": True,
        "releaseId": release_id,
        "releaseName": detail.get("name") or "",
        "env": environment.get("name") or "",
        "status": status,
        "startedOn": started_on,
        "completedOn": completed_on,
        "durationSeconds": _duration_seconds(started_on, completed_on,
                                             running=status in _RUNNING_STATUSES),
        "triggeredBy": (requested_for.get("displayName") or requested_by.get("displayName")
                        or cached.get("triggeredBy") or ""),
        "attempt": attempt,
        "phases": phases,
        "approvals": approvals,
    })


@app.route("/api/deployments/<int:release_id>/task-log")
@require_role("admin", "viewer")
def api_deployment_task_log(release_id):
    """One task's log as plain text for in-app viewing -- the read-only counterpart to the
    failed-section download. Errors are returned as text/plain too, so the log viewer can render
    the failure in place instead of having to branch on content type."""
    def fail(message: str, code: int):
        return Response(message, mimetype="text/plain; charset=utf-8", status=code)

    # request.args.get(type=int) yields None for anything non-numeric, which is exactly the
    # validation needed here -- these two values are interpolated straight into an ADO URL path.
    phase_id = request.args.get("phaseId", type=int)
    task_id = request.args.get("taskId", type=int)
    if phase_id is None or task_id is None:
        return fail("phaseId and taskId are required and must be integers", 400)

    detail, project = _fetch_release_detail(release_id, request.args.get("pipeline", ""))
    if not detail:
        return fail(f"release {release_id} not found", 404)

    env_param = request.args.get("env", "")
    environment = _find_release_environment(detail, env_param)
    if not environment or not environment.get("id"):
        return fail(f"no environment matching '{env_param}' on release {release_id}", 404)

    log_url = (f"{release_base(project)}/release/releases/{release_id}/environments"
               f"/{environment['id']}/deployPhases/{phase_id}/tasks/{task_id}/logs")
    try:
        r = _SESSION.get(log_url, headers=HEADERS, params={"api-version": API_VERSION}, timeout=30)
    except (requests.ConnectionError, requests.Timeout) as e:
        return fail(f"could not reach Azure DevOps: {e}", 502)
    if r.status_code >= 400:
        return fail(f"HTTP {r.status_code} fetching this task's log", 502)
    # ADO answers 200 with a completely empty body for a task id that doesn't exist on this phase
    # (confirmed live 2026-08-10 against release 8395 with a made-up task id) rather than 404ing.
    # Passing that through would render as a blank log pane with no explanation, which reads as a
    # broken viewer -- say what actually happened instead.
    if not r.text.strip():
        return fail(f"no log content for task {task_id} on phase {phase_id} -- the task may not "
                    f"have run, or its log is no longer retained", 404)
    return Response(r.text, mimetype="text/plain; charset=utf-8")


@app.route("/api/meta")
@require_role("admin", "viewer")
def api_meta():
    """Filter dropdown vocabulary. Pipelines and environments start from the static registry so
    the dropdowns are fully populated the moment the page loads, even on a cold feed cache, then
    get topped up with anything the live feed found outside the registry."""
    with _cache_lock:
        rows = list(_cache["deployments"])

    pipelines = set(PIPELINES.keys())
    applications = set()
    environments = set(STATUS_ENVIRONMENTS)
    for row in rows:
        if row.get("pipeline"):
            pipelines.add(row["pipeline"])
        if row.get("application"):
            applications.add(row["application"])
        if row.get("env"):
            environments.add(row["env"])

    # DEV/SIT/UAT/PROD in deployment order rather than alphabetical, with OTHER last -- an
    # alphabetized environment list reads as arbitrary to anyone who thinks in promotion order.
    env_order = STATUS_ENVIRONMENTS + ["OTHER"]
    return jsonify({
        "pipelines": sorted(pipelines),
        "applications": sorted(applications),
        "environments": [e for e in env_order if e in environments],
        "statuses": list(NORMALIZED_STATUSES),
        # Default scope for the variables screen -- see WORKING_SET_PIPELINES.
        "workingSet": list(WORKING_SET_PIPELINES),
        # Every pipeline the registry can actually RESOLVE, for the variables screen's picker.
        # `pipelines` above is derived from ADO deployment rows, so it carries raw definition names
        # (e.g. "CD-Magrabi-Storefront-Preview") that _resolve_pipeline has never heard of -- picking
        # one answered "unknown pipeline" and the screen could not recover. Offering only these
        # makes that failure unreachable rather than merely unlikely.
        "variablePipelines": sorted(PIPELINES.keys()),
        # Pipelines whose variables every role may read in full on every environment -- see
        # _OPEN_VARIABLES_DEFINITIONS. The frontend uses the aliases to decide which environments to
        # offer a viewer; the endpoint enforces the same rule regardless.
        "variablesOpenPipelines": _open_variables_pipeline_keys(),
        "variablesOpenAliases": _open_variables_aliases(),
    })


# Names whose VALUE must never leave this process. Deliberately broad and matched as a substring:
# over-redacting an innocent variable costs a user one click in ADO, under-redacting one publishes a
# live credential to every viewer of the portal.
#
# This is not hypothetical here. Release definitions 41 and 45 carry real secrets in plaintext inside
# their Docker `buildArguments` -- Sanity read/editor tokens, the AD B2C client secret, a SendGrid
# API key, the Sentry auth token, chatbot token, Google Maps key, POS basic-auth -- so ANY feature
# that surfaces build arguments is one regex away from leaking them to the viewer role.
# The pipelines the variables screen actually works on, in the order the team lists them.
#
# Scanning all 31 registered pipelines for one variable meant 31 full release-definition reads per
# search, which was slow enough to be annoying in the UI. This is the working set the requests
# actually name; the screen can still be pointed at everything when needed.
WORKING_SET_PIPELINES = [
    "doctor-storefront",        # doctorm-storefront
    "drm sanity",               # doctorm-sanity
    "magrabi storefront",
    "magrabi sanity",
    "ecom saleor core",
    "ecom-tabby",
    "ecom tamara",
    "ecom search app",
    "ecom-checkout-app",
    "ecom paymob",
    "macula singlemicro",       # single Micro
    "macula batch-processor",   # Batch-processor
    "macula integrations",      # integrations
    "macula dashboard",
]


_SECRET_NAME_PATTERN = re.compile(
    r"SECRET|TOKEN|PASSWORD|PASSWD|_PWD|APIKEY|API_KEY|_KEY$|_KEY_|^KEY_|CONNECTION|CONNSTR"
    r"|CREDENTIAL|PRIVATE|CERT|SAS_|_SAS|AUTH|DSN|SIGNATURE|SALT|SEED|LICENSE",
    re.IGNORECASE)


def _is_secret_name(name: str) -> bool:
    return bool(_SECRET_NAME_PATTERN.search(name or ""))


# Environments where the VIEWER role may see credential values. Deliberately an allow-list of the
# lower tiers, not a deny-list of the upper ones: a new environment added later must default to
# withholding, not to exposing.
_VIEWER_SECRET_ENVS = {"DEV", "SIT", "UAT"}

# Environments the variables screen serves AT ALL. BETA and PROD are deliberately absent: production
# configuration is not something this screen exists to show, and the safest way to guarantee that is
# to refuse the request rather than to hide a dropdown entry.
# Environments a VIEWER may open on the variables screen. Admins are not restricted -- they get
# every environment, including BETA and PROD.
_VIEWER_VARIABLES_ENVS = {"DEV", "SIT", "UAT"}

# Pipelines whose variables -- secret values included, on EVERY environment including BETA and PROD
# -- both roles may read in full. Asked for by Sanskar on 2026-09-16 for Rivoli and Rivoli Sanity,
# so the team can check those sites' configuration without an admin login.
#
# Keyed by (project, release definition id), never by name, so an alias collision or a renamed
# pipeline can never widen this to anything else. Every other pipeline keeps the rules above:
# viewers on DEV/SIT/UAT only, with credentials masked.
_OPEN_VARIABLES_DEFINITIONS = {
    ("ECom", 71),   # CD-Magrabi-Rivoli
    ("ECom", 72),   # CD-Magrabi-Rivoli-Sanity
}


def _variables_open(cfg) -> bool:
    """True for a pipeline whose variables both roles may read in full, on every environment."""
    return bool(cfg) and (cfg.get("project"), cfg.get("cd_id")) in _OPEN_VARIABLES_DEFINITIONS


def _open_variables_pipeline_keys() -> list:
    return sorted(k for k, c in PIPELINES.items() if _variables_open(c))


def _open_variables_aliases() -> list:
    """Every spelling the registry resolves for an open pipeline, normalised the same way
    _resolve_pipeline normalises, so the frontend can match the names it shows (including the live
    status board's) without a round trip per row."""
    names = set()
    for key in _open_variables_pipeline_keys():
        cfg = PIPELINES[key]
        for alias in cfg.get("aliases", [key]) + [key]:
            names.add(_normalize_pipeline_name(alias))
    return sorted(names)

# A build/script task whose NAME says production, wherever it happens to sit. The lower-environment
# stages keep disabled prod-flavoured copies of their Docker task with real production values
# hardcoded, so "which stage am I on" is not sufficient to decide whether a value is safe for a
# viewer -- the task has to be checked too. See the build-argument loop in api_env_vars.
_PROD_TASK_PATTERN = re.compile(r"prod|beta", re.IGNORECASE)


def _secret_visibility(env_name: str, cfg=None) -> str:
    """How much of a credential VALUE this caller may receive: "full", "masked" or "none".

    admin  -- "full", everywhere, no exceptions. That role already holds the Azure DevOps credential
              this portal authenticates with and can read every one of these values directly in ADO,
              so withholding buys no protection and makes it impossible to verify that a rotation
              actually landed.
    viewer -- "full" on the pipelines in _OPEN_VARIABLES_DEFINITIONS, on every environment.
              Otherwise "masked" on DEV/SIT/UAT: first three characters, asterisks, last three.
              Enough to recognise a value and confirm it changed, not enough to use.
              "none" anywhere else -- the value is dropped from the payload rather than masked, so
              it cannot be recovered from the response at all.
    """
    role = get_identity()
    if role == "admin":
        return "full"
    if role == "viewer":
        if _variables_open(cfg):
            return "full"
        return "masked" if (env_name or "").strip().upper() in _VIEWER_SECRET_ENVS else "none"
    return "none"


# A credential shorter than this is masked ENTIRELY. Revealing three characters from each end of an
# 8-character secret leaves two hidden, which is not masking -- it is a hint with extra steps.
_MASK_MIN_LENGTH = 12

# A value that is ONLY an Azure DevOps variable reference -- "$(SENTRY_AUTH_TOKEN)", "$(Build.BuildId)".
# These carry no secret material at all: they are a pointer saying "read the variable called X", and
# X is almost always the row's own name, which is already on screen. Masking one produced
# "$(S********EN)", which hid the single useful fact (WHICH variable it reads) while protecting
# nothing. The real credential lives in the stage variable this points at, and THAT row is masked.
_VALUE_IS_REFERENCE = re.compile(r"^\s*\$\([A-Za-z_][A-Za-z0-9_.\-]*\)\s*$")


def _mask_secret(value) -> str:
    """First three characters, then a fixed run of asterisks, then the last three.

    Enough to recognise a value and confirm a rotation changed it, without carrying the secret
    itself. The asterisk run is a FIXED width on purpose -- making it match the real length would
    leak how long the secret is, which is a free hint to anyone trying to guess it.
    """
    v = "" if value is None else str(value)
    # A bare $(NAME) reference is not a secret -- show it as it is. See _VALUE_IS_REFERENCE.
    if _VALUE_IS_REFERENCE.match(v):
        return v
    if len(v) < _MASK_MIN_LENGTH:
        return "********"
    return f"{v[:3]}********{v[-3:]}"


def _env_var_entry(name, value, source, is_secret_flag=False, secret_mode="none"):
    """One row of the env-vars view.

    `secret_mode` is one of "full", "masked", "none" -- see _secret_visibility:

      not a secret       -> the real value, always.
      secret + "full"    -> the real value. ADMIN only.
      secret + "masked"  -> first three characters, asterisks, last three. Viewer on DEV/SIT/UAT.
      secret + "none"    -> None. Dropped from the payload entirely rather than masked, so it
                            cannot be recovered by anyone reading the response.

    The masking is done HERE, server-side, and not in the browser. Masking in the UI would leave the
    full credential sitting in the JSON that produced the page, which is no protection at all -- one
    devtools tab away. Nothing that reaches the client holds a whole secret any more.

    `isSecret` is reported in every case so the UI can colour and label the row correctly.
    """
    secret = bool(is_secret_flag) or _is_secret_name(name)
    if not secret:
        shown = "" if value is None else str(value)
    elif secret_mode == "full":
        shown = "" if value is None else str(value)
    elif secret_mode == "masked":
        shown = _mask_secret(value)
    elif _VALUE_IS_REFERENCE.match("" if value is None else str(value)):
        # Even at "none": a pointer is not a credential, and hiding it makes a build argument
        # unreadable for no gain. What it points AT is still withheld on its own row.
        shown = str(value)
    else:
        shown = None
    return {
        "name": name,
        "value": shown,
        "isSecret": secret,
        "source": source,
        # Stripped before the response is sent. It exists only so the wiring pass can still see
        # "$(NAME)" on a row whose displayed value is masked or withheld.
        "rawValue": ("" if value is None else str(value)),
    }


@app.route("/api/env-vars")
@require_role("admin", "viewer")
def api_env_vars():
    """Configured variables for one pipeline stage, secrets withheld.

    Source is the CD release definition, which is where these actually come from: lower stages are
    token-substituted from stage variables at release time, and the PROD_TAG/BETA_TAG stages carry
    their values literally in the Docker task's buildArguments. Read-only -- this issues ADO GETs
    and nothing else.
    """
    pipeline_name = request.args.get("pipeline") or ""
    env_name = (request.args.get("env") or "").strip()
    cfg = _resolve_pipeline(pipeline_name)
    if not cfg:
        return jsonify({"ok": False, "message": f"unknown pipeline '{pipeline_name}'"}), 400
    if not env_name:
        return jsonify({"ok": False, "message": "env is required"}), 400
    # BETA and PROD are not served by this screen at all, for ANY role. Removing them from the
    # dropdown alone would have been cosmetic -- the endpoint would still answer a hand-made
    # request. This is the actual boundary; the picker just reflects it.
    # Viewers are held to the lower environments. Admins are not restricted at all, and neither is
    # anyone on a pipeline listed in _OPEN_VARIABLES_DEFINITIONS.
    open_pipeline = _variables_open(cfg)
    if (get_identity() != "admin" and not open_pipeline
            and env_name.strip().upper() not in _VIEWER_VARIABLES_ENVS):
        return jsonify({"ok": False, "message": (
            f"{env_name.upper()} is not available on this screen -- "
            f"only {', '.join(sorted(_VIEWER_VARIABLES_ENVS))}")}), 403

    try:
        d = _get(f"{release_base(cfg['project'])}/release/definitions/{cfg['cd_id']}"
                 f"?api-version={API_VERSION}")
    except Exception as e:
        return jsonify({"ok": False, "message": f"could not read release definition: {e}"}), 502

    # Match the stage the same way the status page buckets it, so "BETA"/"PROD" resolve to whatever
    # this pipeline actually calls those stages.
    stage = next((e for e in d.get("environments", [])
                  if _matches_status_env(env_name.upper(), e.get("name") or "")), None)
    if stage is None:
        stage = next((e for e in d.get("environments", [])
                      if (e.get("name") or "").upper() == env_name.upper()), None)
    if stage is None:
        available = [e.get("name") for e in d.get("environments", [])]
        return jsonify({"ok": False, "message": f"no '{env_name}' stage on {pipeline_name}",
                        "available": available}), 404

    # "full" for admin (and for everyone on an open pipeline), "masked" for a viewer on a lower
    # environment, "none" otherwise.
    reveal = _secret_visibility(env_name, cfg)

    entries = []
    for name, meta in (d.get("variables") or {}).items():
        if isinstance(meta, dict):
            entries.append(_env_var_entry(name, meta.get("value"), "definition variable",
                                          meta.get("isSecret"), reveal))
    for name, meta in (stage.get("variables") or {}).items():
        if isinstance(meta, dict):
            entries.append(_env_var_entry(name, meta.get("value"), "stage variable",
                                          meta.get("isSecret"), reveal))

    groups = []
    for gid in (stage.get("variableGroups") or []):
        try:
            g = _get(f"https://dev.azure.com/{ORG}/{cfg['project']}/_apis/distributedtask"
                     f"/variablegroups/{gid}?api-version={API_VERSION}")
        except Exception:
            continue
        groups.append(g.get("name") or str(gid))
        for name, meta in (g.get("variables") or {}).items():
            if isinstance(meta, dict):
                entries.append(_env_var_entry(name, meta.get("value"),
                                              f"variable group: {g.get('name') or gid}",
                                              meta.get("isSecret"), reveal))

    # Docker buildArguments: newline-separated NAME=VALUE, and the only place the prod/beta stages
    # record their real values.
    #
    # SECURITY: reveal is decided PER ROW here, not per stage. The lower-environment stages carry
    # DISABLED prod-flavoured build tasks with hardcoded PRODUCTION values -- verified 2026-08-20:
    # def 45's DEV stage has a disabled 'Build-prod' with 20 literal credential-shaped arguments,
    # 10 of which differ from the DEV values (i.e. they are production credentials), and def 41's
    # DEV stage has the same shape with 14/9. Deciding reveal from the STAGE alone therefore handed
    # a viewer production secrets through the DEV screen, defeating _VIEWER_SECRET_ENVS entirely.
    # A task named prod/beta is treated as production wherever it sits.
    for phase in (stage.get("deployPhases") or []):
        for task in (phase.get("workflowTasks") or []):
            ba = (task.get("inputs") or {}).get("buildArguments")
            if not ba:
                continue
            task_name = task.get("name") or "task"
            row_reveal = ("none"
                          if (get_identity() != "admin" and not open_pipeline
                              and _PROD_TASK_PATTERN.search(task_name))
                          else reveal)
            for line in str(ba).replace("\r", "\n").split("\n"):
                line = line.strip()
                if not line or "=" not in line or line.startswith("#"):
                    continue
                name, value = line.split("=", 1)
                entry = _env_var_entry(name.strip(), value.strip(),
                                       f"build argument ({task_name})", False, row_reveal)
                # A disabled task contributes nothing at build time. Surfaced so the UI can say so
                # rather than showing a production URL on a DEV stage with no explanation.
                entry["taskEnabled"] = bool(task.get("enabled"))
                # False on a push task, whose buildArguments Azure DevOps never reads.
                entry["buildsImage"] = _task_builds_image(task)
                entries.append(entry)

    # `export NAME=value` inside an inline script -- the third mechanism, and for several stages the
    # ONLY one. CD-Magrabi-Sanity's SIT stage has no Docker task at all: it is a Node tool installer
    # plus one Command Line Script whose export block carries every setting. Those were invisible on
    # this screen until now, which is why the stage looked like it had two variables when the script
    # actually sets a dozen.
    for phase in (stage.get("deployPhases") or []):
        for task in (phase.get("workflowTasks") or []):
            inputs = task.get("inputs") or {}
            skey = _script_input_key(inputs)
            if not skey:
                continue
            task_name = task.get("name") or "script"
            # Same per-row rule as the build arguments above: a prod-named task is production
            # wherever it sits, so a viewer never gets its values off a lower-environment screen.
            row_reveal = ("none"
                          if (get_identity() != "admin" and not open_pipeline
                              and _PROD_TASK_PATTERN.search(task_name))
                          else reveal)
            for _line_no, ename, evalue in _iter_script_exports(inputs[skey]):
                entry = _env_var_entry(ename, _unquote(evalue),
                                       f"{_EDITABLE_SCRIPT_EXPORT} ({task_name})",
                                       False, row_reveal)
                entry["taskEnabled"] = bool(task.get("enabled"))
                entries.append(entry)

    # WIRING: does each stage variable actually reach the image?
    #
    # A stage variable alone is only substituted into the deploy YAML. It reaches the BUILD only if
    # a Docker build argument references it, conventionally `NAME=$(NAME)`. That second half is easy
    # to forget and invisible once forgotten: the variable is present, the screen looks right, and
    # the setting silently never arrives. Ecom Paymob sat exactly like that -- both Sentry DSNs
    # defined as stage variables with no build argument, so Sentry received nothing while the
    # pipeline looked fully configured.
    #
    # So every stage-variable row is told whether anything consumes it, and every build-argument row
    # is told whether it is a reference or a hardcoded literal.
    _consumers = {}
    for _e in entries:
        _src = _e.get("source") or ""
        if not (_src.startswith("build argument") or _src.startswith(_EDITABLE_SCRIPT_EXPORT)):
            continue
        # A push task's buildArguments are never read, so an argument sitting there consumes
        # nothing. Counting it would report a stage variable as wired when the value reaches
        # nothing at all -- the precise false reassurance this indicator exists to prevent.
        if _e.get("buildsImage") is False:
            continue
        _raw = (_e.get("rawValue") or "").strip()
        _m = _VALUE_IS_REFERENCE.match(_raw)
        _e["isReference"] = bool(_m)
        _key = _raw[2:-1].strip() if _m else _e["name"]
        _consumers.setdefault(_key, []).append(_src)

    # A build argument is not the only consumer. The "Set Environment Variables" tasks sed stage
    # variables into the deploy YAML -- sed -i "s|NAMESPACE|$(NAMESPACE_VAR)|g" -- and the _VAR
    # convention exists precisely for that. Counting only build arguments would report NAMESPACE_VAR,
    # NODEPOOL_NAME_VAR and TOLERATION_NAME_VAR as unused on every pipeline, which is both wrong and
    # exactly the kind of false alarm that trains people to ignore the indicator.
    for _phase in (stage.get("deployPhases") or []):
        for _task in (_phase.get("workflowTasks") or []):
            _ins = _task.get("inputs") or {}
            _skey = _script_input_key(_ins)
            if not _skey:
                continue
            _tname = _task.get("name") or "script"
            for _ref in set(re.findall(r"\$\(([A-Za-z_][A-Za-z0-9_.\-]*)\)", str(_ins[_skey]))):
                _consumers.setdefault(_ref, []).append(f"script ({_tname})")
    for _e in entries:
        if (_e.get("source") or "") != "stage variable":
            continue
        _by = _consumers.get(_e["name"], [])
        _e["wiredBy"] = _by
        _e["wired"] = bool(_by)

    # Tasks a new build argument could be added to. Deliberately keyed on the INPUT EXISTING rather
    # than on it being non-empty, matching _create_variable_in_definition: a Docker task whose
    # buildArguments is currently blank is still a valid target, and it would be absent from the
    # list above (which only walks arguments that already have a value).
    build_arg_tasks = []
    script_tasks = []
    for phase in (stage.get("deployPhases") or []):
        for task in (phase.get("workflowTasks") or []):
            inputs = task.get("inputs") or {}
            tname = task.get("name") or ""
            if ("buildArguments" in inputs and _task_builds_image(task)
                    and tname and tname not in build_arg_tasks):
                build_arg_tasks.append(tname)
            if _script_input_key(inputs) and tname and tname not in script_tasks:
                script_tasks.append(tname)

    # Tasks that rewrite placeholder tokens in the deploy YAML -- the third mechanism, and the one
    # a variable can be missing from while looking perfectly configured everywhere else.
    _sed_task, _ = _find_sed_task(stage)
    yaml_tasks = [_sed_task.get("name") or "script"] if _sed_task is not None else []

    # Later sources win on name collision, but every occurrence is kept so the origin is visible.
    entries.sort(key=lambda e: (e["name"].upper(), e["source"]))

    # Variable-group values live on a different ADO resource with its own API, so they are shown
    # but not editable from here -- editing them through the definition would do nothing.
    #
    # Nothing is editable for a viewer. The write routes are already @require_role("admin"), so this
    # is presentation rather than the real guard -- but reporting editable=true to a client that
    # would be refused on save is a worse experience than not offering it.
    can_edit = get_identity() == "admin"
    for e in entries:
        e["editable"] = can_edit and not e["source"].startswith("variable group")
        e.pop("rawValue", None)

    return jsonify({
        "ok": True,
        "pipeline": pipeline_name,
        "env": env_name.upper(),
        "stageName": stage.get("name"),
        "definitionName": d.get("name"),
        "project": cfg["project"],
        "variableGroups": groups,
        # Docker tasks on this stage that can receive a new build argument. Empty means this stage
        # has none, and the UI must not offer "build argument" as a target for it.
        "buildArgTasks": build_arg_tasks,
        # Tasks carrying an inline script, which can receive a new `export NAME=value` line. This is
        # the target for the stages that have no Docker task at all.
        "scriptTasks": script_tasks,
        "yamlTasks": yaml_tasks,
        "entries": entries,
        "secretCount": sum(1 for e in entries if e["isSecret"]),
        # Tells the UI whether it is holding real secret values, so it can offer a reveal toggle
        # only when there is something to reveal. False for a viewer on BETA/PROD.
        "revealed": reveal,
        # True when this pipeline is in _OPEN_VARIABLES_DEFINITIONS: every role, every environment,
        # values in full.
        "openToViewers": open_pipeline,
        # Whether this caller may write at all. Viewers get a read-only screen.
        "canEdit": can_edit,
        # Sent back on save so ADO can reject the write if anyone edited the definition meanwhile.
        "revision": d.get("revision"),
        # Surfaced so the UI can warn where a definition edit will NOT change what actually runs.
        "liveValueSource": _live_value_source(cfg, stage.get("name") or ""),
    })


# Stages whose RUNNING configuration does not come from the release definition at all.
#
# For the storefront pipelines, prod and beta Deployment env values are hardcoded in YAML committed
# to ADO repo `ecom` @ master; the release only substitutes two bare tokens before `kubectl apply`.
# Editing a definition variable for those stages therefore changes what the IMAGE is built with, but
# not what the running pods get -- and silently diverges the two. Saying so in the UI is the only
# thing standing between a user and a change they believe took effect.
_GIT_BACKED_STAGE_PIPELINES = {"doctor-storefront", "magrabi-storefront"}


def _live_value_source(cfg: dict, stage_name: str):
    key = None
    for name, entry in PIPELINES.items():
        if entry is cfg:
            key = name
            break
    if key in _GIT_BACKED_STAGE_PIPELINES and re.search(r"prod|beta", stage_name, re.IGNORECASE):
        return {
            "warning": True,
            "message": ("Pod environment values for this stage are committed in ADO repo `ecom` @ "
                        "master under /devops/prod/k8/, not taken from this definition. Editing "
                        "here changes the image build arguments only -- the running pods keep the "
                        "values from Git until that YAML is changed by PR."),
        }
    return {"warning": False, "message": ""}


ENV_CHANGES_DIR = Path(os.environ.get("ENV_CHANGES_DIR", str(RUNS_DIR.parent / "env_changes")))

# Sources this portal is willing to write back to, and how.
_EDITABLE_STAGE_VAR = "stage variable"
_EDITABLE_DEF_VAR = "definition variable"
_EDITABLE_BUILD_ARG = "build argument"


def _task_builds_image(task: dict) -> bool:
    """True when this Docker task actually BUILDS, so its buildArguments mean something.

    The same Docker task id serves both building and pushing, and a `buildArguments` input sits in
    the JSON either way -- but Azure DevOps only reads it when the action is a build. For a push
    task it does not even render the Build Arguments field, and the stored value is inert.

    CD-Ecom-Tabby UAT is the proof: `build` (action "Build an image") carries 17 arguments while
    `Push` (action "Push an image") carries a stale 5 that nobody has maintained -- because nothing
    has ever read them. Rivoli SIT is the same shape, 26 against 23.

    This corrects an earlier assumption in this file that a second Docker task meant a second image
    build, and that an argument missing from it was a half-wired stage. It was not: writing to the
    push task added noise to the definition and made the wiring indicator claim a consumer that
    does nothing.

    Unknown shapes (no action and no command at all) count as building, so a task form not seen
    here is never silently skipped.
    """
    ins = task.get("inputs") or {}
    action = ins.get("action")
    command = ins.get("command")
    if action is None and command is None:
        return True
    return "build" in f"{action or ''} {command or ''}".lower()
_EDITABLE_SCRIPT_EXPORT = "script export"


def _record_env_change(entry: dict) -> None:
    """Append-only audit of every variable write, on the same PVC as the deploy runs.

    Values are NOT recorded -- only names, sources, who, when and the revision either side. An
    audit file that captured the new value of a secret would be a worse leak than the one this
    whole feature is trying to avoid."""
    try:
        ENV_CHANGES_DIR.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).isoformat().replace(":", "-")
        (ENV_CHANGES_DIR / f"{stamp}_{entry.get('pipeline','?')}_{entry.get('env','?')}.json"
         ).write_text(json.dumps(entry, indent=2, default=str), encoding="utf-8")
    except Exception as e:
        print("env change audit write failed:", e)


def _apply_build_arg(build_args: str, name: str, value: str) -> tuple:
    """Returns (new_text, found). Rewrites NAME=... in a Docker buildArguments block in place,
    preserving line order and every other line byte-for-byte."""
    lines = str(build_args).replace("\r\n", "\n").replace("\r", "\n").split("\n")
    found = False
    for i, line in enumerate(lines):
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        if stripped.split("=", 1)[0].strip() == name:
            lines[i] = f"{name}={value}"
            found = True
    return "\n".join(lines), found


# Task inputs that hold an inline shell script. ADO names the input differently per task type:
# CmdLine@2 and Bash@3 call it "script", AzureCLI@2 calls it "inlineScript".
_SCRIPT_INPUT_KEYS = ("script", "inlineScript")

# `export NAME=value` -- the THIRD way these pipelines set configuration, after stage variables and
# Docker build arguments. Several stages have no Docker task at all and carry everything this way:
# CD-Magrabi-Sanity's SIT stage is a Node tool installer plus one Command Line Script whose export
# block holds every setting, live credentials included. Captured in four groups so a rewrite can put
# the line back with its original indentation and spacing untouched.
_EXPORT_LINE = re.compile(r"^(\s*export\s+)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$")


def _script_input_key(inputs) -> str:
    """Which input on this task holds a non-empty inline script, or '' if none does."""
    if not isinstance(inputs, dict):
        return ""
    for key in _SCRIPT_INPUT_KEYS:
        text = inputs.get(key)
        if isinstance(text, str) and text.strip():
            return key
    return ""


def _iter_script_exports(text: str):
    """Yields (line_index, name, raw_value) for every `export NAME=...`, in file order."""
    lines = str(text).replace("\r\n", "\n").replace("\r", "\n").split("\n")
    for i, line in enumerate(lines):
        m = _EXPORT_LINE.match(line)
        if m:
            yield i, m.group(2), m.group(4)


def _unquote(value: str) -> str:
    """Strips ONE layer of matching quotes for display. The stored line keeps its own quoting."""
    v = (value or "").strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in ("'", '"'):
        return v[1:-1]
    return v


def _requote_like(original: str, new_value: str) -> str:
    """Writes a value back in the quoting style the line already used.

    Silently changing `export X="a b"` into `export X=a b` would turn the value into a command --
    the script would still run and the variable would be wrong, which is exactly the class of
    failure this screen exists to avoid. An unquoted value that now contains whitespace gets quoted
    for the same reason.
    """
    o = (original or "").strip()
    if len(o) >= 2 and o[0] == o[-1] and o[0] in ("'", '"'):
        q = o[0]
        return f"{q}{new_value}{q}"
    if any(c.isspace() for c in new_value):
        return f'"{new_value}"'
    return new_value


def _apply_script_export(text: str, name: str, value: str) -> tuple:
    """Returns (new_text, found). Rewrites `export NAME=...` in place, preserving that line's
    indentation and spacing and every other line byte-for-byte."""
    lines = str(text).replace("\r\n", "\n").replace("\r", "\n").split("\n")
    found = False
    for i, line in enumerate(lines):
        m = _EXPORT_LINE.match(line)
        if m and m.group(2) == name:
            lines[i] = f"{m.group(1)}{name}{m.group(3)}{_requote_like(m.group(4), value)}"
            found = True
    return "\n".join(lines), found


_SED_RULE_RE = re.compile(r'^(\s*)sed\s+-i\s+"s\|([^|]+)\|([^|]*)\|g"\s+(\S+)\s*$')

# The stage variable this portal creates is named NAME, so the placeholder it fills is NAME_VAR and
# the rule reads s|NAME_VAR|$(NAME)|g. That matches the newer convention in these scripts (the
# TABBY_* block on def 38). Older lines carry the same name on both sides --
# s|SECRET_KEY_VAR|$(SECRET_KEY_VAR)|g -- because their stage variable is itself called
# SECRET_KEY_VAR. Both work; new ones follow the newer form.
_YAML_PLACEHOLDER_SUFFIX = "_VAR"


def _iter_sed_rules(text: str):
    """Every `sed -i "s|TOKEN|REPLACEMENT|g" TARGET` line.

    Yields (line_index, token, replacement, target, indent).

    This is the THIRD place a stage holds configuration, and the only one with no representation
    anywhere else in this portal. The deployment YAML ships with placeholder tokens --
    SECRET_KEY_VAR, TABBY_UAE_API_HOST_VAR -- which this task rewrites just before `kubectl apply`.

    A variable can be a correct stage variable AND a correct build argument and STILL arrive at the
    pod as the literal string "TABBY_UAE_API_HOST_VAR", because no rule was ever added for it. That
    is exactly what happened to Ecom Tabby UAT, found 2026-09-07: five variables set through this
    portal, every one of them unsubstituted in the running pod.
    """
    for i, line in enumerate(text.replace("\r\n", "\n").split("\n")):
        m = _SED_RULE_RE.match(line)
        if m:
            yield i, m.group(2), m.group(3), m.group(4), m.group(1)


def _sed_insert_index(tokens, token: str):
    """Where a new rule for `token` must sit among `tokens`. Returns (index, None) or (None, reason).

    sed rewrites SUBSTRINGS, so when one token contains another the LONGER one must run first.
    `s|SECRET_KEY_VAR|...|g` also matches inside `TABBY_SECRET_KEY_VAR` and rewrites it to
    "TABBY_" + the other variable's value -- a silent corruption rather than a visible miss, and the
    reason a live UAT pod carried `TABBY_tabby-app`.

    So a new rule goes AFTER every rule whose token contains it, and BEFORE every rule whose token it
    contains. Ordering here is not cosmetic; it decides whether the value survives.
    """
    after, before = -1, len(tokens)
    for i, tok in enumerate(tokens):
        if tok == token:
            return None, "exists"
        if token in tok:
            after = max(after, i)
        elif tok in token:
            before = min(before, i)
    if after >= before:
        return None, "conflict"
    return max(before, after + 1), None


def _add_sed_rule(text: str, token: str, var_name: str):
    """Insert a substitution rule in the only position that is safe. Returns (new_text, error)."""
    rules = list(_iter_sed_rules(text))
    if not rules:
        return None, "this stage has no deploy-YAML substitution step to add to"
    pos, err = _sed_insert_index([r[1] for r in rules], token)
    if err == "exists":
        return None, f"{token} is already substituted in this stage's deploy YAML step"
    if err == "conflict":
        return None, (f"cannot place {token} safely -- existing rules would each have to run both "
                      f"before and after it. Add it by hand and check the ordering.")
    nl = "\r\n" if "\r\n" in text else "\n"
    lines = text.replace("\r\n", "\n").split("\n")
    # Indentation and the target file are borrowed from a neighbouring rule rather than assuming
    # `$FILE_NAME`: the variable holding the filename differs between pipelines.
    ref = rules[pos] if pos < len(rules) else rules[-1]
    line_at = ref[0] if pos < len(rules) else ref[0] + 1
    lines.insert(line_at, f'{ref[4]}sed -i "s|{token}|$({var_name})|g" {ref[3]}')
    return nl.join(lines), None


def _find_sed_task(stage: dict, task_name: str = ""):
    """The task that rewrites placeholders in the deploy YAML, if this stage has one."""
    for phase in (stage.get("deployPhases") or []):
        for task in (phase.get("workflowTasks") or []):
            inputs = task.get("inputs") or {}
            skey = _script_input_key(inputs)
            if not skey:
                continue
            if task_name and (task.get("name") or "") != task_name:
                continue
            if any(True for _ in _iter_sed_rules(str(inputs[skey]))):
                return task, skey
    return None, None


def _add_script_export(text: str, name: str, value: str) -> str:
    """Inserts a new export immediately after the LAST existing one.

    Position matters and the end of the file is wrong: these scripts are an export block followed by
    `npm install` and the build itself, so anything appended lands after the commands that were
    supposed to read it. Grouping it with the others is also where a human would look for it.
    """
    lines = str(text).replace("\r\n", "\n").replace("\r", "\n").split("\n")
    last = -1
    for i, line in enumerate(lines):
        if _EXPORT_LINE.match(line):
            last = i
    new_line = f"export {name}={_requote_like('', value)}"
    if last >= 0:
        lines.insert(last + 1, new_line)
    elif lines and lines[0].lstrip().startswith("#!"):
        # Never above a shebang -- it would stop being one.
        lines.insert(1, new_line)
    else:
        lines.insert(0, new_line)
    return "\n".join(lines)


def _write_variables_to_definition(cfg: dict, env_name: str, changes: list,
                                   expected_revision=None) -> dict:
    """Read-modify-write one release definition. Returns a result dict; never raises for an
    expected failure, so a bulk run can report per pipeline instead of aborting on the first miss.

    Shared by the single-pipeline and multi-pipeline routes so there is exactly one place that
    knows how a variable is located and written.
    """
    rbase = release_base(cfg["project"])
    try:
        d = _get(f"{rbase}/release/definitions/{cfg['cd_id']}?api-version={API_VERSION}")
    except Exception as e:
        return {"ok": False, "code": 502, "message": f"could not read release definition: {e}"}

    live_revision = d.get("revision")
    if expected_revision is not None and int(expected_revision) != int(live_revision or -1):
        return {"ok": False, "code": 409, "revision": live_revision, "message": (
            f"this definition changed since you loaded it (you had revision {expected_revision}, "
            f"it is now {live_revision}) -- reload before saving so you do not overwrite "
            f"someone else's edit")}

    stage = next((e for e in d.get("environments", [])
                  if _matches_status_env(env_name.upper(), e.get("name") or "")), None)
    if stage is None:
        stage = next((e for e in d.get("environments", [])
                      if (e.get("name") or "").upper() == env_name.upper()), None)
    if stage is None:
        return {"ok": False, "code": 404,
                "message": f"no '{env_name}' stage on this pipeline",
                "available": [e.get("name") for e in d.get("environments", [])]}

    applied, missing = [], []
    for c in changes:
        name, value = c["name"], str(c["value"])
        source = (c.get("source") or "").lower()
        done = False

        if source.startswith(_EDITABLE_STAGE_VAR) or not source:
            meta = (stage.get("variables") or {}).get(name)
            if isinstance(meta, dict):
                meta["value"] = value
                applied.append({"name": name, "source": _EDITABLE_STAGE_VAR})
                done = True
        if not done and (source.startswith(_EDITABLE_DEF_VAR) or not source):
            meta = (d.get("variables") or {}).get(name)
            if isinstance(meta, dict):
                meta["value"] = value
                applied.append({"name": name, "source": _EDITABLE_DEF_VAR})
                done = True
        if not done:
            for phase in (stage.get("deployPhases") or []):
                for task in (phase.get("workflowTasks") or []):
                    inputs = task.get("inputs") or {}
                    if not inputs.get("buildArguments"):
                        continue
                    new_text, found = _apply_build_arg(inputs["buildArguments"], name, value)
                    if found:
                        inputs["buildArguments"] = new_text
                        applied.append({"name": name,
                                        "source": f"{_EDITABLE_BUILD_ARG} ({task.get('name')})"})
                        done = True
                if done:
                    break
        if not done:
            # Last, because an export line is the least structured of the four and the most
            # expensive to get wrong -- a bad rewrite corrupts a deployment script rather than a
            # dictionary entry. _apply_script_export only ever replaces the value portion of a line
            # whose name matches exactly, and leaves every other byte alone.
            for phase in (stage.get("deployPhases") or []):
                for task in (phase.get("workflowTasks") or []):
                    inputs = task.get("inputs") or {}
                    skey = _script_input_key(inputs)
                    if not skey:
                        continue
                    new_text, found = _apply_script_export(inputs[skey], name, value)
                    if found:
                        inputs[skey] = new_text
                        applied.append({"name": name,
                                        "source": f"{_EDITABLE_SCRIPT_EXPORT} ({task.get('name')})"})
                        done = True
                if done:
                    break
        if not done:
            missing.append(name)

    if missing:
        # All-or-nothing WITHIN a definition: a partial write leaves it in a state nobody reviewed.
        # Across definitions the bulk route deliberately continues, so one pipeline that simply
        # does not carry the variable cannot block the rest.
        return {"ok": False, "code": 400, "missing": missing, "message": (
            "no change was made -- these do not exist on this stage: " + ", ".join(sorted(missing)))}

    try:
        r = _put(f"{rbase}/release/definitions?api-version={API_VERSION}", d)
    except Exception as e:
        return {"ok": False, "code": 502, "message": f"write failed: {e}"}
    if r.status_code >= 400:
        hint = ""
        if r.status_code in (401, 403):
            hint = (" -- the Azure DevOps token this portal uses cannot edit release definitions; "
                    "it needs Release 'manage' scope")
        return {"ok": False, "code": 502,
                "message": f"Azure DevOps rejected the write: HTTP {r.status_code} "
                           f"{r.text[:200]}{hint}"}
    try:
        new_revision = r.json().get("revision")
    except ValueError:
        new_revision = None

    return {"ok": True, "code": 200, "changed": applied, "stageName": stage.get("name"),
            "revisionBefore": live_revision, "revisionAfter": new_revision}


@app.route("/api/env-vars/find")
@require_role("admin")
def api_env_vars_find():
    """Which pipelines carry a given variable on a given environment, and where it lives.

    This is the preview for a bulk rotation. Asked to "update SENTRY_AUTH_TOKEN across the saleor
    apps, both Sanity and both storefronts", the first real question is which of those pipelines
    actually define it -- guessing produces either a silent no-op on the ones that do not, or a
    missed pipeline that keeps serving the old credential. Read-only; no value is ever returned,
    only whether it exists and in which source.
    """
    name = (request.args.get("name") or "").strip()
    env_name = (request.args.get("env") or "").strip()
    if not name or not env_name:
        return jsonify({"ok": False, "message": "name and env are required"}), 400

    # Default scope is the working set, not every registered pipeline: a search used to cost 31
    # full release-definition reads, which was slow enough to be unusable interactively. `scope=all`
    # is still available when something genuinely needs the whole org.
    wanted = request.args.get("pipelines")
    if wanted:
        targets = [p.strip() for p in wanted.split(",") if p.strip()]
    elif (request.args.get("scope") or "").lower() == "all":
        targets = list(PIPELINES.keys())
    else:
        targets = list(WORKING_SET_PIPELINES)

    # Captured outside the worker: request context is not available on pool threads.
    reveal = _secret_visibility(env_name)

    def probe(pname):
        cfg = _resolve_pipeline(pname)
        if not cfg:
            return {"pipeline": pname, "found": False, "reason": "unknown pipeline"}
        try:
            d = _get(f"{release_base(cfg['project'])}/release/definitions/{cfg['cd_id']}"
                     f"?api-version={API_VERSION}")
        except Exception as e:
            return {"pipeline": pname, "found": False, "reason": f"read failed: {e}"}
        stage = next((e for e in d.get("environments", [])
                      if _matches_status_env(env_name.upper(), e.get("name") or "")), None)
        if stage is None:
            stage = next((e for e in d.get("environments", [])
                          if (e.get("name") or "").upper() == env_name.upper()), None)
        if stage is None:
            return {"pipeline": pname, "found": False, "project": cfg["project"],
                    "reason": f"no {env_name.upper()} stage",
                    "stages": [e.get("name") for e in d.get("environments", [])]}

        # The CURRENT value is returned per pipeline (admin only) so the search view can show what
        # each one holds right now and let them be edited individually -- the same variable
        # legitimately differs per pipeline, so a single "set them all to X" box is not enough.
        sources, value = [], None
        sv = (stage.get("variables") or {}).get(name)
        if isinstance(sv, dict):
            sources.append(_EDITABLE_STAGE_VAR)
            value = sv.get("value")
        dv = (d.get("variables") or {}).get(name)
        if isinstance(dv, dict):
            sources.append(_EDITABLE_DEF_VAR)
            if value is None:
                value = dv.get("value")
        for phase in (stage.get("deployPhases") or []):
            for task in (phase.get("workflowTasks") or []):
                ba = (task.get("inputs") or {}).get("buildArguments")
                if not ba:
                    continue
                for line in str(ba).replace("\r", "\n").split("\n"):
                    s = line.strip()
                    if s and "=" in s and not s.startswith("#") and s.split("=", 1)[0].strip() == name:
                        sources.append(f"{_EDITABLE_BUILD_ARG} ({task.get('name')})")
                        if value is None:
                            value = s.split("=", 1)[1].strip()
                        break
        # Script exports count as a definition of the variable too -- without this, a rotation
        # across pipelines reports "not defined" for every stage that sets it in a Command Line
        # Script, which is most of the Sanity stages.
        for phase in (stage.get("deployPhases") or []):
            for task in (phase.get("workflowTasks") or []):
                inputs = task.get("inputs") or {}
                skey = _script_input_key(inputs)
                if not skey:
                    continue
                for _line_no, ename, evalue in _iter_script_exports(inputs[skey]):
                    if ename != name:
                        continue
                    sources.append(f"{_EDITABLE_SCRIPT_EXPORT} ({task.get('name')})")
                    if value is None:
                        value = _unquote(evalue)
                    break
        entry = _env_var_entry(name, value, ", ".join(sources), False, reveal)
        return {"pipeline": pname, "project": cfg["project"], "stageName": stage.get("name"),
                "found": bool(sources), "sources": sources,
                "value": entry["value"] if sources else None,
                "isSecret": entry["isSecret"],
                "revision": d.get("revision"),
                "reason": "" if sources else f"not defined on {stage.get('name')}"}

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(probe, targets))

    results.sort(key=lambda r: (not r.get("found"), r["pipeline"]))
    return jsonify({
        "ok": True, "name": name, "env": env_name.upper(),
        "found": [r for r in results if r.get("found")],
        "notFound": [r for r in results if not r.get("found")],
        "total": len(results),
    })


def _create_variable_in_definition(cfg: dict, env_name: str, name: str, value: str,
                                   target: str, task_name: str = "",
                                   dry_run: bool = False) -> dict:
    """Add a variable that does not exist yet, into a chosen section of one stage.

    `target` is explicit and has no default on purpose. The two sections behave completely
    differently at runtime:

      * "stage"    -> a release stage variable. Substituted into the deploy YAML at release time.
      * "buildArg" -> a line in the Docker task's `buildArguments`. Baked into the IMAGE at build
                      time, which is where several of these pipelines hardcode their configuration.

    Putting a value in the wrong one is silent: nothing errors, the variable simply has no effect.
    So the caller states which section it means, and the UI shows which sections a pipeline has.
    """
    rbase = release_base(cfg["project"])
    try:
        d = _get(f"{rbase}/release/definitions/{cfg['cd_id']}?api-version={API_VERSION}")
    except Exception as e:
        return {"ok": False, "message": f"could not read release definition: {e}"}

    stage = next((e for e in d.get("environments", [])
                  if _matches_status_env(env_name.upper(), e.get("name") or "")), None)
    if stage is None:
        stage = next((e for e in d.get("environments", [])
                      if (e.get("name") or "").upper() == env_name.upper()), None)
    if stage is None:
        return {"ok": False, "message": f"no '{env_name}' stage on this pipeline"}

    # Duplicate detection is PER TARGET, not across the whole stage.
    #
    # The same name legitimately exists as BOTH a stage variable (holding the value) and a build
    # argument that consumes it as $(NAME) -- that is the standard pattern in these pipelines, not a
    # mistake. `build-last` on def 41 DEV is full of exactly that. Checking globally made the
    # commonest legitimate creation impossible: adding NEXT_PUBLIC_SENTRY_DSN as a build argument on
    # a stage that already carries it as a stage variable was refused with "already exists".
    #
    # The check resolves the SAME task the write will use, so the two can never disagree.
    def _find_target_task(input_key_test):
        """First task matching task_name (or the first that accepts this kind at all)."""
        for phase in (stage.get("deployPhases") or []):
            for task in (phase.get("workflowTasks") or []):
                if not input_key_test(task.get("inputs") or {}):
                    continue
                if task_name and (task.get("name") or "") != task_name:
                    continue
                return task
        return None

    if target == "stage":
        if isinstance((stage.get("variables") or {}).get(name), dict):
            return {"ok": False,
                    "message": f"{name} already exists as a stage variable -- edit it instead"}
    def _docker_arg_tasks():
        """Every task in the stage that BUILDS an image, not merely one that stores buildArguments.

        Two filters, and both matter:

          * all of them, not just the first -- a stage may genuinely build more than once, and
            writing to only the first would leave the later image without the value.
          * only tasks whose action actually builds -- see _task_builds_image. A push task carries a
            buildArguments input that Azure DevOps never reads and does not even display, so writing
            there adds a line that does nothing and makes the wiring indicator claim a consumer that
            consumes nothing.

        An earlier version of this had the second filter backwards: it treated `Push` on
        CD-Magrabi-Rivoli as a missed build and called the stage half-wired. It was not. The stale
        argument lists on those push tasks (Tabby 17 vs 5, Rivoli 26 vs 23) are the evidence that
        nothing has ever read them.
        """
        out = []
        for phase in (stage.get("deployPhases") or []):
            for task in (phase.get("workflowTasks") or []):
                if "buildArguments" not in (task.get("inputs") or {}):
                    continue
                if not _task_builds_image(task):
                    continue
                if task_name and (task.get("name") or "") != task_name:
                    continue
                out.append(task)
        return out

    def _has_arg(task, arg_name):
        text = str((task.get("inputs") or {}).get("buildArguments") or "")
        for line in text.replace("\r", "\n").split("\n"):
            st = line.strip()
            if st and "=" in st and st.split("=", 1)[0].strip() == arg_name:
                return True
        return False

    if target == "buildArg":
        _targets = _docker_arg_tasks()
        if not _targets:
            return {"ok": False,
                    "message": "this stage has no Docker task with build arguments to add to"}
        _already = [t for t in _targets if _has_arg(t, name)]
        # Only a genuine no-op is refused. When some tasks have it and others do not, the stage is
        # half-wired -- which is the defect, so completing it is the right outcome, not an error.
        if len(_already) == len(_targets):
            _names = ", ".join((t.get("name") or "?") for t in _already)
            return {"ok": False,
                    "message": f"{name} is already a build argument on {_names} -- edit it instead"}
    elif target == "scriptExport":
        t = _find_target_task(lambda ins: bool(_script_input_key(ins)))
        if t is None:
            return {"ok": False, "message": "this stage has no inline script to add an export to"}
        ins = t.get("inputs") or {}
        for _line_no, ename, _v in _iter_script_exports(ins[_script_input_key(ins)]):
            if ename == name:
                return {"ok": False,
                        "message": f"{name} is already exported by {t.get('name')} -- edit it instead"}

    created_in = None
    if target == "stage":
        stage.setdefault("variables", {})[name] = {
            "value": value, "isSecret": False, "allowOverride": False,
        }
        created_in = _EDITABLE_STAGE_VAR
    elif target == "buildArg":
        # Every Docker task in the stage, not the first one only -- see _docker_arg_tasks. Tasks
        # that already carry the argument are left untouched rather than duplicated, so this also
        # repairs a stage that was previously half-wired.
        _written = []
        for task in _docker_arg_tasks():
            if _has_arg(task, name):
                continue
            inputs = task["inputs"]
            text = str(inputs.get("buildArguments") or "")
            sep = "" if (not text or text.endswith("\n")) else "\n"
            inputs["buildArguments"] = f"{text}{sep}{name}={value}"
            _written.append(task.get("name") or "?")
        if not _written:
            return {"ok": False,
                    "message": "this stage has no Docker task with build arguments to add to"}
        created_in = f"{_EDITABLE_BUILD_ARG} ({', '.join(_written)})"
    elif target == "scriptExport":
        for phase in (stage.get("deployPhases") or []):
            for task in (phase.get("workflowTasks") or []):
                inputs = task.get("inputs") or {}
                skey = _script_input_key(inputs)
                if not skey:
                    continue
                if task_name and (task.get("name") or "") != task_name:
                    continue
                inputs[skey] = _add_script_export(inputs[skey], name, value)
                created_in = f"{_EDITABLE_SCRIPT_EXPORT} ({task.get('name')})"
                break
            if created_in:
                break
        if not created_in:
            return {"ok": False,
                    "message": "this stage has no inline script to add an export to"}
    elif target == "yamlPlaceholder":
        # The deploy YAML substitution step. Placement is decided by _sed_insert_index, because sed
        # rewrites substrings and the wrong order silently corrupts a neighbouring value.
        sed_task, skey = _find_sed_task(stage, task_name)
        if sed_task is None:
            return {"ok": False,
                    "message": ("this stage has no deploy YAML substitution step -- nothing here "
                                "rewrites placeholder tokens before kubectl apply")}
        token = f"{name}{_YAML_PLACEHOLDER_SUFFIX}"
        new_text, sed_err = _add_sed_rule(str(sed_task["inputs"][skey]), token, name)
        if sed_err:
            return {"ok": False, "message": sed_err}
        sed_task["inputs"][skey] = new_text
        created_in = f"deploy YAML substitution {token} ({sed_task.get('name')})"
    else:
        return {"ok": False,
                "message": (f"unknown target '{target}' (use 'auto', 'stage', 'buildArg', "
                            f"'scriptExport' or 'yamlPlaceholder')")}

    # Everything above mutated only the in-memory definition. Stopping here proves out the whole
    # decision path -- stage resolved, target task(s) found, duplicate rules applied -- with nothing
    # sent to Azure DevOps. This exists because testing the write path against a live pipeline once
    # created a real variable on Ecom Tabby UAT that had to be reverted by hand.
    if dry_run:
        return {"ok": True, "dryRun": True, "source": created_in,
                "stageName": stage.get("name"),
                "message": f"Dry run: would add {name} to {created_in}. Nothing was written."}

    try:
        r = _put(f"{rbase}/release/definitions?api-version={API_VERSION}", d)
    except Exception as e:
        return {"ok": False, "message": f"write failed: {e}"}
    if r.status_code >= 400:
        hint = ""
        if r.status_code in (401, 403):
            hint = (" -- the Azure DevOps token this portal uses cannot edit release definitions; "
                    "it needs Release 'manage' scope")
        return {"ok": False, "message": f"Azure DevOps rejected the write: HTTP {r.status_code} "
                                        f"{r.text[:200]}{hint}"}
    try:
        new_revision = r.json().get("revision")
    except ValueError:
        new_revision = None
    return {"ok": True, "createdIn": created_in, "stageName": stage.get("name"),
            "revisionBefore": d.get("revision"), "revisionAfter": new_revision}


def _create_variable_wired(cfg: dict, env_name: str, name: str, value: str,
                           dry_run: bool = False) -> dict:
    """Add a variable AND every piece that makes it actually take effect, in one action.

    A stage can hold configuration in THREE independent places, and which ones a value needs depends
    entirely on the stage. Getting it wrong is completely silent -- nothing errors, the value simply
    never arrives:

      1. **Stage variable** -- holds the value. On its own it reaches nothing.
      2. **Docker build argument** `NAME=$(NAME)` -- bakes it into the image at build time. Ecom
         Paymob had both Sentry DSNs as stage variables with no build argument: fully configured on
         screen, Sentry receiving nothing.
      3. **Deploy YAML placeholder** -- a `sed -i "s|NAME_VAR|$(NAME)|g"` line that rewrites a token
         in the deployment manifest before `kubectl apply`. This is the one with no other
         representation in this portal, and the one that bit Ecom Tabby UAT on 2026-09-07: five
         variables correct as stage variables AND correct as build arguments, every one of them
         arriving at the pod as the literal string `TABBY_..._VAR`.

    So each mechanism the stage actually has gets its piece, and each piece is added only if it is
    genuinely missing -- an existing half is work already done, not an error. Only a variable that is
    already complete on every mechanism is refused.

    A stage with none of the above but an inline script of `export NAME=value` lines gets one of
    those instead: it has no image build and no manifest step, so anything else would be a decoy.
    """
    rbase = release_base(cfg["project"])
    try:
        d = _get(f"{rbase}/release/definitions/{cfg['cd_id']}?api-version={API_VERSION}")
    except Exception as e:
        return {"ok": False, "message": f"could not read release definition: {e}"}
    stage = _find_stage(d, env_name)
    if not stage:
        return {"ok": False, "message": f"no '{env_name}' stage on this pipeline"}

    has_build = any("buildArguments" in (t.get("inputs") or {}) and t.get("enabled")
                    and _task_builds_image(t)
                    for ph in (stage.get("deployPhases") or [])
                    for t in (ph.get("workflowTasks") or []))
    sed_task, _sed_key = _find_sed_task(stage)
    has_sed = sed_task is not None
    has_script = any(_script_input_key(t.get("inputs") or {}) and t.get("enabled")
                     for ph in (stage.get("deployPhases") or [])
                     for t in (ph.get("workflowTasks") or []))

    if has_build or has_sed:
        existing_var = (stage.get("variables") or {}).get(name)
        has_stage_var = isinstance(existing_var, dict)
        did, notes, problems = [], [], []

        if not has_stage_var:
            first = _create_variable_in_definition(cfg, env_name, name, value, "stage",
                                                   dry_run=dry_run)
            if not first.get("ok"):
                return first
            did.append("stage variable")
        else:
            # Deliberately NOT overwritten. This is a create, and silently replacing a value someone
            # else set is not something to do unasked -- but saying nothing would leave them
            # believing the value they typed had been applied.
            current = existing_var.get("value")
            notes.append(
                "the stage variable already existed and was left as it is"
                + ("" if current == value else
                   " (it holds a different value; edit it in the table if you meant to change it)")
            )

        if has_build:
            r = _create_variable_in_definition(cfg, env_name, name, f"$({name})", "buildArg",
                                               dry_run=dry_run)
            if r.get("ok"):
                did.append(r.get("source") or "build argument")
            elif "already a build argument" in (r.get("message") or ""):
                notes.append("the build argument was already there")
            else:
                problems.append(f"build argument: {r.get('message')}")

        if has_sed:
            r = _create_variable_in_definition(cfg, env_name, name, value, "yamlPlaceholder",
                                               dry_run=dry_run)
            if r.get("ok"):
                did.append(r.get("source") or "deploy YAML substitution")
            elif "already substituted" in (r.get("message") or ""):
                notes.append("the deploy YAML substitution was already there")
            else:
                problems.append(f"deploy YAML step: {r.get('message')}")

        if not did:
            return {"ok": False,
                    "message": (f"{name} is already set up on every mechanism this stage uses -- "
                                f"edit it instead.")}
        message = "Added " + ", ".join(did) + "."
        if notes:
            message += " Note: " + "; ".join(notes) + "."
        if problems:
            # Never reported as a clean success: the parts that did land do not work without these.
            message += " NOT done: " + "; ".join(problems) + "."
        return {"ok": True, "did": did, "stageName": stage.get("name"),
                "partial": bool(problems), "message": message}

    if has_script:
        only = _create_variable_in_definition(cfg, env_name, name, value, "scriptExport",
                                              dry_run=dry_run)
        if not only.get("ok"):
            return only
        return {"ok": True, "did": [only.get("source") or "script export"],
                "stageName": only.get("stageName"),
                "message": (f"Added as {only.get('source')}. This stage builds no image and has no "
                            f"deploy YAML substitution step, so there is nothing else to wire.")}

    return {"ok": False,
            "message": ("This stage has no Docker build task, no deploy YAML substitution step and "
                        "no inline script, so there is nowhere for the value to take effect. Add it "
                        "as a stage variable explicitly if you only need it in the deploy YAML.")}


@app.route("/api/env-vars/create", methods=["POST"])
@require_role("admin")
def api_env_vars_create():
    """Create a NEW variable on one or many pipelines, in a named section of one stage."""
    payload = request.get_json(force=True) or {}
    pipelines = payload.get("pipelines") or []
    env_name = (payload.get("env") or "").strip()
    name = (payload.get("name") or "").strip()
    value = payload.get("value")
    target = (payload.get("target") or "").strip()
    task_name = (payload.get("taskName") or "").strip()
    # Resolves and validates everything, then stops short of the PUT. Lets the write path be
    # exercised against a real pipeline without changing it.
    dry_run = bool(payload.get("dryRun"))

    if not pipelines:
        return jsonify({"ok": False, "message": "select at least one pipeline"}), 400
    if not env_name or not name or value is None:
        return jsonify({"ok": False, "message": "env, name and value are required"}), 400
    if target not in ("stage", "buildArg", "scriptExport", "yamlPlaceholder", "auto"):
        return jsonify({"ok": False,
                        "message": ("target must be 'auto', 'stage', 'buildArg', 'scriptExport' "
                                    "or 'yamlPlaceholder'")}), 400
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
        return jsonify({"ok": False, "message": (
            "variable names must be letters, digits and underscores, starting with a letter or "
            "underscore -- anything else will not resolve at build time")}), 400

    results = []
    for pname in pipelines:
        cfg = _resolve_pipeline(pname)
        if not cfg:
            results.append({"pipeline": pname, "ok": False, "message": "unknown pipeline"})
            continue
        out = (_create_variable_wired(cfg, env_name, name, str(value), dry_run=dry_run)
               if target == "auto"
               else _create_variable_in_definition(cfg, env_name, name, str(value), target,
                                                   task_name, dry_run=dry_run))
        results.append({"pipeline": pname, **out})
        # A dry run changed nothing, so recording it would put a phantom entry in the audit
        # trail that reads exactly like a real edit.
        if out.get("ok") and not dry_run:
            _record_env_change({
                "at": datetime.now(timezone.utc).isoformat(),
                "by": get_username(),
                "pipeline": pname, "env": env_name.upper(),
                "project": cfg["project"], "definitionId": cfg["cd_id"],
                "stageName": out.get("stageName"),
                "revisionBefore": out.get("revisionBefore"),
                "revisionAfter": out.get("revisionAfter"),
                "created": True,
                # Name and section only -- never the value.
                "changed": [{"name": name, "source": out.get("createdIn")}],
            })

    ok_count = sum(1 for r in results if r.get("ok"))
    verb = "would create" if dry_run else "created"
    return jsonify({
        "ok": ok_count > 0,
        "dryRun": dry_run,
        "message": (f"{verb} {name} on {ok_count} of {len(results)} pipeline(s) "
                    f"({env_name.upper()})." + (" Nothing was written." if dry_run else "")),
        "updated": ok_count, "total": len(results), "results": results,
    })


@app.route("/api/env-vars/bulk-update", methods=["POST"])
@require_role("admin")
def api_env_vars_bulk_update():
    """Apply the same variable change across MANY pipelines at once, for one environment.

    Exists because the real request is never "change this on one pipeline" -- it is
    "rotate SENTRY_AUTH_TOKEN across the saleor apps, both Sanity pipelines and both storefronts",
    which is otherwise eight visits to the same screen with the same value pasted eight times, and
    every paste is a chance to typo a credential.

    Per-pipeline results, not all-or-nothing: pipelines legitimately differ in which variables they
    carry, and one that simply does not have the variable must not block the seven that do. Within
    a single definition the write is still all-or-nothing.

    No revision guard here: each definition is read and written back within the same call, so the
    stale-tab race the single-pipeline route protects against does not apply.
    """
    payload = request.get_json(force=True) or {}
    pipelines = payload.get("pipelines") or []
    env_name = (payload.get("env") or "").strip()
    changes = payload.get("changes") or []

    if not isinstance(pipelines, list) or not pipelines:
        return jsonify({"ok": False, "message": "select at least one pipeline"}), 400
    if not env_name:
        return jsonify({"ok": False, "message": "env is required"}), 400
    if not isinstance(changes, list) or not changes:
        return jsonify({"ok": False, "message": "no changes supplied"}), 400
    for c in changes:
        if not isinstance(c, dict) or not c.get("name") or c.get("value") is None:
            return jsonify({"ok": False, "message": "each change needs a name and a value"}), 400

    # Optional per-pipeline overrides: {"<pipeline>": {"<VAR>": "<value>"}}. Same variable, same
    # environment, different value per pipeline is normal here (a DSN or endpoint usually differs),
    # so one submit can carry both "set these eight to X" and "except this one, which gets Y".
    overrides = payload.get("values") or {}

    results = []
    for pname in pipelines:
        cfg = _resolve_pipeline(pname)
        if not cfg:
            results.append({"pipeline": pname, "ok": False, "message": "unknown pipeline"})
            continue
        per = overrides.get(pname) or {}
        # Values are intentionally NOT passed through source: a bulk rotation should land wherever
        # the variable actually lives on each pipeline, which differs between them.
        out = _write_variables_to_definition(cfg, env_name,
                                             [{"name": c["name"],
                                               "value": per.get(c["name"], c["value"])}
                                              for c in changes])
        entry = {"pipeline": pname, "ok": out.get("ok", False),
                 "message": out.get("message", ""), "changed": out.get("changed", []),
                 "stageName": out.get("stageName"),
                 "revisionBefore": out.get("revisionBefore"),
                 "revisionAfter": out.get("revisionAfter"),
                 "missing": out.get("missing", [])}
        results.append(entry)
        if out.get("ok"):
            _record_env_change({
                "at": datetime.now(timezone.utc).isoformat(),
                "by": get_username(),
                "pipeline": pname, "env": env_name.upper(),
                "project": cfg["project"], "definitionId": cfg["cd_id"],
                "stageName": out.get("stageName"),
                "revisionBefore": out.get("revisionBefore"),
                "revisionAfter": out.get("revisionAfter"),
                "bulk": True,
                "changed": out.get("changed", []),
            })

    ok_count = sum(1 for r in results if r["ok"])
    return jsonify({
        "ok": ok_count > 0,
        "message": (f"updated {ok_count} of {len(results)} pipeline(s) on {env_name.upper()}. "
                    f"New releases pick this up; existing releases do not."),
        "updated": ok_count,
        "total": len(results),
        "results": results,
    })


@app.route("/api/env-vars/update", methods=["POST"])
@require_role("admin")
def api_env_vars_update():
    """Writes variable values back to an Azure DevOps release definition.

    Deliberate design constraints, each one load-bearing:

    * **Revision guard.** Classic release definitions have no per-variable PATCH -- the only way to
      change one is to PUT the whole definition back. The caller must send the `revision` it read,
      and it is passed through to ADO, which rejects the write if anyone edited the definition in
      between. Without that, two people editing different variables would silently clobber each
      other, and a definition here carries ~200 build arguments including live credentials.
    * **No blind creation.** Only variables that already exist are updated. A typo in a name is far
      more likely than a genuine need to invent one from this screen, and an invented build
      argument silently does nothing at build time.
    * **Rollback is ADO's own.** No copy of the definition is stored here (it would mean writing
      plaintext secrets onto the PVC). ADO keeps every revision -- the response returns the previous
      one so it can be restored from the definition's history.
    * **Nothing is recorded except names.** See _record_env_change.
    """
    payload = request.get_json(force=True) or {}
    pipeline_name = payload.get("pipeline") or ""
    env_name = (payload.get("env") or "").strip()
    changes = payload.get("changes") or []
    expected_revision = payload.get("revision")

    cfg = _resolve_pipeline(pipeline_name)
    if not cfg:
        return jsonify({"ok": False, "message": f"unknown pipeline '{pipeline_name}'"}), 400
    if not env_name:
        return jsonify({"ok": False, "message": "env is required"}), 400
    if not isinstance(changes, list) or not changes:
        return jsonify({"ok": False, "message": "no changes supplied"}), 400
    for c in changes:
        if not isinstance(c, dict) or not c.get("name"):
            return jsonify({"ok": False, "message": "each change needs a name"}), 400
        if c.get("value") is None:
            return jsonify({"ok": False, "message": f"no value supplied for {c.get('name')}"}), 400

    out = _write_variables_to_definition(cfg, env_name, changes, expected_revision)
    if not out.get("ok"):
        body = {"ok": False, "message": out.get("message", "write failed")}
        if out.get("revision") is not None:
            body["revision"] = out["revision"]
        if out.get("available"):
            body["available"] = out["available"]
        return jsonify(body), out.get("code", 400)

    _record_env_change({
        "at": datetime.now(timezone.utc).isoformat(),
        "by": get_username(),
        "pipeline": pipeline_name, "env": env_name.upper(),
        "project": cfg["project"], "definitionId": cfg["cd_id"],
        "stageName": out.get("stageName"),
        "revisionBefore": out.get("revisionBefore"), "revisionAfter": out.get("revisionAfter"),
        # Names and sources only -- never values.
        "changed": out.get("changed", []),
    })

    return jsonify({
        "ok": True,
        "message": (f"updated {len(out.get('changed', []))} variable(s) on {out.get('stageName')}. "
                    f"New releases will pick this up; releases already created will not."),
        "changed": out.get("changed", []),
        "revisionBefore": out.get("revisionBefore"),
        "revisionAfter": out.get("revisionAfter"),
    })


@app.route("/api/env-vars/history")
@require_role("admin")
def api_env_vars_history():
    """Recent variable writes made through this portal. Names only, never values."""
    items = []
    if ENV_CHANGES_DIR.exists():
        for path in sorted(glob.glob(str(ENV_CHANGES_DIR / "*.json")), reverse=True)[:100]:
            try:
                items.append(json.loads(Path(path).read_text(encoding="utf-8")))
            except Exception:
                continue
    return jsonify({"ok": True, "items": items})


@app.route("/api/live-status")
@require_role("admin", "viewer")
def api_live_status():
    with _cache_lock:
        return jsonify({"rows": _cache["live_status"], "updated": _cache["live_status_updated"]})


# Deliberately admin-only, not "admin + viewer minus the buttons" -- developers get ONLY the
# live-status view, per the explicit access-tier requirement. Same route, same shape, as before.
@app.route("/api/my-deployments")
@require_role("admin")
def api_my_deployments():
    with _cache_lock:
        return jsonify({
            "rows": _cache["my_deployments"],
            "updated": _cache["my_deployments_updated"],
            # Same reasoning as the live board: while Azure DevOps is unreachable every row here is
            # frozen at whatever it last saw, so an "approved, waiting" row may in fact be long
            # finished -- or a deployment started just now may be missing entirely.
            "adoReachable": _cache.get("ado_reachable", True),
            "adoError": _cache.get("ado_error"),
            "adoFailedSince": _cache.get("ado_failed_since"),
        })


# ---------------------------------------------------------------------------------------------
# Feedback. Split across the role boundary on purpose: SUBMITTING is admin+viewer (the whole point
# is that the developers using the portal can report what's broken without going through an admin),
# while the INBOX -- reading, triaging, deleting, and viewing attachments -- is admin-only. Anything
# a submitter sends about WHO they are is ignored; identity comes from the signed session.
#
# Storage is one JSON file per item in FEEDBACK_DIR, deliberately the same shape as deploy_runs:
# no database to run, back up, or migrate for what is a low-volume internal suggestion box, and the
# whole inbox stays readable with `cat` when something needs debugging in the pod.
# ---------------------------------------------------------------------------------------------
FEEDBACK_TYPES = ("bug", "improvement", "suggestion")
FEEDBACK_STATUSES = ("new", "planned", "done", "dismissed")
FEEDBACK_TITLE_MAX = 200
FEEDBACK_DESCRIPTION_MAX = 5000
FEEDBACK_LINK_MAX = 500
FEEDBACK_ADMIN_NOTE_MAX = 5000
FEEDBACK_ATTACHMENT_MAX_BYTES = 3 * 1024 * 1024

# The extension a stored attachment gets is looked up HERE, from the declared content type -- the
# user-supplied filename is never consulted and never reaches the filesystem. That closes the whole
# class of "upload a file called ../../x.html" and "upload shell.php" problems at the source rather
# than trying to sanitize a hostile name into a safe one.
FEEDBACK_ATTACHMENT_TYPES = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
}
_FEEDBACK_EXT_TYPES = {ext: ctype for ctype, ext in FEEDBACK_ATTACHMENT_TYPES.items()}


@app.errorhandler(413)
def _handle_upload_too_large(_error):
    """MAX_CONTENT_LENGTH rejects the request before any route runs, and Flask's default 413 body is
    HTML -- which the frontend would fail to parse and render as an unexplained error. Answer in the
    same {ok, message} shape every other failure on these routes uses."""
    return jsonify({
        "ok": False,
        "message": f"That upload is too large. Attachments must be "
                   f"{FEEDBACK_ATTACHMENT_MAX_BYTES // (1024 * 1024)} MB or smaller.",
    }), 413


def _safe_feedback_id(candidate) -> str:
    """Guards every route that takes an <id> straight from the URL, exactly as
    api_dismiss_deployment() guards runId: the value is about to become a filename, so anything that
    could climb out of FEEDBACK_DIR is rejected before it touches the filesystem at all."""
    feedback_id = (candidate or "").strip()
    if not feedback_id or any(c in feedback_id for c in ("/", "\\", "..")):
        return ""
    return feedback_id


def _feedback_item(raw):
    """One stored record coerced to the exact FeedbackItem shape the frontend is typed against.
    Only this module ever writes these files, but a record from an older build -- or one truncated
    by a crash mid-write -- must still render rather than take the whole inbox down, so every field
    has a default and only a missing id is fatal."""
    if not isinstance(raw, dict) or not raw.get("id"):
        return None
    attachment = raw.get("attachment")
    feedback_type = raw.get("type")
    status = raw.get("status")
    return {
        "id": str(raw["id"]),
        # type and status are closed sets on the frontend's side of the contract, so a value from
        # outside them is pinned to a real member here rather than shipped as-is -- the UI keys
        # badges and counts off both, and neither has anywhere to put an unrecognized one.
        "type": feedback_type if feedback_type in FEEDBACK_TYPES else "suggestion",
        "title": raw.get("title") or "",
        "description": raw.get("description") or "",
        "link": raw.get("link") or "",
        "attachment": attachment if isinstance(attachment, str) and attachment else None,
        "submittedBy": raw.get("submittedBy") or "",
        "submittedByRole": raw.get("submittedByRole") or "",
        "submittedAt": raw.get("submittedAt") or "",
        "status": status if status in FEEDBACK_STATUSES else "new",
        "adminNote": raw.get("adminNote") or "",
    }


def _read_feedback(feedback_id: str):
    path = FEEDBACK_DIR / f"{feedback_id}.json"
    if not path.is_file():
        return None
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    # Falls back to the id from the URL so a record whose own id field was lost is still editable
    # rather than permanently stuck (the filename is the authoritative id either way).
    return _feedback_item({**raw, "id": raw.get("id") or feedback_id}) if isinstance(raw, dict) else None


def _write_feedback(item: dict) -> None:
    FEEDBACK_DIR.mkdir(parents=True, exist_ok=True)
    path = FEEDBACK_DIR / f"{item['id']}.json"
    path.write_text(json.dumps(item, indent=2, ensure_ascii=False), encoding="utf-8")


def _delete_feedback_attachment(feedback_id: str, name) -> None:
    """Removes the image belonging to one feedback item. Attachment names are always "<id><ext>",
    so when the record's own name is unreadable the file can still be found by id -- an unreadable
    record must not be able to strand an orphan on the volume forever."""
    if isinstance(name, str) and name and not any(c in name for c in ("/", "\\", "..")):
        targets = [FEEDBACK_ATTACHMENTS_DIR / name]
    else:
        targets = [Path(p) for p in
                   glob.glob(str(FEEDBACK_ATTACHMENTS_DIR / f"{glob.escape(feedback_id)}.*"))]
    for target in targets:
        try:
            if target.is_file():
                target.unlink()
        except OSError as e:
            # The JSON is already gone by this point, so the item is off the inbox either way --
            # a leftover image is worth logging, not worth failing the delete over.
            print("feedback attachment delete error:", target.name, e)


@app.route("/api/feedback", methods=["POST"])
@require_role("admin", "viewer")
def api_feedback_submit():
    """The one feedback route a viewer can reach. Everything about the submitter is taken from the
    session -- the form's own fields are only ever the content of the report."""
    role = get_identity()

    feedback_type = (request.form.get("type") or "").strip().lower()
    if feedback_type not in FEEDBACK_TYPES:
        return jsonify({"ok": False,
                        "message": f"Type must be one of: {', '.join(FEEDBACK_TYPES)}."}), 400

    title = (request.form.get("title") or "").strip()
    if not title:
        return jsonify({"ok": False, "message": "A title is required."}), 400
    if len(title) > FEEDBACK_TITLE_MAX:
        return jsonify({"ok": False,
                        "message": f"Title must be {FEEDBACK_TITLE_MAX} characters or fewer."}), 400

    description = (request.form.get("description") or "").strip()
    if not description:
        return jsonify({"ok": False, "message": "A description is required."}), 400
    if len(description) > FEEDBACK_DESCRIPTION_MAX:
        return jsonify({"ok": False,
                        "message": f"Description must be {FEEDBACK_DESCRIPTION_MAX} characters or fewer."}), 400

    link = (request.form.get("link") or "").strip()
    if link:
        if len(link) > FEEDBACK_LINK_MAX:
            return jsonify({"ok": False,
                            "message": f"Link must be {FEEDBACK_LINK_MAX} characters or fewer."}), 400
        # Scheme-checked rather than merely non-empty: this string is rendered as a clickable link
        # in the admin inbox, and "javascript:" is the reason that check exists.
        if not link.lower().startswith(("http://", "https://")):
            return jsonify({"ok": False, "message": "Link must start with http:// or https://."}), 400

    # A form submitted with an empty file input still arrives as a FileStorage, just with no
    # filename -- treated as "no attachment" rather than as an empty upload to reject.
    upload = request.files.get("attachment")
    if upload is not None and not (upload.filename or "").strip():
        upload = None

    attachment_ext = None
    if upload is not None:
        content_type = (upload.mimetype or "").split(";")[0].strip().lower()
        attachment_ext = FEEDBACK_ATTACHMENT_TYPES.get(content_type)
        if not attachment_ext:
            return jsonify({
                "ok": False,
                "message": "Attachment must be a PNG, JPEG, GIF or WEBP image.",
            }), 400
        # content_length is routinely 0 on a multipart part, so the real size is measured off the
        # stream itself; it is seekable whether Werkzeug kept it in memory or spooled it to disk.
        upload.stream.seek(0, os.SEEK_END)
        size = upload.stream.tell()
        upload.stream.seek(0)
        if size > FEEDBACK_ATTACHMENT_MAX_BYTES:
            return jsonify({
                "ok": False,
                "message": f"Attachment must be {FEEDBACK_ATTACHMENT_MAX_BYTES // (1024 * 1024)} MB or smaller.",
            }), 400
        if size == 0:
            return jsonify({"ok": False, "message": "That attachment is empty."}), 400

    submitted_at = datetime.now(timezone.utc).isoformat()
    # Filename-safe and sortable: the timestamp keeps records in chronological order on disk, the
    # random suffix keeps two submissions in the same microsecond from overwriting each other.
    feedback_id = f"{submitted_at.replace(':', '-').replace('.', '-')}_{secrets.token_hex(3)}"

    attachment_name = None
    if upload is not None and attachment_ext:
        attachment_name = f"{feedback_id}{attachment_ext}"
        try:
            FEEDBACK_ATTACHMENTS_DIR.mkdir(parents=True, exist_ok=True)
            upload.save(str(FEEDBACK_ATTACHMENTS_DIR / attachment_name))
        except OSError as e:
            return jsonify({"ok": False, "message": f"Couldn't store the attachment: {e}"}), 500

    item = {
        "id": feedback_id,
        "type": feedback_type,
        "title": title,
        "description": description,
        "link": link,
        "attachment": attachment_name,
        "submittedBy": get_username(),
        "submittedByRole": role,
        "submittedAt": submitted_at,
        "status": "new",
        "adminNote": "",
    }
    try:
        _write_feedback(item)
    except OSError as e:
        # The record is what makes the attachment reachable, so a failed write leaves an orphan
        # image behind -- cleaned up here rather than left on the volume.
        if attachment_name:
            _delete_feedback_attachment(feedback_id, attachment_name)
        return jsonify({"ok": False, "message": f"Couldn't save your feedback: {e}"}), 500

    return jsonify({"ok": True, "id": feedback_id})


@app.route("/api/feedback")
@require_role("admin")
def api_feedback_list():
    """The whole inbox, newest first. Sorted on submittedAt rather than on filename: the two agree
    today, but the filename is an implementation detail and the contract is the timestamp."""
    items = []
    if FEEDBACK_DIR.exists():
        for path in glob.glob(str(FEEDBACK_DIR / "*.json")):
            try:
                raw = json.loads(Path(path).read_text(encoding="utf-8"))
            except Exception as e:
                # One corrupt file hides one report; failing the request would hide all of them.
                print("feedback read error:", Path(path).name, e)
                continue
            item = _feedback_item(raw)
            if item:
                items.append(item)

    items.sort(key=lambda i: _parse_ado_dt(i["submittedAt"]) or datetime.min.replace(tzinfo=timezone.utc),
               reverse=True)

    counts = {status: 0 for status in FEEDBACK_STATUSES}
    for item in items:
        counts[item["status"]] += 1
    counts["total"] = len(items)
    return jsonify({"items": items, "counts": counts})


@app.route("/api/feedback/<feedback_id>", methods=["PATCH"])
@require_role("admin")
def api_feedback_patch(feedback_id):
    """Triage only. status and adminNote are the sole mutable fields -- what was reported, by whom,
    and when is an immutable record, so nothing here can rewrite it."""
    safe_id = _safe_feedback_id(feedback_id)
    if not safe_id:
        return jsonify({"ok": False, "message": "invalid feedback id"}), 400

    item = _read_feedback(safe_id)
    if item is None:
        return jsonify({"ok": False, "message": "feedback not found"}), 404

    payload = request.get_json(silent=True) or {}
    if "status" in payload:
        status = payload.get("status")
        if not isinstance(status, str) or status not in FEEDBACK_STATUSES:
            return jsonify({"ok": False,
                            "message": f"Status must be one of: {', '.join(FEEDBACK_STATUSES)}."}), 400
        item["status"] = status
    if "adminNote" in payload:
        note = payload.get("adminNote")
        if not isinstance(note, str):
            return jsonify({"ok": False, "message": "adminNote must be a string."}), 400
        note = note.strip()
        if len(note) > FEEDBACK_ADMIN_NOTE_MAX:
            return jsonify({"ok": False,
                            "message": f"Note must be {FEEDBACK_ADMIN_NOTE_MAX} characters or fewer."}), 400
        item["adminNote"] = note

    try:
        _write_feedback(item)
    except OSError as e:
        return jsonify({"ok": False, "message": f"Couldn't save the change: {e}"}), 500
    return jsonify({"ok": True, "item": item})


@app.route("/api/feedback/<feedback_id>", methods=["DELETE"])
@require_role("admin")
def api_feedback_delete(feedback_id):
    safe_id = _safe_feedback_id(feedback_id)
    if not safe_id:
        return jsonify({"ok": False, "message": "invalid feedback id"}), 400

    path = FEEDBACK_DIR / f"{safe_id}.json"
    if not path.is_file():
        return jsonify({"ok": False, "message": "feedback not found"}), 404

    item = _read_feedback(safe_id)
    try:
        path.unlink()
    except OSError as e:
        return jsonify({"ok": False, "message": f"Couldn't delete: {e}"}), 500
    _delete_feedback_attachment(safe_id, item.get("attachment") if item else None)
    return jsonify({"ok": True})


@app.route("/api/feedback/<feedback_id>/attachment")
@require_role("admin")
def api_feedback_attachment(feedback_id):
    """Serves a screenshot from the record's stored name only -- never from anything in the query
    string -- so the set of files this route can ever reach is exactly the set it wrote itself."""
    safe_id = _safe_feedback_id(feedback_id)
    if not safe_id:
        return jsonify({"ok": False, "message": "invalid feedback id"}), 400

    item = _read_feedback(safe_id)
    if item is None:
        return jsonify({"ok": False, "message": "feedback not found"}), 404

    name = item.get("attachment")
    if not name or any(c in name for c in ("/", "\\", "..")):
        return jsonify({"ok": False, "message": "no attachment on this feedback"}), 404
    if not (FEEDBACK_ATTACHMENTS_DIR / name).is_file():
        return jsonify({"ok": False, "message": "attachment file is missing"}), 404

    # Content-Type comes from our own extension map rather than from sniffing or from anything the
    # uploader said at request time -- the same map that chose the extension in the first place.
    mimetype = _FEEDBACK_EXT_TYPES.get(Path(name).suffix.lower())
    return send_from_directory(FEEDBACK_ATTACHMENTS_DIR, name, mimetype=mimetype)


# ---------------------------------------------------------------------------------------------
# Git-backed configuration (increment 1: READ ONLY)
#
# Some pipelines do not hold their runtime settings in the release definition at all. Saleor Core
# is the clearest case: a setting lives in a Kubernetes ConfigMap YAML in the `ecom` Git repo, and
# each service that needs it carries a `configMapKeyRef` env entry in its own deployment YAML. Two
# files, two pipelines to apply them, and the change lands through a pull request -- none of which
# the /api/env-vars routes can express.
#
# This module only READS. It resolves the files, joins the ConfigMap against the deployment env
# lists, and reports what it finds. Nothing here writes to Git; the preview and pull-request paths
# arrive in later increments behind their own routes.
# ---------------------------------------------------------------------------------------------
ECOM_REPO_ID = "d57e35b2-f3f5-4783-b8dc-7662730e1ad2"

_SALEOR_COMMON_SERVICES = [
    ("saleor-admin-api", "saleor-admin-api-deployment.yml"),
    ("saleor-app-api", "saleor-app-api-deployment.yml"),
    ("saleor-validator-api", "saleor-validator-api-deployment.yml"),
    ("saleor-checkout-api", "saleor-checkout-api-deployment.yml"),
    ("saleor-worker-1", "saleor-worker-1-deployment.yml"),
    ("saleor-worker-2", "saleor-worker-2-deployment.yml"),
    ("saleor-worker-3", "saleor-worker-3-deployment.yml"),
]
# Prod carries an eighth service. The dashboard has no deployment file in the common tree.
_SALEOR_PROD_SERVICES = _SALEOR_COMMON_SERVICES + [
    ("saleor-dashboard", "saleor-dashboard-deployment.yml"),
]


def _saleor_row(cm_path, services, deployments_dir, shared, apply_pipelines,
                namespace, cluster, optional_house_style):
    return {
        "project": "ECom", "repoId": ECOM_REPO_ID, "repoName": "ecom", "branch": "master",
        "shape": "configMapPlusDeployments",
        "configMapPath": cm_path,
        "configMapName": "saleor-core-config",
        "deploymentsDir": deployments_dir,
        "services": services,
        "sharedWithStages": shared,
        "optionalIsHouseStyle": optional_house_style,
        "applyPipelines": apply_pipelines,
        "namespace": namespace, "cluster": cluster,
    }


# HAND-WRITTEN ON PURPOSE -- do not replace this with auto-discovery.
#
# There is no link in ADO from an application's release definition to the definition that applies
# its ConfigMap. def 56 (CD-ConfigMap-Saleor-Core) has empty triggers, shares no artifact with
# def 34, and neither one references the other anywhere in its JSON. The two rules that look like
# they would work are both demonstrably wrong: name-suffix matching fails because def 58 is called
# CD-Secret-Saleor-Core but applies ecom-common-secret-*.yml, and (cluster, namespace) is
# many-to-many because five definitions write into saleor-dev.
#
# Paths also cannot be templated from the environment name. UAT is
# common/k8/configmap/saleor-core-configmap-uat.yml; PROD is
# prod/k8/configmaps/saleor-core-config.yml -- different directory, different filename, different
# spelling of "configmap", and there is no saleor-core-configmap-prod.yml at all. So every
# environment is its own row, written out in full.
#
# What IS derivable (the Kubernetes tasks' `configuration` inputs) is re-derived by
# scripts/verify_git_config_registry.py, which reports drift here rather than driving writes.
GIT_CONFIG_TARGETS = {
    ("ecom saleor core", "DEV"): _saleor_row(
        "/devops/common/k8/configmap/saleor-core-configmap-dev.yml",
        _SALEOR_COMMON_SERVICES, "/devops/common/k8/deployments/",
        ["SIT", "UAT"],
        [{"definitionId": 56, "name": "CD-ConfigMap-Saleor-Core", "stage": "DEV",
          "purpose": "configmap", "needsApproval": False},
         {"definitionId": 34, "name": "CD-Ecom-Saleor-Core", "stage": "DEV",
          "purpose": "workloads", "needsApproval": False}],
        "saleor-dev", "aks-ecom-common-uaenorth-001", True),
    ("ecom saleor core", "SIT"): _saleor_row(
        "/devops/common/k8/configmap/saleor-core-configmap-sit.yml",
        _SALEOR_COMMON_SERVICES, "/devops/common/k8/deployments/",
        ["DEV", "UAT"],
        [{"definitionId": 56, "name": "CD-ConfigMap-Saleor-Core", "stage": "SIT",
          "purpose": "configmap", "needsApproval": False},
         {"definitionId": 34, "name": "CD-Ecom-Saleor-Core", "stage": "SIT",
          "purpose": "workloads", "needsApproval": False}],
        "saleor-sit", "aks-ecom-common-uaenorth-001", True),
    ("ecom saleor core", "UAT"): _saleor_row(
        "/devops/common/k8/configmap/saleor-core-configmap-uat.yml",
        _SALEOR_COMMON_SERVICES, "/devops/common/k8/deployments/",
        ["DEV", "SIT"],
        [{"definitionId": 56, "name": "CD-ConfigMap-Saleor-Core", "stage": "UAT",
          "purpose": "configmap", "needsApproval": False},
         {"definitionId": 34, "name": "CD-Ecom-Saleor-Core", "stage": "UAT",
          "purpose": "workloads", "needsApproval": False}],
        "saleor-uat", "aks-ecom-common-uaenorth-001", True),
    ("ecom saleor core", "PROD"): _saleor_row(
        "/devops/prod/k8/configmaps/saleor-core-config.yml",
        _SALEOR_PROD_SERVICES, "/devops/prod/k8/deployments/",
        [],  # the prod tree is its own copy -- nothing else applies these files
        [{"definitionId": 56, "name": "CD-ConfigMap-Saleor-Core", "stage": "PROD",
          "purpose": "configmap", "needsApproval": True},
         {"definitionId": 16, "name": "Production-Release-Saleor", "stage": "PROD",
          "purpose": "workloads", "needsApproval": True}],
        "saleor", "aks-ecom-prod-uaenorth-001", False),
}


def _git_config_target(pipeline_key: str, env_name: str):
    return GIT_CONFIG_TARGETS.get((pipeline_key, (env_name or "").strip().upper()))


def _git_read_file(project, repo_id, path, ref="master"):
    """File content plus its blob sha. Returns (text, objectId), or (None, None) if absent.

    The blob objectId is what later increments use as a concurrency fence -- if it moved between
    preview and submit, someone else edited the file and the preview is stale.
    """
    url = f"{build_base(project)}/git/repositories/{repo_id}/items"
    try:
        got = _get(url, params={
            "path": path,
            "versionDescriptor.version": ref,
            "versionDescriptor.versionType": "branch",
            "includeContent": "true",
            "$format": "json",
            "api-version": "7.1",
        })
    except Exception:
        return None, None
    if not isinstance(got, dict):
        return None, None
    return got.get("content"), got.get("objectId")


def _git_branch_head(project, repo_id, branch="master"):
    url = f"{build_base(project)}/git/repositories/{repo_id}/refs"
    try:
        got = _get(url, params={"filter": f"heads/{branch}", "api-version": "7.1"})
    except Exception:
        return None
    for r in (got or {}).get("value", []):
        if r.get("name") == f"refs/heads/{branch}":
            return r.get("objectId")
    return None


_ENV_KEY = re.compile(r"^(\s*)env:\s*$")
_LIST_ITEM = re.compile(r"^(\s*)-\s")


def _yaml_indent(line: str) -> int:
    return len(line) - len(line.lstrip())


def _locate_env_block(text: str):
    """(env_idx, item_indent, insert_idx) for a deployment YAML's container env list.

    Pure line arithmetic -- nothing is re-emitted, so comments, quoting and every untouched line
    survive byte for byte.

    Two traps this exists to avoid, both measured across all 56 deployment files in the repo:

    1. APPENDING AT END OF FILE IS WRONG FOR 29 OF THEM. The env list is very often not the last
       thing in the file -- 15 of 28 prod files and 14 of 28 common files carry another key after
       it (lifecycle:, resources:, volumes:, livenessProbe:). saleor-checkout-api is the one where
       the two trees DISAGREE: the common copy ends with its env list, the prod copy ends with a
       lifecycle.postStart block. So an end-of-file append passes its UAT test and produces a
       broken production manifest, and the break only surfaces at kubectl apply inside the release.

    2. ITEM INDENT CANNOT BE COMPUTED. saleor-worker-1/2/3 put env: at indent 8 with their items
       at 12; every other file puts env: at 10 with items at 12. A rule of "item = env + 2" gives
       10 on the worker files, and a sequence mixing items at 10 and 12 is a parse error. The
       indent is COPIED from an existing sibling entry, never derived.
    """
    lines = text.split("\n")
    hits = [i for i, l in enumerate(lines) if _ENV_KEY.match(l)]
    if len(hits) != 1:
        raise ValueError(f"expected exactly one env: block, found {len(hits)}")
    env_idx = hits[0]
    env_ind = _yaml_indent(lines[env_idx])

    item_ind = None
    for j in range(env_idx + 1, len(lines)):
        l = lines[j]
        if not l.strip():
            continue
        if _yaml_indent(l) <= env_ind:
            break
        m = _LIST_ITEM.match(l)
        if m:
            item_ind = len(m.group(1))
            break
        raise ValueError("first entry under env: is not a list item")
    if item_ind is None:
        raise ValueError("env: block has no entries to copy indentation from")

    # End of block = first non-blank line at indent <= env_ind. This is the line that makes the
    # prod checkout file work: it stops at lifecycle: instead of running to EOF.
    end = len(lines)
    for j in range(env_idx + 1, len(lines)):
        l = lines[j]
        if not l.strip():
            continue
        if _yaml_indent(l) <= env_ind:
            end = j
            break
    while end - 1 > env_idx and not lines[end - 1].strip():
        end -= 1
    return env_idx, item_ind, end


def _describe_insert_point(text: str):
    """(canInsert, note) -- what the UI shows about whether this file can take a new entry."""
    try:
        _env_idx, _item_ind, at = _locate_env_block(text)
    except ValueError as e:
        return False, f"Cannot add settings to this file automatically: {e}"
    lines = text.split("\n")
    following = ""
    for l in lines[at:]:
        if l.strip():
            following = l.strip().rstrip(":")
            break
    if following:
        return True, ("New entries go at the end of the settings list, before the "
                      f"{following} section.")
    return True, "New entries go at the end of the settings list."


# ConfigMap keys carry live credentials in plaintext -- the UAT saleor-core file holds a storage
# account key, an API password and a Sentry DSN among ordinary settings. The name heuristic that
# works for release-definition variables (_is_secret_name) catches only 10 of that file's 87 keys,
# missing APP_ID, ADB2C_CLIENT_ID, AZURE_ACCOUNT_NAME, API_USERNAME and the SendGrid template ids.
# So this source INVERTS the default: everything is treated as a credential unless it is
# demonstrably not one. Over-masking a URL costs one click in ADO; under-masking a storage account
# key publishes a live credential to every viewer.
_CONFIGMAP_PUBLIC = re.compile(
    r"^(ENVIRONMENT|DEBUG|.*_ENABLED|ENABLE_.*|ALLOWED_(CLIENT_)?HOSTS|.*_URL|.*_DOMAIN"
    r"|.*_SLUG|.*_INDEX|.*_FOLDER|.*_SCHEDULE|.*_COUNT|SENTRY_ENVIRONMENT)$", re.IGNORECASE)


def _configmap_is_secret(key: str) -> bool:
    return not _CONFIGMAP_PUBLIC.match(key or "")


def _parse_configmap(text: str):
    """({key: value}, is_alphabetical) from a ConfigMap's data: block.

    Deliberately not yaml.safe_load: this keeps the ORDER and reports whether the block is sorted,
    which is what decides where a later increment inserts a new key. saleor-core-configmap-dev.yml
    is strictly alphabetical; -sit, -uat and the prod file are not.
    """
    lines = text.split("\n")
    data_idx = next((i for i, l in enumerate(lines) if re.match(r"^data:\s*$", l)), None)
    if data_idx is None:
        return {}, False
    out = {}
    for l in lines[data_idx + 1:]:
        if not l.strip():
            continue
        if _yaml_indent(l) == 0:
            break
        m = re.match(r"^\s+([A-Za-z_][A-Za-z0-9_.\-]*):\s*(.*)$", l)
        if not m:
            continue
        key, raw = m.group(1), m.group(2).strip()
        if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "'\"":
            raw = raw[1:-1]
        out[key] = raw
    names = list(out.keys())
    return out, names == sorted(names)


def _parse_deployment_env_refs(text: str):
    """[{name, kind, refName, refKey}] for each entry in a deployment's container env list.

    kind is configMap, secret or literal. A literal's value is never read out here -- only the
    fact that it is one.
    """
    try:
        env_idx, _item_ind, end = _locate_env_block(text)
    except ValueError:
        return []
    lines = text.split("\n")
    entries, cur = [], None
    for l in lines[env_idx + 1:end]:
        if not l.strip():
            continue
        m = re.match(r"^\s*-\s+name:\s*(\S+)\s*$", l)
        if m:
            if cur:
                entries.append(cur)
            cur = {"name": m.group(1), "kind": "literal", "refName": None, "refKey": None}
            continue
        if cur is None:
            continue
        if "configMapKeyRef" in l:
            cur["kind"] = "configMap"
        elif "secretKeyRef" in l:
            cur["kind"] = "secret"
        m2 = re.match(r"^\s*name:\s*(\S+)\s*$", l)
        if m2 and cur["kind"] in ("configMap", "secret"):
            cur["refName"] = m2.group(1)
        m3 = re.match(r"^\s*key:\s*(\S+)\s*$", l)
        if m3:
            cur["refKey"] = m3.group(1)
    if cur:
        entries.append(cur)
    return entries


@app.route("/api/git-config")
@require_role("admin", "viewer")
def api_git_config():
    """The joined read: what the settings file holds, which services use each key, what is broken.

    Viewers get this on the lower environments only, with credential values masked server-side --
    the same gate the Variables page already applies. The most useful thing on this screen is the
    mismatch list ("this service asks for a setting the file does not have"), which is diagnosis
    rather than credentials, so it is deliberately not admin-only.
    """
    pipeline_in = (request.args.get("pipeline") or "").strip()
    env_name = (request.args.get("env") or "").strip().upper()
    key = _PIPELINE_ALIAS_INDEX.get(_normalize_pipeline_name(pipeline_in))
    if not key:
        return jsonify({"ok": False, "message": f"unknown pipeline {pipeline_in!r}"}), 400

    if get_identity() != "admin" and env_name not in _VIEWER_VARIABLES_ENVS:
        return jsonify({"ok": False, "message":
                        f"{env_name} settings are available to administrators only."}), 403

    target = _git_config_target(key, env_name)
    if not target:
        return jsonify({"ok": True, "pipeline": key, "env": env_name, "mode": "pipeline",
                        "message": "This pipeline keeps its settings in the release definition, "
                                   "not in Git."}), 200

    project, repo = target["project"], target["repoId"]
    branch = target["branch"]
    head = _git_branch_head(project, repo, branch)
    reveal = _secret_visibility(env_name)

    cm_text, cm_sha = _git_read_file(project, repo, target["configMapPath"], branch)
    if cm_text is None:
        return jsonify({"ok": False, "message":
                        f"could not read {target['configMapPath']} at {branch}"}), 502
    cm_data, cm_sorted = _parse_configmap(cm_text)

    files = [{
        "role": "configmap", "path": target["configMapPath"], "objectId": cm_sha,
        "keyCount": len(cm_data), "alphabetical": cm_sorted,
    }]

    # key -> services referencing it, and the reverse: references to keys that do not exist.
    used_by, orphans = {}, []
    for service, filename in target["services"]:
        path = target["deploymentsDir"] + filename
        text, sha = _git_read_file(project, repo, path, branch)
        if text is None:
            files.append({"role": "deployment", "service": service, "path": path,
                          "objectId": None, "envCount": 0, "canInsert": False,
                          "insertNote": "File not found in the repository.",
                          "appliedByStages": [env_name] + target["sharedWithStages"]})
            continue
        refs = _parse_deployment_env_refs(text)
        can_insert, note = _describe_insert_point(text)
        for r in refs:
            if r["kind"] != "configMap" or r["refName"] != target["configMapName"]:
                continue
            k = r["refKey"] or r["name"]
            used_by.setdefault(k, []).append(service)
            if k not in cm_data:
                orphans.append({"service": service, "name": r["name"], "key": k})
        files.append({
            "role": "deployment", "service": service, "path": path, "objectId": sha,
            "envCount": len(refs), "canInsert": can_insert, "insertNote": note,
            "appliedByStages": [env_name] + target["sharedWithStages"],
        })

    keys = []
    for name, value in cm_data.items():
        entry = _env_var_entry(name, value, "settings file",
                               is_secret_flag=_configmap_is_secret(name), secret_mode=reveal)
        entry["usedBy"] = sorted(used_by.get(name, []))
        keys.append(entry)

    return jsonify({
        "ok": True, "pipeline": key, "env": env_name, "mode": "git",
        "repo": {"project": project, "name": target["repoName"],
                 "branch": branch, "commitId": head},
        "configMapName": target["configMapName"],
        "namespace": target["namespace"], "cluster": target["cluster"],
        "files": files, "keys": keys, "orphanRefs": orphans,
        "applyPipelines": target["applyPipelines"],
        "sharedWithStages": target["sharedWithStages"],
        "optionalIsHouseStyle": target["optionalIsHouseStyle"],
        "revealed": reveal,
        # Increment 1 is read-only by construction. The write path is a pull request and arrives
        # behind its own routes; nothing on this screen can change a file yet.
        "canEdit": False, "writeMode": "pullRequest",
    })


# ---------------------------------------------------------------------------------------------
# Git-backed configuration: the write path (add a setting, commit it, deploy it)
#
# The shape of the whole thing, because it is not obvious from any single function:
#
#   1. preview  -- read the files, make the edit IN MEMORY, validate it, hand back what changed
#   2. apply    -- re-read, re-validate, branch, commit, open a pull request. On DEV/SIT/UAT the
#                  portal completes that pull request itself; on PROD it never does.
#   3. deploy   -- run the ConfigMap pipeline, then the workloads pipeline. Lower environments only.
#
# Everything mutating is admin-only and every environment gate is checked server-side, never
# inferred from what the UI offered.
# ---------------------------------------------------------------------------------------------

# The portal completes its own pull request on these, and only these. Production always stops for
# a person. This is a deliberate, narrow exception to the repo's one-approval policy: the account
# the portal uses is permitted to approve its own change, so the ONLY thing standing between a
# typo and production is this list. Do not add "PROD" to it.
_GIT_AUTO_MERGE_ENVS = {"DEV", "SIT", "UAT"}

# The portal never triggers a production release. This mirrors the portal-wide rule that ENVIRONMENTS
# (DEV/SIT/UAT) is the only list any mutating deploy path is allowed to act on.
_GIT_DEPLOYABLE_ENVS = {"DEV", "SIT", "UAT"}

_VALID_SETTING_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _render_env_entry(item_ind, name, cm_name, key, optional=True):
    p = " " * item_ind
    out = [f"{p}- name: {name}",
           f"{p}  valueFrom:",
           f"{p}    configMapKeyRef:",
           f"{p}      name: {cm_name}",
           f"{p}      key: {key}"]
    if optional:
        # Not cosmetic. The ConfigMap and the deployment go out as two separate pipelines with
        # separate approvals; if the deployment lands first, a required key that does not exist yet
        # stops the pod from starting. With optional the pod starts and the setting is simply absent.
        out.append(f"{p}      optional: true")
    return out


def _insert_env_entry(text, name, cm_name, key, optional=True):
    """Add one env entry to a deployment's container env list, in place, touching nothing else."""
    lines = text.split("\n")
    _env_idx, item_ind, at = _locate_env_block(text)
    return "\n".join(lines[:at] + _render_env_entry(item_ind, name, cm_name, key, optional)
                     + lines[at:])


def _cm_scalar(value) -> str:
    """Quote every value the portal writes into a ConfigMap. Always.

    ConfigMap.data is map[string]string, and a value YAML types as anything else fails the apply for
    the WHOLE file -- not just that key. Under the YAML 1.1 rules PyYAML uses, `true`/`yes`/`on` are
    booleans, `60` is an int, `1.0` a float, `2026-08-25` a date. These files already work around it
    by hand (AZURE_SSL: 'True', BULK_INDEXING_SCHEDULE: '60'), inconsistently. An always-quoted value
    is never wrong, so there is no cleverness here to get wrong later.
    """
    v = "" if value is None else str(value)
    return "'" + v.replace("'", "''") + "'"


def _locate_configmap_data(text: str):
    """(data_idx, item_indent, insert_idx) for a ConfigMap's data: block."""
    lines = text.split("\n")
    data_idx = next((i for i, l in enumerate(lines) if re.match(r"^data:\s*$", l)), None)
    if data_idx is None:
        raise ValueError("no data: block in this settings file")
    item_ind = None
    for j in range(data_idx + 1, len(lines)):
        l = lines[j]
        if not l.strip():
            continue
        if _yaml_indent(l) == 0:
            break
        if re.match(r"^\s+[A-Za-z_][A-Za-z0-9_.\-]*:", l):
            item_ind = _yaml_indent(l)
            break
    if item_ind is None:
        raise ValueError("data: block has no entries to copy indentation from")
    end = len(lines)
    for j in range(data_idx + 1, len(lines)):
        l = lines[j]
        if not l.strip():
            continue
        if _yaml_indent(l) == 0:
            end = j
            break
    while end - 1 > data_idx and not lines[end - 1].strip():
        end -= 1
    return data_idx, item_ind, end


def _insert_configmap_key(text, name, value):
    """Append a key to the data: block. Never sorted-insert -- none of these files are sorted."""
    lines = text.split("\n")
    _data_idx, item_ind, at = _locate_configmap_data(text)
    return "\n".join(lines[:at] + [f"{' ' * item_ind}{name}: {_cm_scalar(value)}"] + lines[at:])


def _validate_yaml_edit(before: str, after: str, kind: str, expect_new: str):
    """Refuse to push anything that does not survive an actual parse.

    Six checks, all cheap, all of which have a real failure behind them:
      1. the edited text parses at all
      2. the ORIGINAL parsed too, so we are not blamed for pre-existing breakage
      3. exactly the expected key/name was added, nothing else moved
      4. no duplicate names (a duplicate env name is legal YAML and a silent misconfiguration)
      5. ConfigMap values are all strings (see _cm_scalar)
      6. the new name does not collide with a sed token the release substitutes
    """
    import yaml as _yaml
    problems = []
    try:
        _yaml.safe_load(before)
    except Exception as e:
        return [f"the file does not parse BEFORE the change ({e}); refusing to touch it"]
    try:
        doc = _yaml.safe_load(after)
    except Exception as e:
        return [f"the change would produce invalid YAML ({e})"]

    if kind == "configmap":
        data = (doc or {}).get("data") or {}
        if expect_new not in data:
            problems.append(f"{expect_new} is missing from the edited file")
        non_str = [k for k, v in data.items() if not isinstance(v, str)]
        if non_str:
            problems.append(f"these values are not text and would fail the apply: {non_str[:5]}")
    else:
        try:
            c = doc["spec"]["template"]["spec"]["containers"][0]
        except Exception:
            return ["the edited file is not a Deployment with a container"]
        names = [e.get("name") for e in (c.get("env") or [])]
        if expect_new not in names:
            problems.append(f"{expect_new} is missing from the edited file")
        dupes = sorted({n for n in names if names.count(n) > 1})
        if dupes:
            problems.append(f"duplicate settings in the same file: {dupes}")

    # The lower-environment stages sed these bare words through the whole file, unanchored and
    # global. A setting whose NAME contains one would be rewritten into something else at deploy.
    for tok in ("NAMESPACE", "REGISTRY", "REPOSITORY", "NODEPOOL_NAME", "TOLERATION_NAME", "TAG"):
        if tok in expect_new:
            problems.append(f"the name contains {tok}, which the release rewrites -- pick another name")
    return problems


def _git_create_ref(project, repo_id, branch, from_commit):
    url = f"{build_base(project)}/git/repositories/{repo_id}/refs?api-version=7.1"
    r = _post(url, [{"name": f"refs/heads/{branch}",
                     "oldObjectId": "0" * 40, "newObjectId": from_commit}])
    return r.json()


def _git_push(project, repo_id, branch, base_commit, comment, edits):
    """One commit, several file edits. `edits` is [(path, new_text)]."""
    url = f"{build_base(project)}/git/repositories/{repo_id}/pushes?api-version=7.1"
    body = {
        "refUpdates": [{"name": f"refs/heads/{branch}", "oldObjectId": base_commit}],
        "commits": [{
            "comment": comment,
            "changes": [{"changeType": "edit", "item": {"path": p},
                         "newContent": {"content": t, "contentType": "rawtext"}}
                        for p, t in edits],
        }],
    }
    r = _post(url, body)
    return r.json()


def _git_open_pr(project, repo_id, branch, title, description, target="master"):
    url = f"{build_base(project)}/git/repositories/{repo_id}/pullrequests?api-version=7.1"
    r = _post(url, {"sourceRefName": f"refs/heads/{branch}",
                    "targetRefName": f"refs/heads/{target}",
                    "title": title, "description": description})
    return r.json()


def _git_complete_pr(project, repo_id, pr_id, last_merge_source_commit, env_name):
    """Approve and complete a pull request. LOWER ENVIRONMENTS ONLY.

    The environment is re-checked here, at the point of the write, rather than trusted from the
    caller. This function is the single place in the portal that can put a change onto master
    without a person looking at it, so the gate lives with the capability.
    """
    env_up = (env_name or "").strip().upper()
    if env_up not in _GIT_AUTO_MERGE_ENVS:
        raise ValueError(f"refusing to auto-complete a pull request for {env_up}")
    base = f"{build_base(project)}/git/repositories/{repo_id}/pullrequests/{pr_id}"
    # The reviewer endpoint keys on the ADO IDENTITY id, which is NOT the same as the profile id
    # from vssps /profile/profiles/me. Voting as an id that is not a reviewer returns 200 and does
    # nothing at all -- no vote, no error -- so the PR then fails the "minimum 1 reviewer" policy
    # and sits open while the caller believes it merged. connectionData is the authoritative source.
    conn = _get(f"https://dev.azure.com/{ORG}/_apis/connectionData?api-version=7.1-preview")
    user_id = ((conn.get("authenticatedUser") or {}).get("id") or "").strip()
    if not user_id:
        raise ValueError("could not resolve the portal's own identity to approve with")
    r = _put(f"{base}/reviewers/{user_id}?api-version=7.1", {"vote": 10})
    if (r.json() or {}).get("vote") != 10:
        raise ValueError("the approval did not register")
    r = _patch(f"{base}?api-version=7.1", {
        "status": "completed",
        "lastMergeSourceCommit": {"commitId": last_merge_source_commit},
        "completionOptions": {"deleteSourceBranch": True, "mergeStrategy": "noFastForward"},
    })
    out = r.json() or {}
    # ADO answers 200 to a completion it has only QUEUED, and answers 200 to one it silently
    # declined on policy. Neither is a merge. Read the PR back and require it to actually be
    # completed before telling the caller the change has landed.
    for _ in range(10):
        cur = _get(f"{base}?api-version=7.1")
        if cur.get("status") == "completed":
            return cur
        if cur.get("status") == "abandoned":
            raise ValueError("the pull request was abandoned")
        time.sleep(1.5)
    raise ValueError(f"the pull request did not complete (status {out.get('status')!r}, "
                     f"mergeStatus {out.get('mergeStatus')!r}) -- it is raised and needs approving")


def _last_deployed_build(project, definition_id, stage_name):
    """The build artifact version of the most recent SUCCESSFUL deployment of this stage.

    Used to pin the image when running a workloads pipeline for a config-only change. Without this
    the release takes "latest", and a change that was only meant to add a setting silently moves the
    running application version as well -- because the deployment YAML's TAG token is substituted
    with whichever build the release happens to carry.
    """
    try:
        got = _get(f"{release_base(project)}/release/releases", params={
            "definitionId": definition_id, "$top": 25, "$expand": "environments",
            "api-version": API_VERSION,
        })
    except Exception:
        return None
    for rel in got.get("value", []):
        env = next((e for e in rel.get("environments", [])
                    if (e.get("name") or "").upper() == stage_name.upper()), None)
        if not env or env.get("status") != "succeeded":
            continue
        try:
            full = _get(f"{release_base(project)}/release/releases/{rel['id']}"
                        f"?api-version={API_VERSION}")
        except Exception:
            continue
        for a in full.get("artifacts", []):
            if a.get("type") == "Build":
                ver = (a.get("definitionReference") or {}).get("version") or {}
                if ver.get("id"):
                    return {"alias": a.get("alias"), "id": str(ver["id"]),
                            "name": ver.get("name"), "fromRelease": rel["id"]}
    return None


def _git_config_changes_path():
    # Sibling of RUNS_DIR, never inside it. RUNS_DIR is globbed as RUNS_DIR/*.json and every match
    # is parsed as a deployment run, so a bookkeeping file here is read back as a malformed row --
    # this one is a LIST, and the scanner calls .get() on it. Same reasoning as
    # HIDDEN_DEPLOYMENTS_FILE. /data is the PVC mount point, so a sibling still persists.
    return Path(RUNS_DIR).parent / "git_config_changes.json"


def _git_config_changes_load():
    p = _git_config_changes_path()
    if not p.is_file():
        return []
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return []


def _git_config_changes_add(entry):
    p = _git_config_changes_path()
    items = _git_config_changes_load()
    items.insert(0, entry)
    del items[60:]
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(items, indent=2), encoding="utf-8")


def _build_git_config_edit(target, name, value, services, optional):
    """Read, edit in memory, validate. Returns (edits, summary, problems).

    Shared by preview and apply so the two can never disagree about what would happen -- apply
    re-runs this from scratch against freshly read files rather than trusting anything the browser
    sent back.
    """
    project, repo, branch = target["project"], target["repoId"], target["branch"]
    cm_path = target["configMapPath"]
    edits, summary, problems, already = [], [], [], []

    cm_text, cm_sha = _git_read_file(project, repo, cm_path, branch)
    if cm_text is None:
        return [], [], [f"could not read {cm_path}"], []
    cm_data, _sorted = _parse_configmap(cm_text)
    # "Already there" is NOT an error. The two halves of this change live in different files and
    # get out of step all the time -- most often because the deployment files are shared across
    # DEV/SIT/UAT, so adding a setting for UAT leaves SIT reading a key its own settings file does
    # not have. Fixing exactly that means adding only the missing half, so each half is skipped
    # independently and only a completely empty change is refused.
    if name in cm_data:
        already.append(f"The settings file already has {name}.")
    else:
        try:
            new_cm = _insert_configmap_key(cm_text, name, value)
        except ValueError as e:
            return [], [], [str(e)], already
        problems += _validate_yaml_edit(cm_text, new_cm, "configmap", name)
        edits.append((cm_path, new_cm))
        summary.append({"path": cm_path, "role": "configmap", "service": None,
                        "added": 1, "objectId": cm_sha,
                        "line": f"{name}: {_cm_scalar(value)}"})

    by_service = dict(target["services"])
    for svc in services:
        filename = by_service.get(svc)
        if not filename:
            problems.append(f"{svc} is not a service of this pipeline")
            continue
        path = target["deploymentsDir"] + filename
        text, sha = _git_read_file(project, repo, path, branch)
        if text is None:
            problems.append(f"could not read {path}")
            continue
        existing = [e["name"] for e in _parse_deployment_env_refs(text)]
        if name in existing:
            already.append(f"{svc} already reads it.")
            continue
        try:
            new_text = _insert_env_entry(text, name, target["configMapName"], name, optional)
        except ValueError as e:
            problems.append(f"{svc}: {e}")
            continue
        problems += [f"{svc}: {p}" for p in _validate_yaml_edit(text, new_text, "deployment", name)]
        edits.append((path, new_text))
        summary.append({"path": path, "role": "deployment", "service": svc,
                        "added": 6 if optional else 5, "objectId": sha,
                        "line": f"- name: {name} -> {target['configMapName']}/{name}"})
    return edits, summary, problems, already


def _replace_configmap_value(text, name, value):
    """Change one existing key's value in a ConfigMap, touching only that line.

    Refuses block scalars. Several of these values are written as folded blocks:

        ALLOWED_CLIENT_HOSTS: >-
          host-one.example.com,
          host-two.example.com

    The value there is not on the key's line at all -- it is the indented lines beneath it. Replacing
    the key line would orphan those and change what the file means. Editing them safely means
    handling folding, wrapping and continuation, which is not worth building for a handful of host
    lists, so they are reported as not editable here and left to Azure DevOps.
    """
    lines = text.split("\n")
    _locate_configmap_data(text)  # refuse outright if there is no data: block
    hit = None
    for i, l in enumerate(lines):
        m = re.match(r"^(\s+)(" + re.escape(name) + r"):\s*(.*)$", l)
        if m:
            hit = (i, m.group(1), m.group(3).strip())
            break
    if hit is None:
        raise ValueError(f"{name} is not in this settings file")
    i, indent, current = hit
    if current in ("", ">-", ">", "|", "|-", ">+", "|+"):
        raise ValueError(
            f"{name} is written as a multi-line block in this file, which the portal does not "
            f"edit. Change it in Azure DevOps.")
    lines[i] = f"{indent}{name}: {_cm_scalar(value)}"
    return "\n".join(lines)


def _build_git_config_set_value(target, name, value):
    """Change an existing setting's value. Settings file only -- no deployment file is involved."""
    project, repo, branch = target["project"], target["repoId"], target["branch"]
    cm_path = target["configMapPath"]
    cm_text, cm_sha = _git_read_file(project, repo, cm_path, branch)
    if cm_text is None:
        return [], [], [f"could not read {cm_path}"], []
    cm_data, _sorted = _parse_configmap(cm_text)
    if name not in cm_data:
        return [], [], [f"{name} is not in the settings file for this environment."], []
    if cm_data[name] == str(value):
        return [], [], [f"{name} is already set to that."], []
    try:
        new_cm = _replace_configmap_value(cm_text, name, value)
    except ValueError as e:
        return [], [], [str(e)], []
    problems = _validate_yaml_edit(cm_text, new_cm, "configmap", name)
    return ([(cm_path, new_cm)],
            [{"path": cm_path, "role": "configmap", "service": None, "added": 0,
              "objectId": cm_sha, "line": f"{name}: {_cm_scalar(value)}"}],
            problems, [])


def _git_config_request(require_services=True):
    """Shared parsing and validation for the two write routes."""
    body = request.get_json(silent=True) or {}
    pipeline_in = (body.get("pipeline") or "").strip()
    env_name = (body.get("env") or "").strip().upper()
    name = (body.get("name") or "").strip()
    value = body.get("value")
    services = body.get("services") or []
    op = (body.get("op") or "add").strip()
    key = _PIPELINE_ALIAS_INDEX.get(_normalize_pipeline_name(pipeline_in))
    if not key:
        return None, (jsonify({"ok": False, "message": f"unknown pipeline {pipeline_in!r}"}), 400)
    target = _git_config_target(key, env_name)
    if not target:
        return None, (jsonify({"ok": False, "message":
                               "this pipeline does not keep its settings in Git"}), 400)
    if not name or not _VALID_SETTING_NAME.match(name):
        return None, (jsonify({"ok": False, "message":
                               "A name must start with a letter or underscore and contain only "
                               "letters, digits and underscores."}), 400)
    if value is None or str(value) == "":
        return None, (jsonify({"ok": False, "message": "A value is required."}), 400)
    if op not in ("add", "setValue"):
        return None, (jsonify({"ok": False, "message": f"unknown operation {op!r}"}), 400)
    # Changing an existing value touches the settings file only; no service list applies.
    if op == "setValue":
        require_services = False
    if require_services and not services:
        return None, (jsonify({"ok": False, "message":
                               "Choose at least one service that needs this setting. A setting "
                               "nothing reads has no effect."}), 400)
    return {"key": key, "env": env_name, "target": target, "name": name,
            "value": str(value), "services": services, "op": op,
            "optional": bool(body.get("optional", True))}, None


@app.route("/api/git-config/preview", methods=["POST"])
@require_role("admin")
def api_git_config_preview():
    """Exactly what apply would do, without doing any of it. Writes nothing, anywhere."""
    req, err = _git_config_request()
    if err:
        return err
    if req["op"] == "setValue":
        edits, summary, problems, already = _build_git_config_set_value(
            req["target"], req["name"], req["value"])
    else:
        edits, summary, problems, already = _build_git_config_edit(
            req["target"], req["name"], req["value"], req["services"], req["optional"])
    if not problems and not edits:
        problems = ["Nothing to do -- this setting is already in place for the services you chose."]
    return jsonify({
        "ok": bool(edits) and not problems,
        "problems": problems,
        "already": already,
        "files": summary,
        "willAutoMerge": req["env"] in _GIT_AUTO_MERGE_ENVS,
        "canDeploy": req["env"] in _GIT_DEPLOYABLE_ENVS,
        "sharedWithStages": req["target"]["sharedWithStages"],
        "applyPipelines": req["target"]["applyPipelines"],
    })


@app.route("/api/git-config/apply", methods=["POST"])
@require_role("admin")
def api_git_config_apply():
    """Branch, commit, open a pull request -- and on lower environments, complete it.

    Re-reads and re-validates from scratch. Nothing the browser sent about file contents is
    trusted; only the setting name, value and chosen services come from the request.
    """
    req, err = _git_config_request()
    if err:
        return err
    target, env_name = req["target"], req["env"]
    project, repo, branch_base = target["project"], target["repoId"], target["branch"]

    if req["op"] == "setValue":
        edits, summary, problems, already = _build_git_config_set_value(
            target, req["name"], req["value"])
    else:
        edits, summary, problems, already = _build_git_config_edit(
            target, req["name"], req["value"], req["services"], req["optional"])
    if problems:
        return jsonify({"ok": False, "problems": problems}), 400
    if not edits:
        return jsonify({"ok": False, "problems": [
            "Nothing to do -- this setting is already in place for the services you chose."]}), 400

    head = _git_branch_head(project, repo, branch_base)
    if not head:
        return jsonify({"ok": False, "problems": [f"could not read {branch_base}"]}), 502

    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    slug = req["name"].lower().replace("_", "-")
    branch = f"portal/config/{env_name.lower()}-{slug}-{stamp}"

    verb = "change" if req["op"] == "setValue" else "add"
    title = (f"{env_name}: change {req['name']}" if req["op"] == "setValue"
             else f"{env_name}: add {req['name']} to Saleor {', '.join(req['services'])}")
    body_lines = [
        (f"Changes the value of `{req['name']}` for {env_name}, raised from the Deployment "
         f"Portal." if req["op"] == "setValue"
         else f"Adds the setting `{req['name']}` for {env_name}, raised from the Deployment "
              f"Portal."),
        "",
        "Files changed:",
    ]
    for f in summary:
        body_lines.append(f"- `{f['path']}`" + (f" ({f['service']})" if f["service"] else ""))
    if req["op"] != "setValue":
        body_lines += ["", f"Services that will read it: {', '.join(req['services'])}."]
    else:
        body_lines += ["", "Only the settings file changes. No service wiring is affected, "
                           "and the new value reaches the services when the two pipelines "
                           "below are run."]
    if req["optional"] and req["op"] != "setValue":
        body_lines += [
            "",
            "The deployment entries are marked `optional: true` on purpose. The settings file and "
            "the deployment files ship as two separate pipelines with separate approvals, so "
            "without it a deployment that lands before the settings file would stop the pods from "
            "starting.",
        ]
    if target["sharedWithStages"] and req["op"] != "setValue":
        body_lines += [
            "",
            f"Note: these deployment files are shared with "
            f"{', '.join(target['sharedWithStages'])}. Those environments will also carry the new "
            f"entry on their next release, reading it from their own settings file.",
        ]
    # Values are never written into the commit message or the PR body. A pull request description
    # is public inside ADO permanently, and this is the same rule _record_env_change follows.
    description = "\n".join(body_lines)

    try:
        _git_create_ref(project, repo, branch, head)
        push = _git_push(project, repo, branch, head,
                         f"{env_name}: {verb} {req['name']} setting", edits)
        commit_id = push["refUpdates"][0]["newObjectId"]
        pr = _git_open_pr(project, repo, branch, title, description)
        pr_id = pr["pullRequestId"]
    except Exception as e:
        return jsonify({"ok": False, "problems": [f"could not create the change: {e}"]}), 502

    merged, merge_note = False, ""
    if env_name in _GIT_AUTO_MERGE_ENVS:
        try:
            _git_complete_pr(project, repo, pr_id, commit_id, env_name)
            merged = True
            merge_note = "Merged automatically. Lower environments do not wait for a reviewer."
        except Exception as e:
            merge_note = (f"Raised, but could not merge automatically ({e}). "
                          f"Approve it in Azure DevOps and it is ready to deploy.")
    else:
        merge_note = ("Production changes are not merged automatically. Someone has to approve "
                      "this pull request before it can be deployed.")

    entry = {
        "at": datetime.now(timezone.utc).isoformat(), "by": get_username(),
        "pipeline": req["key"], "env": env_name, "name": req["name"],
        "services": req["services"], "branch": branch, "commitId": commit_id,
        "pullRequestId": pr_id, "merged": merged,
        "url": f"https://dev.azure.com/{ORG}/{project}/_git/{target['repoName']}/pullrequest/{pr_id}",
        "files": [f["path"] for f in summary],
    }
    _git_config_changes_add(entry)
    _record_env_change({
        "at": entry["at"], "by": entry["by"], "pipeline": req["key"], "env": env_name,
        "git": True, "repo": target["repoName"], "branch": branch, "commitId": commit_id,
        "pullRequestId": pr_id,
        "changed": [{"name": req["name"], "source": "settings file"}],
    })
    return jsonify({"ok": True, **entry, "mergeNote": merge_note,
                    "canDeploy": merged and env_name in _GIT_DEPLOYABLE_ENVS,
                    "applyPipelines": target["applyPipelines"]})


@app.route("/api/git-config/deploy", methods=["POST"])
@require_role("admin")
def api_git_config_deploy():
    """Run one of the two apply pipelines for this environment. Lower environments only."""
    body = request.get_json(silent=True) or {}
    pipeline_in = (body.get("pipeline") or "").strip()
    env_name = (body.get("env") or "").strip().upper()
    purpose = (body.get("purpose") or "").strip()
    key = _PIPELINE_ALIAS_INDEX.get(_normalize_pipeline_name(pipeline_in))
    target = _git_config_target(key, env_name) if key else None
    if not target:
        return jsonify({"ok": False, "message": "unknown pipeline or environment"}), 400
    # Re-checked here rather than trusted from the UI. The portal never triggers production.
    if env_name not in _GIT_DEPLOYABLE_ENVS:
        return jsonify({"ok": False, "message":
                        f"The portal does not run production releases. Start "
                        f"{', '.join(p['name'] for p in target['applyPipelines'])} in Azure DevOps."}), 403
    step = next((p for p in target["applyPipelines"] if p["purpose"] == purpose), None)
    if not step:
        return jsonify({"ok": False, "message": f"unknown step {purpose!r}"}), 400

    project = target["project"]
    rbase = release_base(project)
    head = _git_branch_head(project, target["repoId"], target["branch"])

    artifacts = [{"alias": "_ecom", "instanceReference": {"id": head, "name": target["branch"]}}]
    pinned_note = "pinned to the current master commit"
    if step["purpose"] == "workloads":
        # A config-only change must not move the running application version. The deployment YAML
        # substitutes its TAG token with whatever build the release carries, so leaving the build
        # artifact on "latest" would ship a new image as a side effect of adding a setting.
        last = _last_deployed_build(project, step["definitionId"], step["stage"])
        if last:
            artifacts.append({"alias": last["alias"], "instanceReference": {"id": last["id"]}})
            pinned_note += f", image pinned to build {last.get('name') or last['id']}"
        else:
            return jsonify({"ok": False, "message":
                            "Could not work out which build is currently deployed, so this would "
                            "risk changing the running version. Start it from Azure DevOps and "
                            "pin the build yourself."}), 409

    try:
        r = _post(f"{rbase}/release/releases?api-version={API_VERSION}", {
            "definitionId": step["definitionId"],
            "description": f"Portal: apply {env_name} settings change",
            "artifacts": artifacts, "isDraft": False, "reason": "manual",
        })
        release = r.json()
        release_id = release["id"]
        env_obj = next((e for e in release.get("environments", [])
                        if (e.get("name") or "").upper() == step["stage"].upper()), None)
        if not env_obj:
            return jsonify({"ok": False, "message":
                            f"release {release_id} has no stage {step['stage']}"}), 502
        _patch(f"{rbase}/Release/releases/{release_id}/environments/{env_obj['id']}"
               f"?api-version={API_VERSION}",
               {"status": "inProgress", "comment": "Portal: settings change"})
    except Exception as e:
        return jsonify({"ok": False, "message": f"could not start the release: {e}"}), 502

    return jsonify({
        "ok": True, "releaseId": release_id, "name": release.get("name"),
        "step": step, "pinned": pinned_note,
        "url": (f"https://dev.azure.com/{ORG}/{project}/_releaseProgress"
                f"?releaseId={release_id}&_a=release-pipeline-progress"),
    })


@app.route("/api/git-config/changes")
@require_role("admin", "viewer")
def api_git_config_changes():
    """Settings changes the portal has made, newest first, with live pull-request state."""
    items = _git_config_changes_load()[:20]
    for it in items:
        if it.get("merged"):
            continue
        try:
            pr = _get(f"{build_base(it.get('project') or 'ECom')}/git/repositories/"
                      f"{ECOM_REPO_ID}/pullrequests/{it['pullRequestId']}?api-version=7.1")
            it["status"] = pr.get("status")
            it["merged"] = pr.get("status") == "completed"
        except Exception:
            it["status"] = "unknown"
    return jsonify({"ok": True, "items": items})


# ---------------------------------------------------------------------------------------------
# Production and beta deployments
#
# The portal's lower-environment flow is: paste a request, one pipeline runs, done. Production is
# not that. Each application is a SEQUENCE of two or three pipeline runs that must happen in a
# fixed order, each freezing its own copy of a settings file at the moment it is created. Nothing
# in Azure DevOps records that sequence -- there is no link from an application's tag pipeline to
# the pipeline that deploys it. So it is written out here, by hand, one application at a time.
#
# The line this section holds to, and the reason every route below is shaped the way it is:
#
#     Prepare and pin. Start on a separate, deliberate human action. Verify independently.
#     Never approve. Reject freely.
#
# VIEWERS SEE NONE OF THIS. Every /api/production/* route is admin-only -- reads included. The
# board names production applications, their pending approvals and their standing defects, which
# is not something a read-only account needs. The nav link and the route are hidden too, but the
# decorator is what actually enforces it.
#
# The portal may create a release with explicit pins, discard one it has not started, start one
# stage behind a typed confirmation, reject a pending approval, and read logs to prove a step did
# what it claimed. It may NOT approve anything, cancel a running production stage, run any az or
# kubectl command, or edit a pipeline definition. Those absences are the design, not an oversight.
# ---------------------------------------------------------------------------------------------

PROD_TIERS = ("PROD", "BETA")

# Steps the portal will never start, whatever the recipe says. Checked at the point of action as
# well as being rendered, so a stale client cannot talk the server into one.
_PROD_NEVER_START_KINDS = {"edit", "external", "manual"}


def _find_stage(release_or_def, stage_name):
    """A stage by name, case-insensitively and ignoring the _ vs - split.

    CD-Ecom-Tabby spells its stage PROD-TAG while every other definition spells it PROD_TAG. That
    single hyphen is enough to make an exact-match lookup silently return nothing, which reads as
    "this application has no production stage" rather than as a bug.
    """
    want = (stage_name or "").strip().upper().replace("-", "_")
    for e in (release_or_def or {}).get("environments", []) or []:
        if (e.get("name") or "").strip().upper().replace("-", "_") == want:
            return e
    return None


def _prod_recipe(app_key, tier):
    return PROD_RECIPES.get((app_key, (tier or "").strip().upper()))


def _prod_step(recipe, step_id):
    return next((s for s in recipe.get("steps", []) if s.get("stepId") == step_id), None)


def _prod_driver(recipe, commit=None):
    """The driver-file entry for this application, at a commit or at the branch head.

    Returns (entry, all_entries, error). The driver file is where "I deployed and nothing happened"
    comes from: an entry whose deploy flag is false is skipped in silence by the release, and an
    entry whose version already exists in the registry is refused by the pipeline's own guard.
    """
    path = recipe.get("driverFile")
    if not path:
        return None, [], None
    ref = commit or recipe.get("branch") or "master"
    try:
        text, _sha = _git_read_file(recipe["project"], recipe["repoId"], path, ref)
    except Exception as e:
        return None, [], f"could not read {path}: {e}"
    if text is None:
        return None, [], f"could not read {path}"
    try:
        entries = json.loads(text)
    except Exception as e:
        return None, [], f"{path} is not valid JSON: {e}"
    name = recipe.get("driverServiceName")
    entry = next((x for x in entries if x.get("name") == name), None)
    return entry, entries, None


def _chk(cid, title, status, detail, evidence=None, action=None):
    return {"id": cid, "title": title, "status": status, "detail": detail,
            "evidence": evidence, "action": action}


# --- preflight checks -------------------------------------------------------------------------
#
# Each returns a check dict, or None when it does not apply to this step. status is one of:
#   ok    -- verified fine
#   warn  -- worth knowing, does not stop the step
#   block -- the step will not be offered; running it would fail or do something unintended
#
# Every one of these exists because it has actually gone wrong here. The ones that would have
# caught a real incident say so in their docstring, so nobody later removes them as theoretical.

def _pf_driver_service_present(recipe, step, ctx):
    if not recipe.get("driverFile"):
        return None
    entry, entries, err = ctx["driver"]
    if err:
        return _chk("driver_service_present", "Settings file readable", "block", err)
    if entry is None:
        names = [x.get("name") for x in entries]
        return _chk("driver_service_present", "Listed in the settings file", "block",
                    f"{recipe['driverServiceName']} is not in {recipe['driverFile']}. "
                    f"The pipeline looks itself up by that exact name and stops if it is missing.",
                    evidence={"present": names})
    return _chk("driver_service_present", "Listed in the settings file", "ok",
                f"Found as {entry.get('name')}.")


def _pf_driver_flag_true(recipe, step, ctx):
    """Catches the silent no-op. checkout-app sat at deploy=false while a release was run for it;
    the pipeline printed "Skipping deployment" and reported success."""
    if step.get("kind") != "deploy" or not recipe.get("driverFile"):
        return None
    entry, _all, err = ctx["driver"]
    if err or entry is None:
        return None
    flag = str(entry.get("deploy", "")).strip().lower()
    if flag != "true":
        return _chk("driver_flag_true", "Set to actually deploy", "block",
                    f"{recipe['driverServiceName']} has deploy set to {entry.get('deploy')!r}, so "
                    f"this release would skip it and still report success. Nothing would change.",
                    evidence={"deploy": entry.get("deploy")},
                    action=f"Set deploy to true for {recipe['driverServiceName']} in "
                           f"{recipe['driverFile']}, then create the release again.")
    return _chk("driver_flag_true", "Set to actually deploy", "ok", "deploy is true.")


def _pf_driver_version(recipe, step, ctx):
    if not recipe.get("driverFile"):
        return None
    entry, _all, err = ctx["driver"]
    if err or entry is None:
        return None
    v = entry.get("version")
    if not v or str(v).lower() == "null":
        return _chk("driver_version_resolves", "Version is set", "block",
                    "The settings file has no version for this application, and the pipeline "
                    "stops when it reads an empty version.")
    return _chk("driver_version_resolves", "Version is set", "ok", f"version is {v}.",
                evidence={"version": v})


def _pf_others_also_deploy(recipe, step, ctx):
    """One release of Production-Release-Saleor-Apps deploys EVERY entry flagged true, not just the
    one you came for. Worth saying out loud before someone restarts four other services."""
    if step.get("kind") != "deploy" or not recipe.get("driverFile"):
        return None
    entry, entries, err = ctx["driver"]
    if err:
        return None
    others = [x.get("name") for x in entries
              if str(x.get("deploy", "")).strip().lower() == "true"
              and x.get("name") != recipe.get("driverServiceName")]
    if others:
        return _chk("others_also_deploy", "Other applications in the same release", "warn",
                    f"This release also deploys {', '.join(others)}, because they are flagged to "
                    f"deploy in the same settings file. Their pods will restart too.",
                    evidence={"others": others})
    return _chk("others_also_deploy", "Other applications in the same release", "ok",
                "Nothing else is flagged to deploy.")


def _pf_pinned_commit_current(recipe, step, ctx):
    """The snapshot trap, and the most expensive one here. A release freezes the settings file at
    the moment it is CREATED. Editing the file afterwards never reaches it -- proven three times
    this week, including a release whose retry ran four minutes after the fix and still failed."""
    head = ctx.get("head")
    pinned = ctx.get("pinnedCommit")
    if not head or not pinned:
        return None
    if pinned[:12] != head[:12]:
        return _chk("pinned_commit_current", "Reading the current settings", "block",
                    f"This release froze the settings at commit {pinned[:8]}, but the branch is now "
                    f"at {head[:8]}. It cannot see anything changed since it was created. "
                    f"Retrying will read the old file again.",
                    evidence={"pinned": pinned, "head": head},
                    action="Create a new release. An existing one can never pick up a later edit.")
    return _chk("pinned_commit_current", "Reading the current settings", "ok",
                f"Pinned to {pinned[:8]}, which is the current branch head.")


def _pf_manual_gate_present(recipe, step, ctx):
    """The portal must never be the only thing between a click and production. If a stage turns out
    to have no human approval, a prepared release is abandoned rather than left startable."""
    if step.get("kind") in _PROD_NEVER_START_KINDS:
        return None
    ap = step.get("approval") or {}
    if not ap.get("manual"):
        return _chk("manual_gate_present", "A person has to approve it", "block",
                    "This stage has no manual approval, so starting it would deploy with nobody "
                    "signing off. The portal will not start a production stage on its own.",
                    action="Add a pre-deployment approval to this stage in Azure DevOps.")
    return _chk("manual_gate_present", "A person has to approve it", "ok",
                f"Approver: {ap.get('approver') or 'configured in Azure DevOps'}.")


def _pf_approval_window(recipe, step, ctx):
    """Three releases have been auto-rejected by a 1-minute window this week. Not fixable from
    here -- it is a definition setting -- but it is entirely fixable by being ready for it."""
    ap = step.get("approval") or {}
    if not ap.get("manual"):
        return None
    mins = ap.get("timeoutMinutes")
    if mins is None:
        return None
    if mins == 0:
        return _chk("approval_window", "How long you get to approve", "ok", "No timeout.")
    if mins <= 2:
        return _chk("approval_window", "How long you get to approve", "warn",
                    f"Only {mins} minute(s). If nobody clicks in time Azure DevOps rejects it "
                    f"automatically and the attempt is wasted. Have the approver ready BEFORE "
                    f"starting this step.",
                    evidence={"timeoutMinutes": mins})
    return _chk("approval_window", "How long you get to approve", "ok", f"{mins} minutes.")


def _pf_definition_revision(recipe, step, ctx):
    """A release also freezes the DEFINITION revision. A pipeline fixed after the release was made
    still runs the old version, including on retries."""
    cur = ctx.get("definitionRevision")
    pinned = ctx.get("pinnedDefinitionRevision")
    if cur is None or pinned is None:
        return None
    if cur != pinned:
        return _chk("definition_revision_current", "Running the current pipeline", "warn",
                    f"This release is pinned to pipeline revision {pinned}, but the pipeline is now "
                    f"at revision {cur}. Any change made to it since will not apply here, retries "
                    f"included.",
                    evidence={"pinned": pinned, "current": cur},
                    action="If the pipeline was fixed after this release was created, make a new one.")
    return _chk("definition_revision_current", "Running the current pipeline", "ok",
                f"Revision {cur}.")


def _pf_duplicate_tag_guard(recipe, step, ctx):
    """Four of the five saleor-app pipelines refuse to rebuild over an existing tag. Checkout is the
    one where those lines are commented out, and it is the one that overwrote a live production
    image. Surface which behaviour applies before the step runs, not after."""
    if step.get("kind") != "tag":
        return None
    guard = step.get("duplicateTagGuard")
    if guard is None:
        return None
    entry, _all, err = ctx["driver"]
    version = (entry or {}).get("version") if not err else None
    if guard:
        return _chk("duplicate_tag_guard", "Will not overwrite an existing image", "ok",
                    f"This pipeline stops if {recipe.get('imageRepo')}:{version} already exists, so "
                    f"it cannot overwrite a live image. Bump the version in the settings file if it "
                    f"does.", evidence={"version": version})
    return _chk("duplicate_tag_guard", "Will not overwrite an existing image", "warn",
                f"This pipeline duplicate-tag check is disabled, so it WILL overwrite "
                f"{recipe.get('imageRepo')}:{version} if that tag already exists. That is how a live "
                f"production image was replaced in place on 25 August.",
                evidence={"version": version},
                action="Confirm the version is new before starting this step.")


def _pf_blocked_step(recipe, step, ctx):
    if step.get("portalMayStart") is False:
        return _chk("blocked_step", "The portal will not run this one", "block",
                    step.get("blockedReason") or "This step has to be done outside the portal.",
                    action=step.get("blockedAction"))
    if step.get("kind") in _PROD_NEVER_START_KINDS:
        return _chk("blocked_step", "Done by a person, not the portal", "warn",
                    {"edit": "This is a change committed to the repository.",
                     "external": "This happens outside the cluster.",
                     "manual": "This is a manual action."}[step["kind"]])
    return None


def _pf_predecessor_verified(recipe, step, ctx):
    """Order is invisible in Azure DevOps and the two pipelines do not know about each other.
    Running the deploy before the tag re-applies the image that is already there, restarts every
    pod for nothing, and reports success."""
    prev = ctx.get("previousStep")
    if not prev:
        return None
    if prev.get("state") != "verified":
        return _chk("predecessor_verified", "The step before this one is done", "block",
                    f"Step {prev.get('order')} has not been confirmed as finished. Running this one "
                    f"first would apply whatever is already there and still look successful.",
                    action=f"Complete step {prev.get('order')} first.")
    return _chk("predecessor_verified", "The step before this one is done", "ok",
                f"Step {prev.get('order')} finished and was verified.")


_PROD_CHECKS = [
    _pf_blocked_step, _pf_driver_service_present, _pf_driver_flag_true, _pf_driver_version,
    _pf_others_also_deploy, _pf_pinned_commit_current, _pf_definition_revision,
    _pf_manual_gate_present, _pf_approval_window, _pf_duplicate_tag_guard,
    _pf_predecessor_verified,
]


def _prod_context(recipe, step, extra=None):
    ctx = {"driver": _prod_driver(recipe)}
    try:
        ctx["head"] = _git_branch_head(recipe["project"], recipe["repoId"],
                                       recipe.get("branch") or "master")
    except Exception:
        ctx["head"] = None
    if step.get("definitionId"):
        try:
            d = _get(f"{release_base(recipe['project'])}/release/definitions/"
                     f"{step['definitionId']}?api-version={API_VERSION}")
            ctx["definitionRevision"] = d.get("revision")
            ctx["definitionStageExists"] = _find_stage(d, step.get("stage")) is not None
        except Exception:
            pass
    ctx.update(extra or {})
    return ctx


def _prod_preflight(recipe, step, extra=None):
    ctx = _prod_context(recipe, step, extra)
    out = []
    for fn in _PROD_CHECKS:
        try:
            c = fn(recipe, step, ctx)
        except Exception as e:
            c = _chk(fn.__name__, fn.__name__, "warn", f"check could not run: {e}")
        if c:
            out.append(c)
    worst = "block" if any(c["status"] == "block" for c in out) else (
            "warn" if any(c["status"] == "warn" for c in out) else "ok")
    return {"checks": out, "worst": worst,
            "canPrepare": worst != "block" and step.get("kind") not in _PROD_NEVER_START_KINDS
                          and step.get("portalMayStart") is not False}


def _get_text(url, params=None):
    """Fetch a release task log as text. Separate from _get because logs are not JSON and the
    JSON validation in _get would reject them outright."""
    def attempt():
        try:
            r = _SESSION.get(url, headers=HEADERS,
                             params={**(params or {}), "api-version": API_VERSION}, timeout=30)
        except (requests.ConnectionError, requests.Timeout) as e:
            raise _Transient(str(e))
        _check_transient(r, url)
        return r.text if r.status_code < 400 else ""
    return _retry(attempt)


@app.route("/api/production/apps")
@require_role("admin")
def api_production_apps():
    """The board. One card per application per tier, with what is live and what is pending."""
    cards = []
    for (app_key, tier), recipe in sorted(PROD_RECIPES.items()):
        entry, _all, err = _prod_driver(recipe)
        problems = []
        if err:
            problems.append(err)
        elif entry is None:
            problems.append(f"not listed in {recipe['driverFile']}")
        elif str(entry.get("deploy", "")).strip().lower() != "true":
            problems.append("a deploy would skip this application, because deploy is not true")
        cards.append({
            "appKey": app_key, "tier": tier,
            "displayName": recipe.get("displayName"),
            "cluster": recipe.get("cluster"), "namespaces": recipe.get("namespaces"),
            "imageRepo": recipe.get("imageRepo"), "runningTag": recipe.get("runningTag"),
            "tagMutable": recipe.get("tagMutable"),
            "driverFile": recipe.get("driverFile"),
            "version": (entry or {}).get("version"),
            "deployFlag": (entry or {}).get("deploy"),
            "stepCount": len(recipe.get("steps", [])),
            "knownProblems": recipe.get("knownProblems", []),
            "problems": problems,
            "confidence": recipe.get("confidence", {}),
        })
    return jsonify({"ok": True, "apps": cards, "tiers": list(PROD_TIERS)})


@app.route("/api/production/apps/<app_key>/<tier>")
@require_role("admin")
def api_production_app(app_key, tier):
    """One application: the ordered sequence, with every check resolved against live state."""
    recipe = _prod_recipe(app_key, tier)
    if not recipe:
        return jsonify({"ok": False, "message": f"no recipe for {app_key} {tier}"}), 404
    entry, entries, err = _prod_driver(recipe)
    steps = []
    for s in sorted(recipe.get("steps", []), key=lambda x: x.get("order", 0)):
        pf = _prod_preflight(recipe, s)
        steps.append({
            "stepId": s.get("stepId"), "order": s.get("order"), "kind": s.get("kind"),
            "title": s.get("title"), "plain": s.get("plain"),
            "definitionId": s.get("definitionId"), "definitionName": s.get("definitionName"),
            "stage": s.get("stage"), "approval": s.get("approval"),
            "pins": s.get("pins"), "writes": s.get("writes"),
            "portalMayStart": bool(s.get("portalMayStart", True))
                              and s.get("kind") not in _PROD_NEVER_START_KINDS,
            "blockedReason": s.get("blockedReason"),
            "adoUrl": (f"https://dev.azure.com/{ORG}/{recipe['project']}/_release"
                       f"?definitionId={s['definitionId']}" if s.get("definitionId") else None),
            **pf,
        })
    return jsonify({
        "ok": True, "recipe": {k: v for k, v in recipe.items() if k != "steps"},
        "driver": {"file": recipe.get("driverFile"), "entry": entry,
                   "allEntries": entries, "error": err},
        "steps": steps,
    })


@app.route("/api/production/not-run")
@require_role("admin")
def api_production_not_run():
    """Everything the portal deliberately will not run, and why. Stated rather than merely absent:
    a missing button is indistinguishable from a bug."""
    reasons = {"edit": "A change committed to the repository by a person.",
               "external": "Runs outside the cluster.",
               "manual": "A manual action outside every pipeline."}
    out = []
    for (app_key, tier), recipe in sorted(PROD_RECIPES.items()):
        for s in recipe.get("steps", []):
            if s.get("portalMayStart") is False or s.get("kind") in _PROD_NEVER_START_KINDS:
                out.append({"appKey": app_key, "tier": tier,
                            "displayName": recipe.get("displayName"),
                            "stepId": s.get("stepId"), "title": s.get("title"),
                            "kind": s.get("kind"),
                            "reason": s.get("blockedReason")
                                      or reasons.get(s.get("kind"), "Not runnable from the portal."),
                            "action": s.get("blockedAction")})
    return jsonify({"ok": True, "items": out,
                    "never": ["approve any production or beta approval",
                              "cancel a running production stage",
                              "run any az or kubectl command",
                              "change a pipeline definition"]})


# --- plans: prepare, start, verify -------------------------------------------------------------
#
# A plan is one run of one application's sequence. It exists so the ORDER can be enforced and so
# each step can be proved finished before the next unlocks -- neither of which Azure DevOps does,
# because the pipelines in a sequence do not know about each other.
#
# What a plan may do, and the reason each line is here rather than the obvious alternative:
#
#   prepare  create a release with EXPLICIT pins. Not "latest": a production deployment left on
#            latest silently moves the running application version as a side effect of a config
#            change, because the deployment YAML substitutes its tag token with whatever build the
#            release happens to carry.
#   discard  abandon a prepared release that has not started. Cheap to undo, so always offered.
#   start    set one stage in progress, behind a token the GET issued, after re-running every
#            check. A stale browser cannot start anything.
#   reject   turn down a pending approval. Refusing is always safe; approving never is.
#   verify   read the stage's own logs and prove it did what the recipe said it would.
#
# There is deliberately NO approve route and NO cancel route. Approving is the one action that
# must stay with a person, and cancelling a running production stage can leave a partial rollout
# that is worse than letting it finish.

_PROD_PLAN_STATES = ("pending", "prepared", "started", "verified", "acknowledged", "failed")

# start tokens are HMACed over the exact state the checks ran against, so a token cannot be
# replayed after the world has moved underneath it.
_PROD_TOKEN_TTL_SECONDS = 600


def _prod_plans_path():
    # Sibling of RUNS_DIR for the same reason as _git_config_changes_path -- see the note there.
    return Path(RUNS_DIR).parent / "production_plans.json"


def _prod_plans_load():
    p = _prod_plans_path()
    if not p.is_file():
        return []
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return []


def _prod_plans_save(plans):
    p = _prod_plans_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(plans[:200], indent=2), encoding="utf-8")


def _prod_plan_get(plan_id):
    return next((x for x in _prod_plans_load() if x.get("planId") == plan_id), None)


def _prod_plan_put(plan):
    plans = _prod_plans_load()
    for i, x in enumerate(plans):
        if x.get("planId") == plan["planId"]:
            plans[i] = plan
            break
    else:
        plans.insert(0, plan)
    _prod_plans_save(plans)


def _prod_secret_key():
    # Reuses the session secret. Tokens only need to be unforgeable within one portal lifetime;
    # a restart invalidating outstanding tokens is correct, not a limitation -- the checks they
    # attest to were run against state that restart cannot vouch for either.
    return (app.secret_key if isinstance(app.secret_key, bytes)
            else str(app.secret_key).encode("utf-8"))


def _prod_start_token(plan_id, step_id, release_id, checks_fingerprint):
    issued = int(time.time())
    body = f"{plan_id}|{step_id}|{release_id}|{checks_fingerprint}|{issued}"
    sig = hmac.new(_prod_secret_key(), body.encode("utf-8"), hashlib.sha256).hexdigest()[:32]
    return f"{issued}.{sig}"


def _prod_token_valid(token, plan_id, step_id, release_id, checks_fingerprint):
    try:
        issued_s, sig = str(token).split(".", 1)
        issued = int(issued_s)
    except Exception:
        return False, "malformed confirmation"
    if time.time() - issued > _PROD_TOKEN_TTL_SECONDS:
        return False, "the checks are more than ten minutes old -- open the step again"
    body = f"{plan_id}|{step_id}|{release_id}|{checks_fingerprint}|{issued}"
    want = hmac.new(_prod_secret_key(), body.encode("utf-8"), hashlib.sha256).hexdigest()[:32]
    if not hmac.compare_digest(sig, want):
        return False, "something changed since the checks ran -- open the step again"
    return True, ""


def _prod_fingerprint(checks):
    """Identity of a check RESULT set. If any check changed verdict, the token stops matching."""
    raw = "|".join(f"{c['id']}={c['status']}" for c in sorted(checks, key=lambda x: x["id"]))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def _prod_plan_steps(recipe, plan):
    """Recipe steps merged with this plan's progress, in order, with the ordering interlock applied."""
    out, prev = [], None
    for s in sorted(recipe.get("steps", []), key=lambda x: x.get("order", 0)):
        st = (plan.get("steps") or {}).get(s["stepId"]) or {"state": "pending"}
        pf = _prod_preflight(recipe, s, {
            "previousStep": prev,
            "pinnedCommit": (st.get("pins") or {}).get("gitCommit"),
            "pinnedDefinitionRevision": st.get("definitionRevision"),
        })
        row = {**s, **pf, "progress": st}
        out.append(row)
        prev = {"order": s.get("order"), "title": s.get("title"), "state": st.get("state")}
    return out


def _prod_require_admin_step(plan_id, step_id):
    """(plan, recipe, step, error_response). Every mutating route starts here."""
    plan = _prod_plan_get(plan_id)
    if not plan:
        return None, None, None, (jsonify({"ok": False, "message": "no such plan"}), 404)
    recipe = _prod_recipe(plan["appKey"], plan["tier"])
    if not recipe:
        return None, None, None, (jsonify({"ok": False, "message": "no recipe for this plan"}), 404)
    step = _prod_step(recipe, step_id)
    if not step:
        return None, None, None, (jsonify({"ok": False, "message": "no such step"}), 404)
    # Re-checked here and not merely rendered: a step the portal must not run is refused at the
    # point of action, so a stale or hand-made request cannot reach it.
    if step.get("portalMayStart") is False or step.get("kind") in _PROD_NEVER_START_KINDS:
        return None, None, None, (jsonify({
            "ok": False,
            "message": step.get("blockedReason")
                       or "This step is not something the portal runs."}), 403)
    return plan, recipe, step, None


@app.route("/api/production/apps/<app_key>/<tier>/builds")
@require_role("admin")
def api_production_builds(app_key, tier):
    """Candidate builds to pin, each with its source branch so the branch can be judged BEFORE
    choosing. Picking the wrong branch is the single easiest way to ship the wrong code here."""
    recipe = _prod_recipe(app_key, tier)
    if not recipe:
        return jsonify({"ok": False, "message": "no recipe"}), 404
    step_id = request.args.get("stepId") or ""
    step = _prod_step(recipe, step_id)
    if not step:
        return jsonify({"ok": False, "message": "unknown step"}), 400
    alias = next((p["alias"] for p in (step.get("pins") or []) if p.get("type") == "Build"), None)
    if not alias:
        return jsonify({"ok": True, "builds": [], "message": "this step pins no build"})
    try:
        d = _get(f"{release_base(recipe['project'])}/release/definitions/"
                 f"{step['definitionId']}?api-version={API_VERSION}")
        art = next((a for a in d.get("artifacts", []) if a.get("alias") == alias), None)
        def_id = ((art or {}).get("definitionReference") or {}).get("definition", {}).get("id")
        if not def_id:
            return jsonify({"ok": True, "builds": [], "message": f"could not resolve {alias}"})
        got = _get(f"{build_base(recipe['project'])}/build/builds",
                   params={"definitions": def_id, "$top": 25, "api-version": API_VERSION})
    except Exception as e:
        return jsonify({"ok": False, "message": f"could not list builds: {e}"}), 502
    builds = [{
        "id": b.get("id"), "buildNumber": b.get("buildNumber"),
        "branch": (b.get("sourceBranch") or "").replace("refs/heads/", ""),
        "commit": (b.get("sourceVersion") or "")[:10],
        "result": b.get("result"), "finishTime": b.get("finishTime"),
        "requestedFor": (b.get("requestedFor") or {}).get("displayName"),
    } for b in got.get("value", []) if b.get("result") == "succeeded"]
    return jsonify({"ok": True, "alias": alias, "builds": builds})


@app.route("/api/production/plans", methods=["POST"])
@require_role("admin")
def api_production_plan_create():
    """Create a plan. Records who and why. Touches nothing in Azure DevOps."""
    body = request.get_json(silent=True) or {}
    app_key, tier = (body.get("appKey") or "").strip(), (body.get("tier") or "").strip().upper()
    recipe = _prod_recipe(app_key, tier)
    if not recipe:
        return jsonify({"ok": False, "message": f"no recipe for {app_key} {tier}"}), 404
    reason = (body.get("reason") or "").strip()
    if len(reason) < 8:
        return jsonify({"ok": False, "message":
                        "Say what this deployment is for, in a few words. It goes in the release "
                        "description and is the only record of why production changed."}), 400
    entry, _all, _err = _prod_driver(recipe)
    plan = {
        "planId": secrets.token_hex(6), "appKey": app_key, "tier": tier,
        "displayName": recipe.get("displayName"),
        "createdBy": get_username(), "createdAt": datetime.now(timezone.utc).isoformat(),
        "reason": reason,
        # The "before" snapshot, so afterwards it is possible to say what actually changed rather
        # than what was intended to change.
        "before": {"driverEntry": entry,
                   "head": _git_branch_head(recipe["project"], recipe["repoId"],
                                            recipe.get("branch") or "master")},
        "steps": {},
    }
    _prod_plan_put(plan)
    return jsonify({"ok": True, "planId": plan["planId"], "plan": plan})


@app.route("/api/production/plans")
@require_role("admin")
def api_production_plans():
    return jsonify({"ok": True, "plans": _prod_plans_load()[:40]})


@app.route("/api/production/plans/<plan_id>")
@require_role("admin")
def api_production_plan(plan_id):
    plan = _prod_plan_get(plan_id)
    if not plan:
        return jsonify({"ok": False, "message": "no such plan"}), 404
    recipe = _prod_recipe(plan["appKey"], plan["tier"])
    if not recipe:
        return jsonify({"ok": False, "message": "no recipe for this plan"}), 404
    steps = _prod_plan_steps(recipe, plan)
    # A start token is issued only for a step that is prepared AND currently passes every check.
    for row in steps:
        prog = row["progress"]
        if prog.get("state") == "prepared" and row["worst"] != "block" and prog.get("releaseId"):
            row["startToken"] = _prod_start_token(plan_id, row["stepId"], prog["releaseId"],
                                                  _prod_fingerprint(row["checks"]))
    return jsonify({"ok": True, "plan": plan, "steps": steps,
                    "recipe": {k: v for k, v in recipe.items() if k != "steps"}})


@app.route("/api/production/plans/<plan_id>/steps/<step_id>/prepare", methods=["POST"])
@require_role("admin")
def api_production_prepare(plan_id, step_id):
    """Create the release with explicit pins. Does NOT start it.

    If the created release turns out to have no human approval on the target stage, it is abandoned
    here rather than left sitting startable -- the portal will not be the only thing between a click
    and production.
    """
    plan, recipe, step, err = _prod_require_admin_step(plan_id, step_id)
    if err:
        return err
    body = request.get_json(silent=True) or {}

    pf = _prod_preflight(recipe, step, {"previousStep": _prod_prev_progress(recipe, plan, step)})
    if pf["worst"] == "block":
        return jsonify({"ok": False, "message": "The checks say this cannot run yet.",
                        "checks": pf["checks"]}), 409

    rbase = release_base(recipe["project"])
    artifacts, pins = [], {}
    for p in (step.get("pins") or []):
        if p.get("type") == "Build":
            bid = body.get("buildId")
            if not bid:
                return jsonify({"ok": False, "message":
                                f"Choose which build to deploy ({p['alias']})."}), 400
            artifacts.append({"alias": p["alias"], "instanceReference": {"id": str(bid)}})
            pins["buildId"] = str(bid)
        elif p.get("type") == "Git":
            head = _git_branch_head(recipe["project"], recipe["repoId"],
                                    p.get("branch") or recipe.get("branch") or "master")
            if not head:
                return jsonify({"ok": False, "message":
                                f"could not resolve {p['alias']}"}), 502
            artifacts.append({"alias": p["alias"],
                              "instanceReference": {"id": head, "name": p.get("branch") or "master"}})
            pins["gitCommit"] = head
    try:
        r = _post(f"{rbase}/release/releases?api-version={API_VERSION}", {
            "definitionId": step["definitionId"],
            "description": f"Portal plan {plan_id}: {plan.get('reason')}",
            "artifacts": artifacts, "isDraft": False, "reason": "manual",
        })
        release = r.json()
    except Exception as e:
        return jsonify({"ok": False, "message": f"could not create the release: {e}"}), 502

    env = _find_stage(release, step.get("stage"))
    if not env:
        return jsonify({"ok": False, "message":
                        f"release {release.get('id')} has no stage {step.get('stage')}"}), 502

    gate = _snapshot_has_manual_gate(env)
    if gate is False:
        # Abandon rather than leave a startable production release with no human in the loop.
        try:
            _patch(f"{rbase}/release/releases/{release['id']}?api-version={API_VERSION}",
                   {"status": "abandoned"})
        except Exception:
            pass
        return jsonify({"ok": False, "message":
                        "That stage has no approval configured, so starting it would deploy with "
                        "nobody signing off. The release just created has been abandoned."}), 409

    prog = {"state": "prepared", "releaseId": release.get("id"), "releaseName": release.get("name"),
            "stageId": env.get("id"), "pins": pins,
            "definitionRevision": release.get("releaseDefinitionRevision"),
            "preparedAt": datetime.now(timezone.utc).isoformat(), "preparedBy": get_username(),
            "url": (f"https://dev.azure.com/{ORG}/{recipe['project']}/_releaseProgress"
                    f"?releaseId={release.get('id')}&_a=release-pipeline-progress")}
    plan.setdefault("steps", {})[step_id] = prog
    _prod_plan_put(plan)
    return jsonify({"ok": True, "progress": prog,
                    "note": "Created and pinned. Nothing has started."})


def _prod_prev_progress(recipe, plan, step):
    ordered = sorted(recipe.get("steps", []), key=lambda x: x.get("order", 0))
    idx = next((i for i, s in enumerate(ordered) if s["stepId"] == step["stepId"]), 0)
    if idx == 0:
        return None
    prev = ordered[idx - 1]
    st = (plan.get("steps") or {}).get(prev["stepId"]) or {"state": "pending"}
    return {"order": prev.get("order"), "title": prev.get("title"), "state": st.get("state")}


@app.route("/api/production/plans/<plan_id>/steps/<step_id>/discard", methods=["POST"])
@require_role("admin")
def api_production_discard(plan_id, step_id):
    """Abandon a prepared release that has not started."""
    plan, recipe, step, err = _prod_require_admin_step(plan_id, step_id)
    if err:
        return err
    prog = (plan.get("steps") or {}).get(step_id) or {}
    if prog.get("state") != "prepared":
        return jsonify({"ok": False, "message":
                        f"nothing to discard -- this step is {prog.get('state', 'pending')}"}), 409
    try:
        _patch(f"{release_base(recipe['project'])}/release/releases/"
               f"{prog['releaseId']}?api-version={API_VERSION}", {"status": "abandoned"})
    except Exception as e:
        return jsonify({"ok": False, "message": f"could not abandon it: {e}"}), 502
    plan["steps"][step_id] = {"state": "pending",
                              "discardedAt": datetime.now(timezone.utc).isoformat(),
                              "discardedBy": get_username(),
                              "discardedReleaseId": prog.get("releaseId")}
    _prod_plan_put(plan)
    return jsonify({"ok": True, "message": f"Release {prog.get('releaseName')} abandoned."})


@app.route("/api/production/plans/<plan_id>/steps/<step_id>/start", methods=["POST"])
@require_role("admin")
def api_production_start(plan_id, step_id):
    """Set the stage in progress. Requires the token the GET issued, and re-runs every check.

    This does NOT approve. The stage goes to whoever the approver group is and waits there. If the
    approval window is short, that wait is where a deployment is usually lost -- which is why the
    response says so rather than reporting success and moving on.
    """
    plan, recipe, step, err = _prod_require_admin_step(plan_id, step_id)
    if err:
        return err
    body = request.get_json(silent=True) or {}
    prog = (plan.get("steps") or {}).get(step_id) or {}
    if prog.get("state") != "prepared":
        return jsonify({"ok": False, "message":
                        "Prepare this step first. Nothing can be started that was not pinned."}), 409

    pf = _prod_preflight(recipe, step, {
        "previousStep": _prod_prev_progress(recipe, plan, step),
        "pinnedCommit": (prog.get("pins") or {}).get("gitCommit"),
        "pinnedDefinitionRevision": prog.get("definitionRevision"),
    })
    if pf["worst"] == "block":
        return jsonify({"ok": False, "message": "The checks changed since you opened this step.",
                        "checks": pf["checks"]}), 409

    ok, why = _prod_token_valid(body.get("confirm"), plan_id, step_id, prog.get("releaseId"),
                                _prod_fingerprint(pf["checks"]))
    if not ok:
        return jsonify({"ok": False, "message": why, "checks": pf["checks"]}), 409

    try:
        r = _patch(f"{release_base(recipe['project'])}/Release/releases/{prog['releaseId']}"
                   f"/environments/{prog['stageId']}?api-version={API_VERSION}",
                   {"status": "inProgress",
                    "comment": f"Portal plan {plan_id}: {plan.get('reason')}"})
        if r.status_code >= 400 and "InProgress" not in r.text:
            return jsonify({"ok": False,
                            "message": f"could not start it: HTTP {r.status_code}"}), 502
    except Exception as e:
        return jsonify({"ok": False, "message": f"could not start it: {e}"}), 502

    prog.update({"state": "started", "startedAt": datetime.now(timezone.utc).isoformat(),
                 "startedBy": get_username()})
    plan["steps"][step_id] = prog
    _prod_plan_put(plan)
    ap = step.get("approval") or {}
    note = "Started. It is now waiting for approval in Azure DevOps -- the portal does not approve."
    if ap.get("timeoutMinutes") and ap["timeoutMinutes"] <= 2:
        note += (f" The window is only {ap['timeoutMinutes']} minute(s); if nobody clicks in time "
                 f"it is rejected automatically and you will need a new release.")
    return jsonify({"ok": True, "progress": prog, "note": note})


@app.route("/api/production/plans/<plan_id>/steps/<step_id>/reject", methods=["POST"])
@require_role("admin")
def api_production_reject(plan_id, step_id):
    """Reject a pending approval. Deliberately available where approve is not: turning a production
    deployment down is always safe, and there is no equivalent way to stop one otherwise."""
    plan, recipe, step, err = _prod_require_admin_step(plan_id, step_id)
    if err:
        return err
    prog = (plan.get("steps") or {}).get(step_id) or {}
    if not prog.get("releaseId"):
        return jsonify({"ok": False, "message": "nothing to reject"}), 409
    rbase = release_base(recipe["project"])
    try:
        pending = _get(f"{rbase}/release/approvals",
                       params={"releaseIdsFilter": prog["releaseId"], "statusFilter": "pending",
                               "api-version": API_VERSION})
        match = next((a for a in pending.get("value", [])
                      if (a.get("releaseEnvironment") or {}).get("id") == prog.get("stageId")), None)
        if not match:
            return jsonify({"ok": False, "message": "there is no approval waiting on this step"}), 409
        _patch(f"{rbase}/release/approvals/{match['id']}?api-version={API_VERSION}",
               {"status": "rejected",
                "comments": (request.get_json(silent=True) or {}).get("reason")
                            or "Rejected via Magrabi Deployment Portal"})
    except Exception as e:
        return jsonify({"ok": False, "message": f"could not reject it: {e}"}), 502
    prog.update({"state": "failed", "rejectedAt": datetime.now(timezone.utc).isoformat(),
                 "rejectedBy": get_username()})
    plan["steps"][step_id] = prog
    _prod_plan_put(plan)
    return jsonify({"ok": True, "message": "Rejected. Nothing was deployed."})


@app.route("/api/production/plans/<plan_id>/steps/<step_id>/verify", methods=["POST"])
@require_role("admin")
def api_production_verify(plan_id, step_id):
    """Prove the step did what the recipe said, from the stage's own logs.

    A green tick is not proof. Both of this week's production incidents were pipelines reporting
    success while deploying an image that did not exist or skipping the application entirely, so
    the next step unlocks on evidence rather than on status.
    """
    plan = _prod_plan_get(plan_id)
    if not plan:
        return jsonify({"ok": False, "message": "no such plan"}), 404
    recipe = _prod_recipe(plan["appKey"], plan["tier"])
    step = _prod_step(recipe, step_id) if recipe else None
    if not step:
        return jsonify({"ok": False, "message": "no such step"}), 404
    prog = (plan.get("steps") or {}).get(step_id) or {}
    if not prog.get("releaseId"):
        return jsonify({"ok": False, "message": "this step has not run"}), 409

    rbase = release_base(recipe["project"])
    try:
        rel = _get(f"{rbase}/release/releases/{prog['releaseId']}?api-version={API_VERSION}")
    except Exception as e:
        return jsonify({"ok": False, "message": f"could not read the release: {e}"}), 502
    env = _find_stage(rel, step.get("stage"))
    status = (env or {}).get("status")

    expect = ((step.get("verifyBy") or {}).get("expect") or "").strip()
    want_task = (step.get("verifyBy") or {}).get("logTask")
    evidence, proved = [], None
    if expect:
        for ds in (env or {}).get("deploySteps", []):
            for ph in ds.get("releaseDeployPhases", []):
                for job in ph.get("deploymentJobs", []):
                    for t in job.get("tasks", []):
                        if want_task and t.get("name") != want_task:
                            continue
                        if not t.get("logUrl"):
                            continue
                        try:
                            body = _get_text(t["logUrl"])
                        except Exception:
                            continue
                        for line in body.split("\n"):
                            if expect in line:
                                evidence.append(re.sub(r"^\S*Z ", "", line).strip()[:220])
        proved = bool(evidence)

    state = "verified" if (status == "succeeded" and proved is not False) else (
            "failed" if status in ("rejected", "canceled", "partiallySucceeded") else prog.get("state"))
    prog.update({"state": state, "stageStatus": status,
                 "verifiedAt": datetime.now(timezone.utc).isoformat(),
                 "evidence": evidence[:6], "proved": proved})
    plan["steps"][step_id] = prog
    _prod_plan_put(plan)
    msg = {"verified": "Finished, and the logs show it did what it was supposed to.",
           "failed": f"This step ended as {status}. The next step stays locked.",
           }.get(state, f"Still {status or 'running'}.")
    if proved is False and status == "succeeded":
        msg = ("The pipeline reported success, but its logs do NOT contain the line that proves it "
               "did the work. Treat this as unfinished and look at the run before going on.")
        prog["state"] = "failed"
        _prod_plan_put(plan)
    return jsonify({"ok": True, "progress": prog, "message": msg, "evidence": evidence[:6]})


@app.route("/api/production/plans/<plan_id>/steps/<step_id>/confirm", methods=["POST"])
@require_role("admin")
def api_production_confirm(plan_id, step_id):
    """Record that a person did a step the portal does not run -- a repository edit, a registry
    unlock, a CI build. Nothing is checked here: it is an acknowledgement, and it is attributed."""
    plan = _prod_plan_get(plan_id)
    if not plan:
        return jsonify({"ok": False, "message": "no such plan"}), 404
    recipe = _prod_recipe(plan["appKey"], plan["tier"])
    step = _prod_step(recipe, step_id) if recipe else None
    if not step:
        return jsonify({"ok": False, "message": "no such step"}), 404
    if step.get("kind") not in _PROD_NEVER_START_KINDS and step.get("portalMayStart") is not False:
        return jsonify({"ok": False, "message":
                        "This step is run from the portal, so it cannot just be ticked off."}), 400
    note = (request.get_json(silent=True) or {}).get("note") or ""
    plan.setdefault("steps", {})[step_id] = {
        "state": "acknowledged", "note": note[:400],
        "acknowledgedAt": datetime.now(timezone.utc).isoformat(),
        "acknowledgedBy": get_username()}
    _prod_plan_put(plan)
    return jsonify({"ok": True, "message": "Recorded."})


# --- the watchlist: production approvals nobody asked for --------------------------------------
#
# Several release definitions put DEV, SIT, UAT and PROD in ONE definition and give the production
# stage the condition "ReleaseStarted". That condition fires when a release is CREATED, not when a
# stage is chosen -- so creating a release in order to deploy SIT also queues a production approval,
# sitting in someone's queue looking exactly like a routine one.
#
# Observed for real on 2026-08-31: a SIT deployment of adb2c-functionApp (def 17) created release
# 9085 and queued pending PROD, UAT and DEV approvals against Rajeeb T. SIT succeeded; production
# was one click from deploying, and nothing anywhere said so.
#
# The portal cannot stop the condition -- that is a definition change. What it can do is notice, say
# so, and offer the one safe action: reject.

# Stage names that mean production or beta, however the definition spells them.
_WATCH_STAGE = re.compile(r"prod|beta", re.IGNORECASE)


def _prod_watchlist_items():
    """Pending prod/beta approvals, newest first, flagged by how they came to exist."""
    out = []
    for project in ("ECom", "Macula"):
        rbase = release_base(project)
        try:
            pending = _get(f"{rbase}/release/approvals",
                           params={"statusFilter": "pending", "$top": 100,
                                   "api-version": API_VERSION})
        except Exception:
            continue
        for a in pending.get("value", []):
            env = a.get("releaseEnvironment") or {}
            stage = env.get("name") or ""
            if not _WATCH_STAGE.search(stage):
                continue
            rel = a.get("release") or {}
            rdef = a.get("releaseDefinition") or {}
            item = {
                "project": project,
                "approvalId": a.get("id"),
                "stage": stage,
                "releaseId": rel.get("id"),
                "releaseName": rel.get("name"),
                "definitionId": rdef.get("id"),
                "definitionName": rdef.get("name"),
                "approver": (a.get("approver") or {}).get("displayName"),
                "createdOn": a.get("createdOn"),
                "url": (f"https://dev.azure.com/{ORG}/{project}/_releaseProgress"
                        f"?releaseId={rel.get('id')}&_a=release-pipeline-progress"),
                "autoQueued": None,
                "why": "",
            }
            # Was this stage chosen, or did it queue itself? A stage whose only condition is
            # ReleaseStarted queued itself the moment the release was made.
            try:
                full = _get(f"{rbase}/release/releases/{rel.get('id')}?api-version={API_VERSION}")
                fenv = _find_stage(full, stage)
                conds = [c.get("name") for c in ((fenv or {}).get("conditions") or [])]
                steps = (fenv or {}).get("deploySteps") or []
                reason = (steps[0].get("reason") if steps else "") or ""
                item["autoQueued"] = "ReleaseStarted" in conds and reason == "automated"
                sibling = [e.get("name") for e in full.get("environments", [])
                           if not _WATCH_STAGE.search(e.get("name") or "")]
                if item["autoQueued"]:
                    item["why"] = (
                        f"Nobody chose this. {stage} on {rdef.get('name')} runs on "
                        f"\"ReleaseStarted\", so it queued itself when the release was created. "
                        + (f"That release exists to deploy {', '.join(sibling)}. "
                           if sibling else "")
                        + "Approving it would deploy to production.")
                else:
                    item["why"] = "This stage was started deliberately and is waiting for approval."
            except Exception:
                pass
            out.append(item)
    out.sort(key=lambda x: (not x.get("autoQueued"), x.get("createdOn") or ""), reverse=False)
    return out


@app.route("/api/production/watchlist")
@require_role("admin")
def api_production_watchlist():
    items = _prod_watchlist_items()
    return jsonify({"ok": True, "items": items,
                    "autoQueued": sum(1 for i in items if i.get("autoQueued"))})


@app.route("/api/production/watchlist/reject", methods=["POST"])
@require_role("admin")
def api_production_watchlist_reject():
    """Reject one pending production approval.

    The only mutating action in the whole production section that is not tied to a plan, and it
    exists because these approvals are not tied to a plan either -- they queued themselves. Reject
    is offered where approve deliberately is not: turning a production deployment down cannot break
    anything, and leaving an unasked-for one sitting in a queue can.
    """
    body = request.get_json(silent=True) or {}
    project = (body.get("project") or "").strip()
    approval_id = body.get("approvalId")
    if project not in ("ECom", "Macula") or not approval_id:
        return jsonify({"ok": False, "message": "project and approvalId are required"}), 400
    rbase = release_base(project)
    try:
        current = _get(f"{rbase}/release/approvals/{approval_id}?api-version={API_VERSION}")
    except Exception as e:
        return jsonify({"ok": False, "message": f"could not read that approval: {e}"}), 502
    if current.get("status") != "pending":
        return jsonify({"ok": False, "message":
                        f"that approval is already {current.get('status')}"}), 409
    stage = ((current.get("releaseEnvironment") or {}).get("name")) or ""
    if not _WATCH_STAGE.search(stage):
        # Rejecting a lower-environment approval is not this route's job, and refusing keeps the
        # blast radius of a hand-made request to exactly what the screen shows.
        return jsonify({"ok": False, "message":
                        f"{stage} is not a production or beta stage"}), 403
    try:
        _patch(f"{rbase}/release/approvals/{approval_id}?api-version={API_VERSION}",
               {"status": "rejected",
                "comments": (body.get("reason") or
                             "Rejected via Magrabi Deployment Portal: not requested")})
    except Exception as e:
        return jsonify({"ok": False, "message": f"could not reject it: {e}"}), 502
    return jsonify({"ok": True, "message": f"{stage} approval rejected. Nothing was deployed."})


# --- the recipes ------------------------------------------------------------------------------
#
# WHY THIS IS HAND-WRITTEN AND CANNOT BE DERIVED:
# Nothing in Azure DevOps links an application's tag pipeline to the pipeline that deploys it.
# def 34 and def 16 share no artifact, no trigger and no reference; def 56 has empty triggers. The
# ORDER they must run in, and the fact that they are one job at all, exists only in people's heads
# and in this table. Names do not help either: CD-Secret-Saleor-Core applies ecom-common-secret,
# and namespace is many-to-many (five definitions write saleor-dev).
#
# Each row is verified against the live definitions. `confidence` records anything inferred.
# scripts/verify_prod_recipes.py re-derives what IS derivable and reports drift.

_APPROVER_ECOM = "[ECom]\\DevOps Approver"

PROD_RECIPES = {
    ("doctorm-storefront", "BETA"): {'appKey': 'doctorm-storefront',
     'tier': 'BETA',
     'displayName': 'DoctorM Storefront (Beta)',
     'project': 'ECom',
     'cluster': 'aks-ecom-prod-uaenorth-001',
     'namespaces': ['storefront-beta'],
     'workloads': [{'name': 'doctorm-sf', 'replicas': 1},
                   {'name': 'doctorm-sf-checkout', 'replicas': 1}],
     'registry': 'crmepuproduaenorth001',
     'imageRepo': 'doctorm-storefront',
     'runningTag': 'beta',
     'tagMutable': True,
     'rollbackTag': None,
     'rollbackTagUsable': False,
     'driverFile': '/devops/prod/release_config_beta_storefront.json',
     'driverServiceName': 'doctorm-storefront-beta',
     'driverServiceNamesAll': ['doctorm-storefront-beta', 'doctorm-storefront-checkout-beta'],
     'currentlyDisabled': True,
     'steps': [{'stepId': 'driver-enable',
                'order': 1,
                'kind': 'edit',
                'title': 'Turn the DoctorM beta rows on in the driver file',
                'plain': 'Both DoctorM rows in release_config_beta_storefront.json currently say '
                         'deploy false, so the deploy pipeline skips them. They have to be set to '
                         'true on master before anything will move. Leave version as the word beta.',
                'project': 'ECom',
                'repo': 'ecom',
                'repositoryId': 'd57e35b2-f3f5-4783-b8dc-7662730e1ad2',
                'path': '/devops/prod/release_config_beta_storefront.json',
                'branch': 'master',
                'reads': {'driverFile': '/devops/prod/release_config_beta_storefront.json',
                          'field': 'deploy',
                          'services': ['doctorm-storefront-beta',
                                       'doctorm-storefront-checkout-beta']},
                'currentValues': {'doctorm-storefront-beta': {'version': 'beta', 'deploy': 'false'},
                                  'doctorm-storefront-checkout-beta': {'version': 'beta',
                                                                       'deploy': 'false'}},
                'hazards': ['shared-file-also-drives-magrabi', 'version-is-a-literal-not-a-number']},
               {'stepId': 'tag',
                'order': 2,
                'kind': 'tag',
                'title': 'Refresh the DoctorM beta image - DO NOT RUN THIS STAGE',
                'plain': 'This stage is meant to build DoctorM and move its beta tag. It does not. '
                         'Its last task still says ENV=prod, so it copies the freshly built beta '
                         'image straight onto doctorm-storefront:prod, the tag live DoctorM '
                         'production runs from. Running it would put an unreleased beta build in '
                         'front of DoctorM customers.',
                'project': 'ECom',
                'definitionId': 45,
                'definitionName': 'CD-DrM-Storefront',
                'stage': 'BETA_TAG',
                'stageTrigger': 'auto - condition PROD_TAG environmentState=4 (succeeded)',
                'approval': {'manual': True,
                             'timeoutMinutes': 1,
                             'approver': '[ECom]\\DevOps Approver',
                             'releaseCreatorCanBeApprover': True},
                'pins': [{'alias': '_CI-DrM-Storefront',
                          'type': 'Build',
                          'choose': 'user',
                          'requireBranch': None,
                          'definitionId': 75,
                          'definitionName': 'CI-DrM-Storefront',
                          'artifactDefaultVersionType': 'latestType',
                          'note': 'No branch filter on the artifact and no branch condition on the '
                                  'BETA_TAG stage.'},
                         {'alias': '_ecom',
                          'type': 'Git',
                          'choose': 'branch-head',
                          'branch': 'master'}],
                'enabledTasks': ['Check Version Beta', 'build', 'Push Beta', 'Tagging Image'],
                'disabledTasks': ['Check Version'],
                'reads': {'driverFile': '/devops/prod/release_config_beta_storefront.json',
                          'field': 'version',
                          'service': 'doctorm-storefront-beta',
                          'alwaysResolvesTo': 'beta'},
                'writes': {'registryTags': ['doctorm-storefront:beta',
                                            'doctorm-storefront:prod',
                                            'doctorm-storefront:prod-prv']},
                'intendedWrites': {'registryTags': ['doctorm-storefront:beta',
                                                    'doctorm-storefront:beta-prv']},
                'verifyBy': {'logTask': 'Tagging Image',
                             'expect': 'az acr import --name crmepuproduaenorth001 --source '
                                       'crmepuproduaenorth001.azurecr.io/doctorm-storefront:beta '
                                       '--force --image doctorm-storefront:prod'},
                'portalMayStart': False,
                'blockedReason': 'Defect, not policy. Tagging Image in this stage sets ENV=prod, so '
                                 'it imports doctorm-storefront:beta onto doctorm-storefront:prod '
                                 'and overwrites the prod-prv rollback snapshot on the way. The '
                                 'stage also auto-queues after a DoctorM PROD_TAG success, so a '
                                 'pending BETA_TAG approval on def 45 must be rejected, never '
                                 'approved. Blocked until ENV is changed to beta.',
                'hazards': ['overwrites-doctorm-production-tag',
                            'destroys-doctorm-prod-rollback-snapshot',
                            'auto-triggers-after-prod-tag',
                            'no-tag-exists-guard',
                            'one-minute-approval',
                            'beta-tag-currently-unlocked-so-push-will-succeed']},
               {'stepId': 'deploy',
                'order': 3,
                'kind': 'deploy',
                'title': 'Roll the DoctorM beta pods',
                'plain': 'Applies the two DoctorM beta deployment files to the production cluster. '
                         'It only does anything once the deploy flags in the driver file are true.',
                'project': 'ECom',
                'definitionId': 70,
                'definitionName': 'Production-Release-Storefront-BETA',
                'stage': 'BETA PROD',
                'stageTrigger': 'ReleaseStarted',
                'approval': {'manual': True,
                             'timeoutMinutes': 0,
                             'approver': '[ECom]\\DevOps Approver',
                             'releaseCreatorCanBeApprover': True},
                'pins': [{'alias': '_ecom',
                          'type': 'Git',
                          'choose': 'branch-head',
                          'branch': 'master'}],
                'taskForThisApp': 'Deploy DoctorM SF',
                'reads': {'driverFile': '/devops/prod/release_config_beta_storefront.json',
                          'fields': ['name', 'yaml', 'version', 'deploy']},
                'applies': ['/devops/prod/k8/beta/deployments/doctorm-storefront-deployment.yml',
                            '/devops/prod/k8/beta/deployments/doctorm-storefront-checkout-deployment.yml'],
                'writes': {'kubernetes': ['deployment/doctorm-sf -n storefront-beta',
                                          'deployment/doctorm-sf-checkout -n storefront-beta']},
                'verifyBy': {'logTask': 'Deploy DoctorM SF',
                             'expect': 'deployment.apps/doctorm-sf configured'},
                'currentBehaviour': "Logs 'Skipping deployment for doctorm-storefront-beta (deploy "
                                    "flag is set to false)' - verified on release 9070.",
                'hazards': ['runs-against-production-cluster',
                            'same-run-also-executes-the-magrabi-task',
                            'rollout-triggered-only-by-date-stamp']}],
     'knownProblems': ['def 45 BETA_TAG is a half-finished clone of PROD_TAG. Its Tagging Image task '
                       'still sets ENV=prod, so it imports the beta build onto '
                       'doctorm-storefront:prod and rewrites doctorm-storefront:prod-prv. def 41 had '
                       'exactly this bug when its BETA_TAG was cloned - revision 281 had ENV=prod - '
                       'and it was corrected to ENV=beta by revision 291. That correction was never '
                       'carried to def 45: every revision from 321 through the current 408 still has '
                       'ENV=prod.',
                       'def 45 BETA_TAG auto-queues whenever DoctorM PROD_TAG succeeds. It is '
                       'staying harmless only because operators keep rejecting it - releases 8913 '
                       'and 9053 both show PROD_TAG succeeded and BETA_TAG rejected. It has never '
                       'completed successfully, which is why doctorm-storefront:prod is still '
                       'intact.',
                       'There is no doctorm-storefront:beta-prv tag in the registry at all, so '
                       'DoctorM beta has no rollback point even in principle. The repository holds '
                       'prod, prod-prv, master, beta and dated tags only.',
                       'doctorm-storefront:beta is currently write-enabled (unlocked), unlike the '
                       'Magrabi beta tag. Nothing would stop a push landing on it.',
                       'DoctorM beta pods are live on the production cluster but frozen. Both run '
                       'doctorm-storefront:beta with a deploy date stamp of 2026-08-18 12:07:58, '
                       'matching def 70 Release-14, the last run before the deploy flags were set to '
                       'false.',
                       "Check Version Beta has no 'image tag already exists' guard, correctly, for "
                       'the same reason as Magrabi: version is the literal string beta. The guard '
                       'survives uncommented on the disabled prod-flavoured Check Version task; '
                       'enabling that task would break the stage on every run.',
                       'Until ENV is fixed, the deploy step is the only part of the DoctorM beta '
                       'path that can be run as designed. Refreshing doctorm-storefront:beta has to '
                       'happen out of band.'],
     'confidence': {'steps': 'verified',
                    'pins': 'verified',
                    'workloads': 'verified',
                    'envProdDefect': 'verified',
                    'autoTriggerCondition': 'verified',
                    'noBetaPrvTag': 'verified',
                    'operatorIntentBehindEnvProd': 'inferred',
                    'source': 'authored and cross-verified 2026-08-27 by two independent passes '
                              'against the live definitions'},
     'repoId': 'd57e35b2-f3f5-4783-b8dc-7662730e1ad2',
     'branch': 'master'},

    ("doctorm-storefront", "PROD"): {'appKey': 'doctorm-storefront',
     'tier': 'PROD',
     'displayName': 'DoctorM Storefront',
     'project': 'ECom',
     'cluster': 'aks-ecom-prod-uaenorth-001',
     'namespaces': ['storefront'],
     'resourceGroup': 'rg-mepu-prod-uaenorth-001',
     'workloads': [{'name': 'doctorm-sf',
                    'replicas': 4,
                    'liveReplicas': 4,
                    'hpa': {'name': 'doctorm-sf-hpa', 'min': 4, 'max': 120},
                    'yaml': 'k8/deployments/doctorm-storefront-deployment.yml',
                    'driverEntry': 'doctorm-storefront'},
                   {'name': 'doctorm-sf-browse-ae',
                    'replicas': 4,
                    'liveReplicas': 4,
                    'hpa': {'name': 'doctorm-sf-browse-ae-hpa', 'min': 4, 'max': 120},
                    'yaml': 'k8/deployments/doctorm-storefront-browse-ae-deployment.yml',
                    'driverEntry': 'doctorm-storefront-browse-ae'},
                   {'name': 'doctorm-sf-checkout',
                    'replicas': 2,
                    'liveReplicas': 2,
                    'hpa': {'name': 'doctorm-sf-checkout-hpa', 'min': 2, 'max': 10},
                    'yaml': 'k8/deployments/doctorm-storefront-checkout-deployment.yml',
                    'driverEntry': 'doctorm-storefront-checkout'},
                   {'name': 'doctorm-sf-profile',
                    'replicas': 1,
                    'liveReplicas': 1,
                    'hpa': None,
                    'yaml': 'k8/deployments/doctorm-storefront-profile-deployment.yml',
                    'driverEntry': 'doctorm-storefront-profile',
                    'note': 'Held back. Driver pins it to version 1.0.1 with deploy=false, and the '
                            'pod really is running doctorm-storefront:1.0.1. Switching it on would '
                            'jump it to :master.'}],
     'registry': 'crmepuproduaenorth001',
     'imageRepo': 'doctorm-storefront',
     'runningTag': 'master',
     'tagMutable': True,
     'rollbackTag': 'prod-prv',
     'archiveTag': 'prod',
     'driverFile': '/devops/prod/release_config_doctorm_sf.json',
     'driverServiceName': 'doctorm-storefront',
     'driverRepo': {'project': 'ECom',
                    'repo': 'ecom',
                    'repositoryId': 'd57e35b2-f3f5-4783-b8dc-7662730e1ad2',
                    'branch': 'master'},
     'driverCurrentContents': [{'name': 'doctorm-storefront',
                                'yaml': 'doctorm-storefront-deployment.yml',
                                'version': 'master',
                                'deploy': 'true'},
                               {'name': 'doctorm-storefront-browse-ae',
                                'yaml': 'doctorm-storefront-browse-ae-deployment.yml',
                                'version': 'master',
                                'deploy': 'true'},
                               {'name': 'doctorm-storefront-checkout',
                                'yaml': 'doctorm-storefront-checkout-deployment.yml',
                                'version': 'master',
                                'deploy': 'true'},
                               {'name': 'doctorm-storefront-profile',
                                'yaml': 'doctorm-storefront-profile-deployment.yml',
                                'version': '1.0.1',
                                'deploy': 'false'},
                               {'name': 'doctorm-storefront-preview',
                                'yaml': 'doctorm-storefront-preview-deployment.yml',
                                'version': '1.0.0',
                                'deploy': 'false'}],
     'driverContentsReadAt': '2026-08-27, master head, file last changed by commit 60becdbd on '
                             '2026-08-26 07:11',
     'steps': [{'stepId': 'ci-build',
                'order': 1,
                'kind': 'external',
                'title': 'Build the code on the branch you are shipping',
                'plain': 'Someone has to start a build of the DoctorM storefront code first, '
                         'choosing the branch that is going live. Only pushes to the sit branch '
                         'start a build automatically, so for a production release it is queued by '
                         'hand.',
                'project': 'ECom',
                'definitionId': 75,
                'definitionName': 'CI-DrM-Storefront',
                'definitionType': 'build',
                'definitionPath': '\\storefront',
                'sourceRepo': 'GitHub Magrabi-digital/doctorm-storefront',
                'stage': None,
                'approval': None,
                'pins': [],
                'reads': {},
                'writes': {'pipelineArtifact': 'doctorm-storefront'},
                'verifyBy': {'logTask': 'Publish Pipeline Artifact',
                             'expect': 'The build succeeds and publishes the artifact named '
                                       'doctorm-storefront. Note its build number and source branch, '
                                       'you need both in step 3.'},
                'hazards': ['ci-trigger-only-fires-on-refs/heads/sit', 'pick-the-right-branch'],
                'portalMayStart': False,
                'blockedReason': 'A build pipeline on a GitHub repo, queued by hand against a chosen '
                                 'branch. Which branch ships is a human decision outside the release '
                                 'flow.'},
               {'stepId': 'driver-enable',
                'order': 2,
                'kind': 'edit',
                'title': 'Check the DoctorM entries are switched on in the release config file',
                'plain': 'The deploy pipeline only touches the parts that are switched on in one '
                         'small settings file. The three live DoctorM entries are already switched '
                         'on today, so usually there is nothing to change here, but check before you '
                         'rely on it.',
                'project': 'ECom',
                'definitionId': None,
                'definitionName': None,
                'stage': None,
                'approval': None,
                'pins': [],
                'reads': {'driverFile': '/devops/prod/release_config_doctorm_sf.json'},
                'writes': {'gitFile': '/devops/prod/release_config_doctorm_sf.json',
                           'branch': 'master',
                           'field': 'deploy',
                           'from': 'false',
                           'to': 'true',
                           'entries': ['doctorm-storefront',
                                       'doctorm-storefront-browse-ae',
                                       'doctorm-storefront-checkout'],
                           'leaveOff': ['doctorm-storefront-profile', 'doctorm-storefront-preview'],
                           'doNotChange': {'version': 'master for the three live entries; 1.0.1 and '
                                                      '1.0.0 on the two held-back entries'},
                           'currentState': 'already true for the three live entries as of commit '
                                           '60becdbd, so this step is often a no-op'},
                'verifyBy': {'logTask': None,
                             'expect': 'The file on master shows deploy true on the three live '
                                       'entries and version master on them. If you had to change it, '
                                       'record the commit id.'},
                'hazards': ['leave-profile-and-preview-off',
                            'commit-must-land-before-the-step-4-release-is-created'],
                'portalMayStart': False,
                'blockedReason': 'A hand edit and commit to master of the ecom Git repo, not a '
                                 'pipeline run. Which entries go on decides what production gets.'},
               {'stepId': 'tag',
                'order': 3,
                'kind': 'tag',
                'title': "Build the production image and move production's tag onto it",
                'plain': 'This makes the real production image and puts the production label on it, '
                         'keeping the label from the last release as a spare. Nothing that is '
                         'running changes yet.',
                'project': 'ECom',
                'definitionId': 45,
                'definitionName': 'CD-DrM-Storefront',
                'definitionType': 'release',
                'definitionPath': '\\storefront',
                'stage': 'PROD_TAG',
                'stageDefinitionId': 125,
                'agent': {'pool': 'Azure Pipelines', 'queueId': 18, 'image': 'ubuntu-latest'},
                'approval': {'manual': True,
                             'timeoutMinutes': 1,
                             'approver': '[ECom]\\DevOps Approver',
                             'requiredApproverCount': None,
                             'releaseCreatorCanBeApprover': True,
                             'executionOrder': 'beforeGates',
                             'gates': []},
                'stageTriggerConditions': [{'type': 'environmentState',
                                            'name': 'UAT',
                                            'value': '4 (succeeded)'},
                                           {'type': 'artifact',
                                            'alias': '_CI-DrM-Storefront',
                                            'sourceBranch': 'beta'}],
                'pins': [{'alias': '_CI-DrM-Storefront',
                          'type': 'Build',
                          'choose': 'user',
                          'sourceDefinitionId': 75,
                          'sourceDefinitionName': 'CI-DrM-Storefront',
                          'requireBranch': None,
                          'branchRule': 'The build from step 1, produced from the branch being '
                                        'shipped. Recent production runs used '
                                        'refs/heads/release/<date>, refs/heads/release/hotfix/<date> '
                                        "and refs/heads/master. The stage's own trigger filter names "
                                        'branch beta, which no recent production run has used, so do '
                                        "not treat that filter as the rule. Check the build's source "
                                        'branch by hand.',
                          'defaultIfNotPinned': 'latestType, newest build on definition 75 '
                                                'regardless of branch. Never accept this default.'},
                         {'alias': '_ecom',
                          'type': 'Git',
                          'choose': 'branch-head',
                          'branch': 'master',
                          'repositoryId': 'd57e35b2-f3f5-4783-b8dc-7662730e1ad2',
                          'defaultIfNotPinned': 'latestFromBranchType on master',
                          'note': 'This stage only reads the version field, which is master for '
                                  'doctorm-storefront, so branch head is safe here. Record the '
                                  'commit it resolves to and reuse it in step 4.'}],
                'reads': {'driverFile': '/devops/prod/release_config_doctorm_sf.json',
                          'field': 'version',
                          'currentValue': 'master',
                          'workingDirectory': '$(System.DefaultWorkingDirectory)/_ecom/devops/prod'},
                'writes': {'registryTags': ['doctorm-storefront:master',
                                            'doctorm-storefront:prod-prv',
                                            'doctorm-storefront:prod'],
                           'registry': 'crmepuproduaenorth001',
                           'order': 'current prod is copied to prod-prv, then master is copied onto '
                                    'prod'},
                'tasks': ['Check Version', 'build', 'Push', 'Tagging Image'],
                'verifyBy': {'logTask': 'Tagging Image',
                             'expect': '+ az acr import --name crmepuproduaenorth001 --source '
                                       'crmepuproduaenorth001.azurecr.io/doctorm-storefront:master '
                                       '--force --image doctorm-storefront:prod',
                             'additionalChecks': [{'logTask': 'Check Version',
                                                   'expect': '+ RELEASE_VERSION=master'},
                                                  {'logTask': 'Push',
                                                   'expect': '[command]/usr/bin/docker push '
                                                             'crmepuproduaenorth001.azurecr.io/doctorm-storefront:master'},
                                                  {'logTask': 'Tagging Image',
                                                   'expect': '+ az acr import --name '
                                                             'crmepuproduaenorth001 --source '
                                                             'crmepuproduaenorth001.azurecr.io/doctorm-storefront:prod '
                                                             '--force --image '
                                                             'doctorm-storefront:prod-prv'}],
                             'afterwards': 'az acr repository show-tags --name crmepuproduaenorth001 '
                                           '--repository doctorm-storefront --detail : master and '
                                           'prod must share one digest, prod-prv holds the previous '
                                           'one.'},
                'hazards': ['one-minute-approval',
                            'no-duplicate-tag-guard',
                            'mutable-master-tag',
                            'rollback-is-only-one-release-deep',
                            'artifact-default-is-latest-build',
                            'beta-tag-stage-auto-queues-after-this-one']},
               {'stepId': 'deploy',
                'order': 4,
                'kind': 'deploy',
                'title': 'Apply the Kubernetes files so production picks up the new image',
                'plain': 'This is the step that actually changes the live site. It reads the '
                         'settings file and, for every entry switched on, pushes the matching '
                         'Kubernetes file to the production cluster so the pods restart on the new '
                         'image.',
                'project': 'ECom',
                'definitionId': 24,
                'definitionName': 'Production-Release-Storefront',
                'definitionType': 'release',
                'definitionPath': '\\prod_release',
                'stage': 'PROD',
                'stageDefinitionId': 46,
                'agent': {'pool': 'Azure Pipelines', 'queueId': 18, 'image': 'ubuntu-24.04'},
                'approval': {'manual': True,
                             'timeoutMinutes': 60,
                             'approver': '[ECom]\\DevOps Approver',
                             'requiredApproverCount': 1,
                             'releaseCreatorCanBeApprover': True,
                             'executionOrder': 'beforeGates',
                             'gates': []},
                'pins': [{'alias': '_ecom',
                          'type': 'Git',
                          'choose': 'commit',
                          'branch': 'master',
                          'repositoryId': 'd57e35b2-f3f5-4783-b8dc-7662730e1ad2',
                          'requireCommitAtOrAfter': 'the commit made in step 2, if step 2 changed '
                                                    'anything',
                          'defaultIfNotPinned': 'latestFromBranchType on master',
                          'note': 'The only artifact on definition 24. If the release is created '
                                  'before the step 2 commit lands on master, the stage silently '
                                  'skips the entries and reports success.'}],
                'stageVariables': {'CLUSTER_NAME': 'aks-ecom-prod-uaenorth-001',
                                   'RG_NAME': 'rg-mepu-prod-uaenorth-001',
                                   'MAGRABI_JSON_FILE': 'release_config_magrabi_sf.json',
                                   'DOCTORM_JSON_FILE': 'release_config_doctorm_sf.json '
                                                        '(definition-level variable)'},
                'reads': {'driverFile': '/devops/prod/release_config_doctorm_sf.json',
                          'fields': ['name', 'yaml', 'version', 'deploy'],
                          'workingDirectory': '$(System.DefaultWorkingDirectory)/_ecom/devops/prod',
                          'yamlDirectory': 'k8/deployments/'},
                'writes': {'kubernetes': ['deployment/doctorm-sf -n storefront',
                                          'deployment/doctorm-sf-browse-ae -n storefront',
                                          'deployment/doctorm-sf-checkout -n storefront'],
                           'imageApplied': 'crmepuproduaenorth001.azurecr.io/doctorm-storefront:master',
                           'rolloutTrigger': 'the env var AKS_UNIQUE_KEY_DEPLOY_DATE is stamped with '
                                             'the run time, which forces new pods even though the '
                                             'image tag text is unchanged'},
                'tasks': ['Deploy Magrabi SF', 'Deploy DoctorM SF'],
                'verifyBy': {'logTask': 'Deploy DoctorM SF',
                             'expect': 'Applying deployment for doctorm-storefront using '
                                       'k8/deployments/doctorm-storefront-deployment.yml ... '
                                       'deployment.apps/doctorm-sf configured',
                             'additionalChecks': [{'logTask': 'Deploy DoctorM SF',
                                                   'expect': 'deployment.apps/doctorm-sf-browse-ae '
                                                             'configured'},
                                                  {'logTask': 'Deploy DoctorM SF',
                                                   'expect': 'deployment.apps/doctorm-sf-checkout '
                                                             'configured'},
                                                  {'logTask': 'Deploy DoctorM SF',
                                                   'expect': 'image: '
                                                             'crmepuproduaenorth001.azurecr.io/doctorm-storefront:master'},
                                                  {'logTask': 'Deploy DoctorM SF',
                                                   'expect': 'Skipping deployment for '
                                                             'doctorm-storefront-profile (deploy '
                                                             'flag is set to false)'},
                                                  {'logTask': 'Deploy Magrabi SF',
                                                   'expect': 'check what this task did; it runs in '
                                                             'the same stage and uses the Magrabi '
                                                             'settings file'}],
                             'failureSignature': 'Skipping deployment for doctorm-storefront (deploy '
                                                 'flag is set to false) means the entries were off, '
                                                 'or the pinned _ecom commit predates step 2.',
                             'afterwards': 'kubectl -n storefront get deploy doctorm-sf -o '
                                           'jsonpath={.spec.template.spec.containers[0].image} and '
                                           'compare the running pod digest with the master tag in '
                                           'the registry.'},
                'hazards': ['this-stage-also-deploys-magrabi',
                            'sixty-minute-approval',
                            'profile-and-preview-entries-must-stay-off',
                            'doctorm-storefront-preview-deployment.yml-does-not-exist-in-the-repo']},
               {'stepId': 'driver-disable',
                'order': 5,
                'kind': 'edit',
                'title': 'Switch the DoctorM entries back off',
                'plain': 'Put the settings file back with the DoctorM entries switched off, so the '
                         'next Magrabi-only release does not restart DoctorM as well. This was '
                         'skipped after the last release, which is why they are still on today.',
                'project': 'ECom',
                'definitionId': None,
                'definitionName': None,
                'stage': None,
                'approval': None,
                'pins': [],
                'reads': {'driverFile': '/devops/prod/release_config_doctorm_sf.json'},
                'writes': {'gitFile': '/devops/prod/release_config_doctorm_sf.json',
                           'branch': 'master',
                           'field': 'deploy',
                           'from': 'true',
                           'to': 'false',
                           'entries': ['doctorm-storefront',
                                       'doctorm-storefront-browse-ae',
                                       'doctorm-storefront-checkout']},
                'verifyBy': {'logTask': None,
                             'expect': 'A follow-up commit on master returning the three live '
                                       'entries to false. Example pairs: 0f212687 on then ee92b6fc '
                                       'off, e5fdeef7 on then e537ed90 off. Not done after 60becdbd, '
                                       'so the file is on today.'},
                'hazards': ['easy-to-forget', 'currently-left-on'],
                'portalMayStart': False,
                'blockedReason': 'A hand edit and commit to master, not a pipeline run.'}],
     'knownProblems': ['The DoctorM driver file is left at deploy=true today (commit 60becdbd, '
                       '2026-08-26 07:11), so any run of definition 24 PROD by anyone, for any '
                       'brand, restarts doctorm-sf, doctorm-sf-browse-ae and doctorm-sf-checkout.',
                       'Definition 24 PROD runs Deploy Magrabi SF and Deploy DoctorM SF in the same '
                       'stage. There is no way to deploy one brand without the other task also '
                       'running against its own settings file.',
                       'Definition 45 stage BETA_TAG is set to start automatically once PROD_TAG '
                       'succeeds. Its own approval also times out after 1 minute, so it queues and '
                       'is then auto-rejected. Verified on deployments 15656, 15485, 15453, 15411 '
                       'and 15404, all requested by '
                       'Microsoft.VisualStudio.Services.ReleaseManagement and all Rejected. Expect a '
                       'rejected BETA_TAG entry after every production tag run, and do not read it '
                       'as a failure of the production release.',
                       'The Check Version task on definition 45 has no duplicate-image-tag guard at '
                       'all, so nothing stops the same tag being rebuilt and overwritten.',
                       'The cluster runs the mutable tag doctorm-storefront:master, not :prod. The '
                       ':prod and :prod-prv tags are write-locked archive pointers. A rollback means '
                       'editing the driver version field to prod-prv, or re-importing prod-prv over '
                       'master. No release in the retained history has done this.',
                       'Rollback is only one release deep. The next PROD_TAG run overwrites prod-prv '
                       'with the current prod.',
                       'The driver lists doctorm-storefront-preview with yaml '
                       'doctorm-storefront-preview-deployment.yml, but that file does not exist '
                       'under /devops/prod/k8/deployments in master. It is harmless only while its '
                       'deploy flag stays false; switching it on would fail the stage.',
                       'doctorm-sf-profile is deliberately pinned to version 1.0.1 with '
                       'deploy=false, and its pod really is running doctorm-storefront:1.0.1. It '
                       'does not move with production releases.',
                       'The doctorm-sf HPAs exist in the cluster but there are no matching files '
                       'under /devops/prod/k8/hpa in the repo, which only holds the Magrabi ones. '
                       'The DoctorM HPAs are managed outside this repo.',
                       'The PROD_TAG approval times out after 1 minute. Have an approver waiting '
                       'before starting the stage.',
                       "Definition 45's build artifact defaults to Latest, and the stage's own "
                       'artifact trigger filter names branch beta while every recent production run '
                       'used a release/<date> branch. Always pin the build by hand.',
                       'Definition 24 PROD retains only 3 releases / 30 days, so older deploy logs '
                       'disappear quickly.'],
     'confidence': {'steps': 'verified',
                    'pins': 'verified',
                    'approval': 'verified',
                    'definitions': 'verified',
                    'stages': 'verified',
                    'driverFile': 'verified',
                    'driverContents': 'verified',
                    'registry': 'verified',
                    'imageTags': 'verified',
                    'runningTag': 'verified',
                    'rollbackTag': 'verified',
                    'namespaces': 'verified',
                    'workloads': 'verified',
                    'replicas': 'verified: replicas is the manifest value the deploy applies; '
                                'liveReplicas read from the cluster on 2026-08-27',
                    'verifyBy': 'verified, log text quoted from release 9064 stage PROD_TAG and '
                                'release 9065 stage PROD',
                    'rollbackProcedure': 'inferred. The pipeline writes prod-prv, but no release in '
                                         'the retained history consumes it. Confirming needs a '
                                         'DevOps statement or one observed rollback.',
                    'betaTagAutoChain': 'verified from deployment history that BETA_TAG auto-queues '
                                        'and is auto-rejected. Note the definition JSON shows the '
                                        'condition PROD_TAG state 4 while the release-9064 snapshot '
                                        'at the same revision 408 shows no condition, so exactly '
                                        'when it will and will not fire is inferred.',
                    'ciBuildStep': 'verified that definition 75 auto-builds only refs/heads/sit and '
                                   'is otherwise queued by hand; inferred that queueing it is always '
                                   "the human's first move rather than reusing an existing build",
                    'driverEnableStep': 'verified as a no-op today because the flags are already '
                                        'true; inferred that a release always begins by confirming '
                                        'them rather than assuming',
                    'driverDisableStep': 'verified as the usual pattern from commit history; '
                                         'inferred that it is a required rule rather than a habit, '
                                         'and it was skipped after the most recent release',
                    'source': 'authored and cross-verified 2026-08-27 by two independent passes '
                              'against the live definitions'},
     'repoId': 'd57e35b2-f3f5-4783-b8dc-7662730e1ad2',
     'branch': 'master'},

    ("ecom-checkout-app", "PROD"): {'appKey': 'ecom-checkout-app',
     'tier': 'PROD',
     'displayName': 'Saleor Checkout App',
     'project': 'ECom',
     'repoId': 'd57e35b2-f3f5-4783-b8dc-7662730e1ad2',
     'branch': 'master',
     'cluster': 'aks-ecom-prod-uaenorth-001',
     'namespaces': ['saleor-apps'],
     'registry': 'crmepuproduaenorth001',
     'imageRepo': 'ecom-checkout',
     'runningTag': None,
     'tagMutable': False,
     'rollbackTag': 'prod-prv',
     'driverFile': '/devops/prod/release_config_saleor_apps.json',
     'driverServiceName': 'checkout-app',
     'steps': [{'stepId': 'tag',
                'order': 1,
                'kind': 'tag',
                'title': 'Build the image and promote it to production',
                'plain': 'Builds the application, pushes it under the version named in the settings '
                         'file, and points the production tag at it.',
                'project': 'ECom',
                'definitionId': 35,
                'definitionName': 'CD-Ecom-Checkout',
                'stage': 'PROD_TAG',
                'approval': {'manual': True,
                             'timeoutMinutes': 1,
                             'approver': '[ECom]\\DevOps Approver'},
                'pins': [{'alias': '_CI-Ecom-Checkout', 'type': 'Build', 'choose': 'user'},
                         {'alias': '_ecom',
                          'type': 'Git',
                          'choose': 'branch-head',
                          'branch': 'master'}],
                'duplicateTagGuard': False,
                'writes': {'registryTags': ['ecom-checkout:<version>', 'ecom-checkout:prod']},
                'verifyBy': {'logTask': 'Tagging Image', 'expect': '--image ecom-checkout:prod'}},
               {'stepId': 'deploy',
                'order': 2,
                'kind': 'deploy',
                'title': 'Restart the service on the new image',
                'plain': 'Applies the Kubernetes file so the pods pull the version the settings file '
                         'names. Skips any application whose deploy flag is not true.',
                'project': 'ECom',
                'definitionId': 2,
                'definitionName': 'Production-Release-Saleor-Apps',
                'stage': 'PROD',
                'approval': {'manual': True,
                             'timeoutMinutes': None,
                             'approver': '[ECom]\\DevOps Approver'},
                'pins': [{'alias': '_ecom',
                          'type': 'Git',
                          'choose': 'branch-head',
                          'branch': 'master'}],
                'writes': {'namespaces': ['saleor-apps']},
                'verifyBy': {'logTask': None, 'expect': 'Applying deployment for checkout-app'}}],
     'knownProblems': ['The duplicate-tag guard is commented out on def 35 only. Every other saleor '
                       'app refuses to rebuild over an existing tag; this one overwrites it. '
                       'Re-enabling those lines would have prevented the 25 August incident, where '
                       'the version was stale and a live production image was replaced in place.'],
     'confidence': {'steps': 'verified',
                    'pins': 'verified',
                    'deployApprovalTimeout': 'inferred, not read from the definition'}},

    ("ecom-search-app", "PROD"): {'appKey': 'ecom-search-app',
     'tier': 'PROD',
     'displayName': 'Saleor Search App',
     'project': 'ECom',
     'repoId': 'd57e35b2-f3f5-4783-b8dc-7662730e1ad2',
     'branch': 'master',
     'cluster': 'aks-ecom-prod-uaenorth-001',
     'namespaces': ['saleor-apps'],
     'registry': 'crmepuproduaenorth001',
     'imageRepo': 'ecom-search-app',
     'runningTag': None,
     'tagMutable': False,
     'rollbackTag': 'prod-prv',
     'driverFile': '/devops/prod/release_config_saleor_apps.json',
     'driverServiceName': 'search-app',
     'steps': [{'stepId': 'tag',
                'order': 1,
                'kind': 'tag',
                'title': 'Build the image and promote it to production',
                'plain': 'Builds the application and points the production tag at it. Refuses to run '
                         'if the version in the settings file already exists in the registry.',
                'project': 'ECom',
                'definitionId': 37,
                'definitionName': 'CD-Ecom-Search-App',
                'stage': 'PROD_TAG',
                'approval': {'manual': True,
                             'timeoutMinutes': 1,
                             'approver': '[ECom]\\DevOps Approver'},
                'pins': [{'alias': '_CI-Ecom-Search-app', 'type': 'Build', 'choose': 'user'},
                         {'alias': '_ecom',
                          'type': 'Git',
                          'choose': 'branch-head',
                          'branch': 'master'}],
                'duplicateTagGuard': True,
                'writes': {'registryTags': ['ecom-search-app:<version>', 'ecom-search-app:prod']},
                'verifyBy': {'logTask': 'Tagging Image', 'expect': '--image ecom-search-app:prod'}},
               {'stepId': 'deploy',
                'order': 2,
                'kind': 'deploy',
                'title': 'Restart the service on the new image',
                'plain': 'Applies the Kubernetes file so the pods pull the new version.',
                'project': 'ECom',
                'definitionId': 2,
                'definitionName': 'Production-Release-Saleor-Apps',
                'stage': 'PROD',
                'approval': {'manual': True,
                             'timeoutMinutes': None,
                             'approver': '[ECom]\\DevOps Approver'},
                'pins': [{'alias': '_ecom',
                          'type': 'Git',
                          'choose': 'branch-head',
                          'branch': 'master'}],
                'writes': {'namespaces': ['saleor-apps']},
                'verifyBy': {'logTask': None, 'expect': 'Applying deployment for search-app'}}],
     'knownProblems': [],
     'confidence': {'steps': 'verified',
                    'pins': 'verified',
                    'deployApprovalTimeout': 'inferred, not read from the definition'}},

    ("magrabi-storefront", "BETA"): {'appKey': 'magrabi-storefront',
     'tier': 'BETA',
     'displayName': 'Magrabi Storefront (Beta)',
     'project': 'ECom',
     'cluster': 'aks-ecom-prod-uaenorth-001',
     'namespaces': ['storefront-beta'],
     'workloads': [{'name': 'storefront', 'replicas': 1},
                   {'name': 'storefront-checkout', 'replicas': 1}],
     'registry': 'crmepuproduaenorth001',
     'imageRepo': 'magrabi-storefront',
     'runningTag': 'beta',
     'tagMutable': True,
     'rollbackTag': 'beta-prv',
     'rollbackTagUsable': False,
     'driverFile': '/devops/prod/release_config_beta_storefront.json',
     'driverServiceName': 'magrabi-storefront-beta',
     'driverServiceNamesAll': ['magrabi-storefront-beta', 'magrabi-storefront-checkout-beta'],
     'steps': [{'stepId': 'driver-check',
                'order': 1,
                'kind': 'edit',
                'title': 'Check the driver file - do not change the version',
                'plain': 'Open release_config_beta_storefront.json on master and confirm the two '
                         'magrabi- rows still say deploy true. Leave version set to the word beta. '
                         'It is not a version number and it must never be bumped.',
                'project': 'ECom',
                'repo': 'ecom',
                'repositoryId': 'd57e35b2-f3f5-4783-b8dc-7662730e1ad2',
                'path': '/devops/prod/release_config_beta_storefront.json',
                'branch': 'master',
                'reads': {'driverFile': '/devops/prod/release_config_beta_storefront.json',
                          'field': 'deploy',
                          'services': ['magrabi-storefront-beta',
                                       'magrabi-storefront-checkout-beta']},
                'currentValues': {'magrabi-storefront-beta': {'version': 'beta', 'deploy': 'true'},
                                  'magrabi-storefront-checkout-beta': {'version': 'beta',
                                                                       'deploy': 'true'}},
                'hazards': ['version-is-a-literal-not-a-number', 'shared-file-also-drives-doctorm']},
               {'stepId': 'unlock-beta',
                'order': 2,
                'kind': 'manual',
                'title': 'Unlock the beta image tag in the registry',
                'plain': 'Every successful run of the tagging stage ends by write-locking '
                         'magrabi-storefront:beta, and the next run has nothing that unlocks it '
                         'before it pushes. So the push fails unless somebody unlocks the tag by '
                         'hand first. Check it, and unlock it if it is locked.',
                'checkCommand': 'az acr repository show --name crmepuproduaenorth001 --image '
                                'magrabi-storefront:beta',
                'unlockCommand': 'az acr repository update --name crmepuproduaenorth001 --image '
                                 'magrabi-storefront:beta --write-enabled true',
                'requiredWhen': 'changeableAttributes.writeEnabled == false',
                'observedOn': '2026-08-27',
                'observedState': 'writeEnabled=false (locked) - a run started now would fail at Push',
                'portalMayStart': False,
                'blockedReason': 'Mutates the production container registry. The portal may read and '
                                 'display the tag state, but the unlock must be issued by a person.',
                'hazards': ['push-fails-with-disallowed-operation-if-locked']},
               {'stepId': 'tag',
                'order': 3,
                'kind': 'tag',
                'title': 'Build the beta image and move the beta tag onto it',
                'plain': 'Builds the storefront from the chosen CI build and pushes it over the beta '
                         'tag in the production registry. It does not create a new version number - '
                         'it overwrites beta in place.',
                'project': 'ECom',
                'definitionId': 41,
                'definitionName': 'CD-Magrabi-Storefront',
                'stage': 'BETA_TAG',
                'stageTrigger': 'manual-only',
                'approval': {'manual': True,
                             'timeoutMinutes': 1,
                             'approver': '[ECom]\\DevOps Approver',
                             'releaseCreatorCanBeApprover': True},
                'pins': [{'alias': '_CI-Magrabi-Storefront',
                          'type': 'Build',
                          'choose': 'user',
                          'requireBranch': None,
                          'definitionId': 74,
                          'definitionName': 'CI-Magrabi-Storefront',
                          'artifactDefaultVersionType': 'latestType',
                          'note': 'No branch filter on this artifact and no branch condition on the '
                                  'stage. Left on its default it takes the newest CI build from ANY '
                                  'branch - release 9069 put refs/heads/feature/perf-journey-logging '
                                  '(build 16440) onto beta. Always pin the build by hand.'},
                         {'alias': '_ecom',
                          'type': 'Git',
                          'choose': 'branch-head',
                          'branch': 'master'}],
                'enabledTasks': ['Check Version', 'build', 'Push', 'Tagging Image'],
                'disabledTasks': ['Release Version Extract', 'build copy'],
                'reads': {'driverFile': '/devops/prod/release_config_beta_storefront.json',
                          'field': 'version',
                          'service': 'magrabi-storefront-beta',
                          'alwaysResolvesTo': 'beta'},
                'writes': {'registryTags': ['magrabi-storefront:beta',
                                            'magrabi-storefront:beta-prv']},
                'verifyBy': {'logTask': 'Push', 'expect': 'beta: digest: sha256:'},
                'verifyAlso': {'logTask': 'Tagging Image',
                               'expect': 'az acr repository update --name crmepuproduaenorth001 '
                                         '--image magrabi-storefront:beta --write-enabled false'},
                'buildTargets': {'BASE_URL': 'https://beta.magrabi.com',
                                 'API_HOST': 'https://ecom-graphql-cache.magrabi.com',
                                 'note': 'Front end is beta, back ends are live production.'},
                'hazards': ['no-tag-exists-guard',
                            'rollback-snapshot-taken-after-push',
                            'leaves-beta-tag-locked',
                            'ci-artifact-has-no-branch-filter',
                            'one-minute-approval',
                            'builds-against-production-backends']},
               {'stepId': 'deploy',
                'order': 4,
                'kind': 'deploy',
                'title': 'Roll the beta pods onto the new image',
                'plain': 'Applies the two Magrabi beta deployment files to the production cluster. '
                         'The image line already says beta, so what actually forces the pods to '
                         'restart is a fresh date stamp written into the file at deploy time.',
                'project': 'ECom',
                'definitionId': 70,
                'definitionName': 'Production-Release-Storefront-BETA',
                'stage': 'BETA PROD',
                'stageTrigger': 'ReleaseStarted',
                'approval': {'manual': True,
                             'timeoutMinutes': 0,
                             'approver': '[ECom]\\DevOps Approver',
                             'releaseCreatorCanBeApprover': True,
                             'note': '0 means the Azure DevOps default, not one minute. Unlike def '
                                     '41 this approval does not expire almost immediately.'},
                'pins': [{'alias': '_ecom',
                          'type': 'Git',
                          'choose': 'branch-head',
                          'branch': 'master'}],
                'taskForThisApp': 'Deploy Magrabi SF',
                'reads': {'driverFile': '/devops/prod/release_config_beta_storefront.json',
                          'fields': ['name', 'yaml', 'version', 'deploy']},
                'applies': ['/devops/prod/k8/beta/deployments/storefront-deployment.yml',
                            '/devops/prod/k8/beta/deployments/storefront-checkout-deployment.yml'],
                'writes': {'kubernetes': ['deployment/storefront -n storefront-beta',
                                          'deployment/storefront-checkout -n storefront-beta']},
                'verifyBy': {'logTask': 'Deploy Magrabi SF',
                             'expect': 'deployment.apps/storefront configured'},
                'hazards': ['runs-against-production-cluster',
                            'same-run-also-executes-the-doctorm-task',
                            'rollout-triggered-only-by-date-stamp']}],
     'knownProblems': ['beta has no working rollback point. Tagging Image copies beta into beta-prv '
                       'AFTER Push has already overwritten beta, so beta-prv ends up holding the '
                       'image that was just built, not the previous one. Verified on release 9069: '
                       'Push wrote sha256:138cb1f8...; the beta-prv snapshot taken seconds later '
                       'reported that same digest; both tags read sha256:138cb1f8... live today. '
                       'Rolling back to beta-prv would redeploy the identical image.',
                       'The stage leaves magrabi-storefront:beta write-locked and nothing unlocks it '
                       'before the next Push. The only unlock anywhere in the ECom/Macula release '
                       'estate sits inside Tagging Image, which runs after Push. Release 8966 '
                       "attempt 1 died at Push with 'unknown: The operation is disallowed on this "
                       "registry, repository or image'; a retry minutes later succeeded, so the tag "
                       'was unlocked out of band in between. The tag is locked right now.',
                       "Check Version in BETA_TAG has no 'image tag already exists' guard at all - "
                       'the script ends at the setvariable line. That is load-bearing, not an '
                       'oversight: version is the literal string beta, so beta always exists after '
                       'the first run and an active guard would fail every subsequent run. The same '
                       'guard sits commented out in the PROD_TAG copy of the script. Do not restore '
                       'it.',
                       'Because the version never changes, nothing in the pipeline records which '
                       'build is on beta. The image tag, the driver file and the releaseId '
                       'annotation all just say beta. The only trace is the release record and the '
                       'pod deploy date stamp.',
                       'The CI artifact on def 41 has no branch filter and defaults to Latest, so an '
                       'unpinned run can ship a feature branch to beta - release 9069 did exactly '
                       'that.',
                       'Beta is built against production back ends and runs on the production '
                       'cluster in namespace storefront-beta. It is not an isolated environment.',
                       'def 70 runs both brand tasks in one release. Starting it for Magrabi also '
                       'evaluates DoctorM; that is a no-op today only because the DoctorM deploy '
                       'flags are false.'],
     'confidence': {'steps': 'verified',
                    'pins': 'verified',
                    'workloads': 'verified',
                    'tagLockBehaviour': 'verified',
                    'rollbackOrdering': 'verified',
                    'tagExistsGuard': 'verified',
                    'whoUnlocksTheTagBetweenRuns': 'inferred',
                    'source': 'authored and cross-verified 2026-08-27 by two independent passes '
                              'against the live definitions'},
     'repoId': 'd57e35b2-f3f5-4783-b8dc-7662730e1ad2',
     'branch': 'master'},

    ("magrabi-storefront", "PROD"): {'appKey': 'magrabi-storefront',
     'tier': 'PROD',
     'displayName': 'Magrabi Storefront',
     'project': 'ECom',
     'cluster': 'aks-ecom-prod-uaenorth-001',
     'namespaces': ['ecom'],
     'resourceGroup': 'rg-mepu-prod-uaenorth-001',
     'workloads': [{'name': 'storefront',
                    'replicas': 4,
                    'liveReplicas': 18,
                    'hpa': {'name': 'storefront-hpa', 'min': 4, 'max': 120},
                    'yaml': 'k8/deployments/storefront-deployment.yml',
                    'driverEntry': 'magrabi-storefront'},
                   {'name': 'storefront-checkout',
                    'replicas': 2,
                    'liveReplicas': 2,
                    'hpa': {'name': 'storefront-checkout-hpa', 'min': 2, 'max': 10},
                    'yaml': 'k8/deployments/storefront-checkout-deployment.yml',
                    'driverEntry': 'magrabi-storefront-checkout'},
                   {'name': 'storefront-profile',
                    'replicas': 2,
                    'liveReplicas': 2,
                    'hpa': None,
                    'yaml': 'k8/deployments/storefront-profile-deployment.yml',
                    'driverEntry': 'magrabi-storefront-profile'},
                   {'name': 'storefront-preview',
                    'replicas': 1,
                    'liveReplicas': 1,
                    'hpa': None,
                    'healthy': False,
                    'yaml': 'k8/deployments/storefront-preview-deployment.yml',
                    'driverEntry': 'magrabi-storefront-preview',
                    'note': 'Different image repo (magrabi-storefront-preview). Currently '
                            'ImagePullBackOff. Leave its deploy flag at false.'}],
     'registry': 'crmepuproduaenorth001',
     'imageRepo': 'magrabi-storefront',
     'runningTag': 'master',
     'tagMutable': True,
     'rollbackTag': 'prod-prv',
     'archiveTag': 'prod',
     'driverFile': '/devops/prod/release_config_magrabi_sf.json',
     'driverServiceName': 'magrabi-storefront',
     'driverRepo': {'project': 'ECom',
                    'repo': 'ecom',
                    'repositoryId': 'd57e35b2-f3f5-4783-b8dc-7662730e1ad2',
                    'branch': 'master'},
     'driverCurrentContents': [{'name': 'magrabi-storefront',
                                'yaml': 'storefront-deployment.yml',
                                'version': 'master',
                                'deploy': 'false'},
                               {'name': 'magrabi-storefront-preview',
                                'yaml': 'storefront-preview-deployment.yml',
                                'version': 'master',
                                'deploy': 'false'},
                               {'name': 'magrabi-storefront-checkout',
                                'yaml': 'storefront-checkout-deployment.yml',
                                'version': 'master',
                                'deploy': 'false'},
                               {'name': 'magrabi-storefront-profile',
                                'yaml': 'storefront-profile-deployment.yml',
                                'version': 'master',
                                'deploy': 'false'}],
     'driverContentsReadAt': '2026-08-27, master head commit d4ad7cb5',
     'steps': [{'stepId': 'ci-build',
                'order': 1,
                'kind': 'external',
                'title': 'Build the code on the branch you are shipping',
                'plain': 'Someone has to start a build of the storefront code first, choosing the '
                         'branch that is going live. It never starts on its own, and it has to '
                         'finish before the later steps can use it.',
                'project': 'ECom',
                'definitionId': 74,
                'definitionName': 'CI-Magrabi-Storefront',
                'definitionType': 'build',
                'definitionPath': '\\storefront',
                'sourceRepo': 'GitHub Magrabi-digital/magrabi-storefront',
                'stage': None,
                'approval': None,
                'pins': [],
                'reads': {},
                'writes': {'pipelineArtifact': 'magrabi-storefront'},
                'verifyBy': {'logTask': 'Publish Pipeline Artifact',
                             'expect': 'The build succeeds and publishes the artifact named '
                                       'magrabi-storefront. Note its build number and source branch, '
                                       'you need both in step 3.'},
                'hazards': ['no-ci-trigger-must-be-queued-by-hand', 'pick-the-right-branch'],
                'portalMayStart': False,
                'blockedReason': 'A build pipeline on a GitHub repo, queued by hand against a chosen '
                                 'branch. Which branch ships is a human decision outside the release '
                                 'flow.'},
               {'stepId': 'driver-enable',
                'order': 2,
                'kind': 'edit',
                'title': 'Turn the Magrabi entries on in the release config file',
                'plain': 'The deploy pipeline only touches the parts that are switched on in one '
                         'small settings file. Right now every Magrabi entry is switched off, so you '
                         'have to switch on the ones you want updated and save that change to the '
                         'master branch.',
                'project': 'ECom',
                'definitionId': None,
                'definitionName': None,
                'stage': None,
                'approval': None,
                'pins': [],
                'reads': {'driverFile': '/devops/prod/release_config_magrabi_sf.json'},
                'writes': {'gitFile': '/devops/prod/release_config_magrabi_sf.json',
                           'branch': 'master',
                           'field': 'deploy',
                           'from': 'false',
                           'to': 'true',
                           'entries': ['magrabi-storefront',
                                       'magrabi-storefront-checkout',
                                       'magrabi-storefront-profile'],
                           'leaveOff': ['magrabi-storefront-preview'],
                           'doNotChange': {'version': 'master'}},
                'verifyBy': {'logTask': None,
                             'expect': 'A new commit on master of the ecom repo touching '
                                       '/devops/prod/release_config_magrabi_sf.json, with deploy set '
                                       'to true on the intended entries and version still master. '
                                       'Record that commit id.'},
                'hazards': ['all-four-entries-are-off-today',
                            'leave-preview-off',
                            'commit-must-land-before-the-step-4-release-is-created'],
                'portalMayStart': False,
                'blockedReason': 'A hand edit and commit to master of the ecom Git repo, not a '
                                 'pipeline run. Which entries go on decides what production gets.'},
               {'stepId': 'tag',
                'order': 3,
                'kind': 'tag',
                'title': "Build the production image and move production's tag onto it",
                'plain': 'This makes the real production image and puts the production label on it, '
                         'keeping the label from the last release as a spare. Nothing that is '
                         'running changes yet.',
                'project': 'ECom',
                'definitionId': 41,
                'definitionName': 'CD-Magrabi-Storefront',
                'definitionType': 'release',
                'definitionPath': '\\storefront',
                'stage': 'PROD_TAG',
                'stageDefinitionId': 116,
                'agent': {'pool': 'Azure Pipelines', 'queueId': 18, 'image': 'ubuntu-24.04'},
                'approval': {'manual': True,
                             'timeoutMinutes': 1,
                             'approver': '[ECom]\\DevOps Approver',
                             'requiredApproverCount': None,
                             'releaseCreatorCanBeApprover': True,
                             'executionOrder': 'beforeGates',
                             'gates': []},
                'pins': [{'alias': '_CI-Magrabi-Storefront',
                          'type': 'Build',
                          'choose': 'user',
                          'sourceDefinitionId': 74,
                          'sourceDefinitionName': 'CI-Magrabi-Storefront',
                          'requireBranch': None,
                          'branchRule': 'The build from step 1, produced from the branch being '
                                        'shipped. Recent production runs used refs/heads/master and '
                                        'refs/heads/release/<date>. Nothing in the definition '
                                        "enforces this, so check the build's source branch by hand.",
                          'defaultIfNotPinned': 'latestType, newest build on definition 74 '
                                                'regardless of branch. Never accept this default.'},
                         {'alias': '_ecom',
                          'type': 'Git',
                          'choose': 'branch-head',
                          'branch': 'master',
                          'repositoryId': 'd57e35b2-f3f5-4783-b8dc-7662730e1ad2',
                          'defaultIfNotPinned': 'latestFromBranchType on master',
                          'note': 'This stage only reads the version field, which is always master, '
                                  'so branch head is safe here. Record the commit it resolves to and '
                                  'reuse it in step 4.'}],
                'reads': {'driverFile': '/devops/prod/release_config_magrabi_sf.json',
                          'field': 'version',
                          'currentValue': 'master',
                          'workingDirectory': '$(System.DefaultWorkingDirectory)/_ecom/devops/prod'},
                'writes': {'registryTags': ['magrabi-storefront:master',
                                            'magrabi-storefront:prod-prv',
                                            'magrabi-storefront:prod'],
                           'registry': 'crmepuproduaenorth001',
                           'order': 'current prod is copied to prod-prv, then master is copied onto '
                                    'prod'},
                'tasks': ['Check Version', 'build', 'Push', 'Tagging Image'],
                'verifyBy': {'logTask': 'Tagging Image',
                             'expect': '+ az acr import --name crmepuproduaenorth001 --source '
                                       'crmepuproduaenorth001.azurecr.io/magrabi-storefront:master '
                                       '--force --image magrabi-storefront:prod',
                             'additionalChecks': [{'logTask': 'Check Version',
                                                   'expect': '+ RELEASE_VERSION=master'},
                                                  {'logTask': 'Push',
                                                   'expect': '[command]/usr/bin/docker push '
                                                             'crmepuproduaenorth001.azurecr.io/magrabi-storefront:master'},
                                                  {'logTask': 'Tagging Image',
                                                   'expect': '+ az acr import --name '
                                                             'crmepuproduaenorth001 --source '
                                                             'crmepuproduaenorth001.azurecr.io/magrabi-storefront:prod '
                                                             '--force --image '
                                                             'magrabi-storefront:prod-prv'}],
                             'afterwards': 'az acr repository show-tags --name crmepuproduaenorth001 '
                                           '--repository magrabi-storefront --detail : master and '
                                           'prod must share one digest, prod-prv holds the previous '
                                           'one.'},
                'hazards': ['one-minute-approval',
                            'duplicate-tag-guard-disabled',
                            'mutable-master-tag',
                            'rollback-is-only-one-release-deep',
                            'artifact-default-is-latest-build']},
               {'stepId': 'deploy',
                'order': 4,
                'kind': 'deploy',
                'title': 'Apply the Kubernetes files so production picks up the new image',
                'plain': 'This is the step that actually changes the live site. It reads the '
                         'settings file and, for every entry switched on, pushes the matching '
                         'Kubernetes file to the production cluster so the pods restart on the new '
                         'image.',
                'project': 'ECom',
                'definitionId': 24,
                'definitionName': 'Production-Release-Storefront',
                'definitionType': 'release',
                'definitionPath': '\\prod_release',
                'stage': 'PROD',
                'stageDefinitionId': 46,
                'agent': {'pool': 'Azure Pipelines', 'queueId': 18, 'image': 'ubuntu-24.04'},
                'approval': {'manual': True,
                             'timeoutMinutes': 60,
                             'approver': '[ECom]\\DevOps Approver',
                             'requiredApproverCount': 1,
                             'releaseCreatorCanBeApprover': True,
                             'executionOrder': 'beforeGates',
                             'gates': []},
                'pins': [{'alias': '_ecom',
                          'type': 'Git',
                          'choose': 'commit',
                          'branch': 'master',
                          'repositoryId': 'd57e35b2-f3f5-4783-b8dc-7662730e1ad2',
                          'requireCommitAtOrAfter': 'the commit made in step 2',
                          'defaultIfNotPinned': 'latestFromBranchType on master',
                          'note': 'The only artifact on definition 24. If the release is created '
                                  'before the step 2 commit lands on master, the stage silently '
                                  'skips every Magrabi entry and reports success.'}],
                'stageVariables': {'CLUSTER_NAME': 'aks-ecom-prod-uaenorth-001',
                                   'RG_NAME': 'rg-mepu-prod-uaenorth-001',
                                   'MAGRABI_JSON_FILE': 'release_config_magrabi_sf.json',
                                   'DOCTORM_JSON_FILE': 'release_config_doctorm_sf.json '
                                                        '(definition-level variable)'},
                'reads': {'driverFile': '/devops/prod/release_config_magrabi_sf.json',
                          'fields': ['name', 'yaml', 'version', 'deploy'],
                          'workingDirectory': '$(System.DefaultWorkingDirectory)/_ecom/devops/prod',
                          'yamlDirectory': 'k8/deployments/'},
                'writes': {'kubernetes': ['deployment/storefront -n ecom',
                                          'deployment/storefront-checkout -n ecom',
                                          'deployment/storefront-profile -n ecom'],
                           'imageApplied': 'crmepuproduaenorth001.azurecr.io/magrabi-storefront:master',
                           'rolloutTrigger': 'the env var AKS_UNIQUE_KEY_DEPLOY_DATE is stamped with '
                                             'the run time, which forces new pods even though the '
                                             'image tag text is unchanged'},
                'tasks': ['Deploy Magrabi SF', 'Deploy DoctorM SF'],
                'verifyBy': {'logTask': 'Deploy Magrabi SF',
                             'expect': 'Applying deployment for magrabi-storefront using '
                                       'k8/deployments/storefront-deployment.yml ... '
                                       'deployment.apps/storefront configured',
                             'additionalChecks': [{'logTask': 'Deploy Magrabi SF',
                                                   'expect': 'deployment.apps/storefront-checkout '
                                                             'configured'},
                                                  {'logTask': 'Deploy Magrabi SF',
                                                   'expect': 'deployment.apps/storefront-profile '
                                                             'configured'},
                                                  {'logTask': 'Deploy Magrabi SF',
                                                   'expect': 'image: '
                                                             'crmepuproduaenorth001.azurecr.io/magrabi-storefront:master'}],
                             'failureSignature': 'Skipping deployment for magrabi-storefront (deploy '
                                                 'flag is set to false) means step 2 was missed, or '
                                                 'the pinned _ecom commit predates it.',
                             'afterwards': 'kubectl -n ecom get deploy storefront -o '
                                           'jsonpath={.spec.template.spec.containers[0].image} and '
                                           'compare the running pod digest with the master tag in '
                                           'the registry.'},
                'hazards': ['this-stage-also-deploys-doctorm',
                            'apply-resets-replicas-to-4',
                            'storefront-preview-entry-breaks-if-switched-on',
                            'sixty-minute-approval']},
               {'stepId': 'driver-disable',
                'order': 5,
                'kind': 'edit',
                'title': 'Switch the Magrabi entries back off',
                'plain': 'Put the settings file back the way it was, with the Magrabi entries '
                         'switched off, so the next DoctorM-only release does not restart Magrabi as '
                         'well.',
                'project': 'ECom',
                'definitionId': None,
                'definitionName': None,
                'stage': None,
                'approval': None,
                'pins': [],
                'reads': {'driverFile': '/devops/prod/release_config_magrabi_sf.json'},
                'writes': {'gitFile': '/devops/prod/release_config_magrabi_sf.json',
                           'branch': 'master',
                           'field': 'deploy',
                           'from': 'true',
                           'to': 'false',
                           'entries': ['magrabi-storefront',
                                       'magrabi-storefront-preview',
                                       'magrabi-storefront-checkout',
                                       'magrabi-storefront-profile']},
                'verifyBy': {'logTask': None,
                             'expect': 'A follow-up commit on master returning every deploy value in '
                                       'the file to false. Example pairs: 2470c3c9 on then d4ad7cb5 '
                                       'off, aa66bcf2 on then cdbc4b67 off.'},
                'hazards': ['easy-to-forget'],
                'portalMayStart': False,
                'blockedReason': 'A hand edit and commit to master, not a pipeline run.'}],
     'knownProblems': ['Every Magrabi entry in the driver file is deploy=false as of master head '
                       'd4ad7cb5 (2026-08-26 13:19). Running definition 24 today logs Skipping '
                       'deployment four times and changes nothing for Magrabi.',
                       'The DoctorM driver file is currently deploy=true for three entries, and '
                       'definition 24 PROD runs both brands in one stage. Any Magrabi deploy today '
                       'also restarts doctorm-sf, doctorm-sf-browse-ae and doctorm-sf-checkout.',
                       'storefront-deployment.yml declares replicas: 4 but the HPA has the fleet at '
                       '18 live. kubectl apply writes 4 back, so the deploy drops the fleet to 4 '
                       'pods until the HPA scales it up again. Verified: last-applied-configuration '
                       'says 4, spec.replicas says 18.',
                       'The duplicate-image-tag guard in the Check Version task is commented out in '
                       'the definition, so nothing stops the same tag being rebuilt and overwritten.',
                       'The cluster runs the mutable tag magrabi-storefront:master, not :prod. The '
                       ':prod and :prod-prv tags are write-locked archive pointers. A rollback means '
                       'editing the driver version field to prod-prv, or re-importing prod-prv over '
                       'master. No release in the retained history has done this.',
                       'Rollback is only one release deep. The next PROD_TAG run overwrites prod-prv '
                       'with the current prod.',
                       'The magrabi-storefront-preview entry points at '
                       'magrabi-storefront-preview:master, which does not exist in '
                       'crmepuproduaenorth001 (only prod, prod-prv, 2.0.0, 1.12.3). '
                       'deployment/storefront-preview in namespace ecom has been in ImagePullBackOff '
                       'for over a day. Definition 41 PROD_TAG never builds or tags that repo.',
                       'The PROD_TAG approval times out after 1 minute. Real releases have been '
                       'auto-rejected by it: deployment 15286 on release 8755, deployment 15119 on '
                       'release 8674. Have an approver waiting before starting the stage.',
                       "Definition 41's build artifact defaults to Latest. The newest build on "
                       'definition 74 right now is 16440 from '
                       'refs/heads/feature/perf-journey-logging, so an unpinned release would tag a '
                       'feature branch into production.',
                       'Definition 24 PROD retains only 3 releases / 30 days, so older deploy logs '
                       'disappear quickly.'],
     'confidence': {'steps': 'verified',
                    'pins': 'verified',
                    'approval': 'verified',
                    'definitions': 'verified',
                    'stages': 'verified',
                    'driverFile': 'verified',
                    'driverContents': 'verified',
                    'registry': 'verified',
                    'imageTags': 'verified',
                    'runningTag': 'verified',
                    'rollbackTag': 'verified',
                    'namespaces': 'verified',
                    'workloads': 'verified',
                    'replicas': 'verified: replicas is the manifest value the deploy applies; '
                                'liveReplicas read from the cluster on 2026-08-27 and moves with the '
                                'HPA',
                    'verifyBy': 'verified, log text quoted from release 9052 stage PROD_TAG and '
                                'release 9065 stage PROD',
                    'rollbackProcedure': 'inferred. The pipeline writes prod-prv, but no release in '
                                         'the retained history consumes it. Confirming needs a '
                                         'DevOps statement or one observed rollback.',
                    'ciBuildStep': 'verified that definition 74 has no CI trigger and must be queued '
                                   "by hand; inferred that queueing it is always the human's first "
                                   'move rather than reusing an existing build',
                    'driverDisableStep': 'verified as the observed pattern, six of six recent commit '
                                         'pairs alternate on then off; inferred that it is a '
                                         'required rule rather than a habit',
                    'source': 'authored and cross-verified 2026-08-27 by two independent passes '
                              'against the live definitions'},
     'repoId': 'd57e35b2-f3f5-4783-b8dc-7662730e1ad2',
     'branch': 'master'},

    ("saleor-core", "PROD"): {'appKey': 'saleor-core',
     'tier': 'PROD',
     'displayName': 'Saleor Core',
     'project': 'ECom',
     'cluster': 'aks-ecom-prod-uaenorth-001',
     'namespaces': ['saleor'],
     'workloads': [{'name': 'saleor-dashboard',
                    'replicas': 1,
                    'replicasLive': 1,
                    'deploymentFile': '/devops/prod/k8/deployments/saleor-dashboard-deployment.yml',
                    'imageRepo': 'ecom-dashboard',
                    'hpa': None,
                    'readsConfigMap': False,
                    'readsSecret': False,
                    'taggedBy': 33},
                   {'name': 'saleor-admin-api',
                    'replicas': 1,
                    'replicasLive': 10,
                    'deploymentFile': '/devops/prod/k8/deployments/saleor-admin-api-deployment.yml',
                    'imageRepo': 'ecom-app-api',
                    'hpa': {'name': 'saleor-admin-api-hpa', 'min': 1, 'max': 10},
                    'readsConfigMap': True,
                    'readsSecret': True,
                    'taggedBy': 34},
                   {'name': 'saleor-app-api',
                    'replicas': 3,
                    'replicasLive': 2,
                    'deploymentFile': '/devops/prod/k8/deployments/saleor-app-api-deployment.yml',
                    'imageRepo': 'ecom-app-api',
                    'hpa': {'name': 'saleor-app-api-hpa', 'min': 2, 'max': 15},
                    'readsConfigMap': True,
                    'readsSecret': True,
                    'taggedBy': 34},
                   {'name': 'saleor-validator-api',
                    'replicas': 6,
                    'replicasLive': 7,
                    'deploymentFile': '/devops/prod/k8/deployments/saleor-validator-api-deployment.yml',
                    'imageRepo': 'ecom-app-api',
                    'hpa': {'name': 'saleor-validator-api-hpa', 'min': 7, 'max': 20},
                    'readsConfigMap': True,
                    'readsSecret': True,
                    'taggedBy': 34},
                   {'name': 'saleor-checkout-api',
                    'replicas': 2,
                    'replicasLive': 4,
                    'deploymentFile': '/devops/prod/k8/deployments/saleor-checkout-api-deployment.yml',
                    'imageRepo': 'ecom-app-api',
                    'hpa': {'name': 'saleor-checkout-api-hpa', 'min': 4, 'max': 20},
                    'readsConfigMap': True,
                    'readsSecret': True,
                    'taggedBy': 34},
                   {'name': 'saleor-worker-1',
                    'replicas': 1,
                    'replicasLive': 1,
                    'deploymentFile': '/devops/prod/k8/deployments/saleor-worker-1-deployment.yml',
                    'imageRepo': 'ecom-app-api',
                    'hpa': None,
                    'readsConfigMap': True,
                    'readsSecret': True,
                    'taggedBy': 34},
                   {'name': 'saleor-worker-2',
                    'replicas': 1,
                    'replicasLive': 1,
                    'deploymentFile': '/devops/prod/k8/deployments/saleor-worker-2-deployment.yml',
                    'imageRepo': 'ecom-app-api',
                    'hpa': None,
                    'readsConfigMap': True,
                    'readsSecret': True,
                    'taggedBy': 34},
                   {'name': 'saleor-worker-3',
                    'replicas': 1,
                    'replicasLive': 1,
                    'deploymentFile': '/devops/prod/k8/deployments/saleor-worker-3-deployment.yml',
                    'imageRepo': 'ecom-app-api',
                    'hpa': None,
                    'readsConfigMap': True,
                    'readsSecret': True,
                    'taggedBy': 34}],
     'workloadsNotDeployed': [{'name': 'saleor-profile-api',
                               'driverVersion': '2.0.1',
                               'deploy': False,
                               'deploymentFile': None,
                               'replicasLive': 0,
                               'note': 'saleor-profile-api-deployment.yml is ABSENT from '
                                       '/devops/prod/k8/deployments/. Flipping deploy to true would '
                                       'fail the step with file-not-found.'}],
     'registry': 'crmepuproduaenorth001',
     'imageRepo': 'ecom-app-api',
     'imageRepoSecondary': 'ecom-dashboard',
     'runningTag': 'master',
     'tagMutable': True,
     'rollbackTag': 'prod-prv',
     'driverFile': '/devops/prod/release_config_saleor.json',
     'driverServiceName': 'saleor-app-api',
     'configMapFile': '/devops/prod/k8/configmaps/saleor-core-config.yml',
     'configMapName': 'saleor-core-config',
     'secretFile': '/devops/prod/k8/secrets/saleor-core-secret.yml',
     'secretName': 'saleor-core-secret',
     'steps': [{'stepId': 'configmap',
                'order': 1,
                'kind': 'config',
                'title': 'Put the new settings on the cluster',
                'plain': 'Copies the settings file into production. Nothing changes yet - the '
                         'running programs keep using the old settings until step 5 restarts them. '
                         'Skip this step only if you changed no settings this release.',
                'conditional': 'Run only when saleor-core-config.yml changed in this release.',
                'project': 'ECom',
                'definitionId': 56,
                'definitionName': 'CD-ConfigMap-Saleor-Core',
                'stage': 'PROD',
                'approval': {'manual': True,
                             'timeoutMinutes': 1,
                             'approver': '[ECom]\\DevOps Approver'},
                'pins': [{'alias': '_ecom',
                          'type': 'Git',
                          'choose': 'user',
                          'requireBranch': 'master',
                          'note': "Definition default is 'Latest from the default branch'. Pin the "
                                  'exact commit and use the SAME commit for steps 1, 2 and 5.'}],
                'reads': {'file': '/devops/prod/k8/configmaps/saleor-core-config.yml'},
                'writes': {'kubernetes': ['configmap/saleor-core-config in namespace saleor']},
                'target': {'cluster': 'aks-ecom-prod-uaenorth-001',
                           'resourceGroup': 'rg-mepu-prod-uaenorth-001',
                           'namespace': 'saleor'},
                'verifyBy': {'logTask': 'saleor-core-config-map',
                             'expect': 'kubectl apply -f '
                                       '.../devops/prod/k8/configmaps/saleor-core-config.yml against '
                                       'aks-ecom-prod-uaenorth-001, namespace saleor'},
                'hazards': ['one-minute-approval-auto-rejects',
                            'stage-variables-say-dev-but-are-unused',
                            'configmap-alone-is-a-no-op']},
               {'stepId': 'secret',
                'order': 2,
                'kind': 'config',
                'title': 'Put the new passwords and keys on the cluster',
                'plain': 'Copies the file of passwords, database addresses and API keys into '
                         'production. Like step 1, nothing changes until the programs are restarted '
                         'in step 5. Run this only when one of those values actually changed - it '
                         'has been run once since October 2025.',
                'conditional': 'Run only when saleor-core-secret.yml changed in this release.',
                'project': 'ECom',
                'definitionId': 58,
                'definitionName': 'CD-Secret-Saleor-Core',
                'stage': 'PROD',
                'approval': {'manual': True,
                             'timeoutMinutes': 1,
                             'approver': '[ECom]\\DevOps Approver'},
                'pins': [{'alias': '_ecom',
                          'type': 'Git',
                          'choose': 'user',
                          'requireBranch': 'master',
                          'note': 'Same commit as steps 1 and 5.'}],
                'reads': {'file': '/devops/prod/k8/secrets/saleor-core-secret.yml'},
                'writes': {'kubernetes': ['secret/saleor-core-secret in namespace saleor']},
                'target': {'cluster': 'aks-ecom-prod-uaenorth-001',
                           'resourceGroup': 'rg-mepu-prod-uaenorth-001',
                           'namespace': 'saleor'},
                'verifyBy': {'logTask': 'saleor-core-secret',
                             'expect': 'kubectl apply -f '
                                       '.../devops/prod/k8/secrets/saleor-core-secret.yml against '
                                       'aks-ecom-prod-uaenorth-001, namespace saleor'},
                'portalMayStart': False,
                'blockedReason': 'Applies 17 credential keys that 7 of the 8 workloads consume '
                                 "through non-optional secretKeyRef. The file's own header warns "
                                 'that stringData must be plaintext - a base64-encoded value is '
                                 'stored verbatim and every worker crashes on an empty DATABASE_URL '
                                 'or an invalid Redis URL. It also cannot be rehearsed: this '
                                 "definition's DEV/SIT/UAT stages apply a different file entirely "
                                 '(see knownProblems). A human must eyeball the file before it '
                                 'reaches production.',
                'hazards': ['one-minute-approval-auto-rejects',
                            'lower-stages-apply-a-different-file',
                            'stringData-must-be-plaintext',
                            'run-once-since-2025-10-31']},
               {'stepId': 'tag',
                'order': 3,
                'kind': 'tag',
                'title': "Move production's pointer onto the new Saleor build",
                'plain': 'Copies the build you picked into the production registry and moves the '
                         "label 'master' onto it, so the next restart picks up the new code. It also "
                         "saves the image that was live before this, under the label 'prod-prv', "
                         'which is what you go back to if the release goes wrong.',
                'project': 'ECom',
                'definitionId': 34,
                'definitionName': 'CD-Ecom-Saleor-Core',
                'stage': 'PROD_TAG',
                'approval': {'manual': True,
                             'timeoutMinutes': 1,
                             'approver': '[ECom]\\DevOps Approver'},
                'pins': [{'alias': '_CI-Ecom-Saleor-Core',
                          'type': 'Build',
                          'choose': 'user',
                          'requireBranch': 'refs/heads/master',
                          'note': "Definition default is 'Latest'. The build id becomes the SOURCE "
                                  'image '
                                  '(crmepucommonuaenorth001.azurecr.io/ecom-app-api:$(Build.BuildId)), '
                                  'so this pin decides what production runs. Confirm its source '
                                  'branch is master.'},
                         {'alias': '_ecom',
                          'type': 'Git',
                          'choose': 'user',
                          'requireBranch': 'master',
                          'note': 'Only supplies release_config_saleor.json for the version '
                                  'lookup.'}],
                'reads': {'driverFile': '/devops/prod/release_config_saleor.json',
                          'service': 'saleor-app-api',
                          'field': 'version',
                          'currentValue': 'master'},
                'writes': {'registryTags': ['ecom-app-api:master',
                                            'ecom-app-api:prod',
                                            'ecom-app-api:prod-prv']},
                'verifyBy': {'logTask': 'Tagging Images',
                             'expect': 'az acr import --name crmepuproduaenorth001 --source '
                                       'crmepuproduaenorth001.azurecr.io/ecom-app-api:master --force '
                                       '--image ecom-app-api:prod'},
                'hazards': ['version-already-exists-guard-is-COMMENTED-OUT',
                            'rerunning-twice-destroys-the-rollback-point',
                            'one-minute-approval-auto-rejects',
                            'cleartext-registry-password-in-script',
                            'does-not-tag-ecom-dashboard']},
               {'stepId': 'tag-dashboard',
                'order': 4,
                'kind': 'tag',
                'title': "Move production's pointer onto the new Dashboard build",
                'plain': 'The staff-facing Saleor Dashboard is a separate program with its own '
                         'image, and step 3 does not touch it. Run this only if the Dashboard itself '
                         'changed. If you skip it, step 5 still restarts the Dashboard, but on the '
                         'image it is already on.',
                'conditional': 'Run only when the saleor-dashboard application changed.',
                'project': 'ECom',
                'definitionId': 33,
                'definitionName': 'CD-Ecom-Dashboard',
                'stage': 'PROD_TAG',
                'approval': {'manual': True,
                             'timeoutMinutes': 1,
                             'approver': '[ECom]\\DevOps Approver'},
                'pins': [{'alias': '_CI-Ecom-Dashboard',
                          'type': 'Build',
                          'choose': 'user',
                          'requireBranch': 'refs/heads/master'},
                         {'alias': '_ecom',
                          'type': 'Git',
                          'choose': 'user',
                          'requireBranch': 'master'}],
                'reads': {'driverFile': '/devops/prod/release_config_saleor.json',
                          'service': 'saleor-dashboard',
                          'field': 'version',
                          'currentValue': 'master'},
                'writes': {'registryTags': ['ecom-dashboard:master',
                                            'ecom-dashboard:prod',
                                            'ecom-dashboard:prod-prv']},
                'verifyBy': {'logTask': 'Tagging Image',
                             'expect': 'az acr import --name crmepuproduaenorth001 --source '
                                       'crmepuproduaenorth001.azurecr.io/ecom-dashboard:master '
                                       '--force --image ecom-dashboard:prod'},
                'hazards': ['builds-and-pushes-inside-the-release-stage',
                            'one-minute-approval-auto-rejects',
                            'rerunning-twice-destroys-the-rollback-point']},
               {'stepId': 'deploy',
                'order': 5,
                'kind': 'deploy',
                'title': 'Restart the eight Saleor programs onto the new build and settings',
                'plain': 'This is the step that actually changes production. It replaces the running '
                         'copies of all eight Saleor programs, one file at a time. Only now do the '
                         'new settings from steps 1 and 2 and the new code from steps 3 and 4 take '
                         'effect.',
                'project': 'ECom',
                'definitionId': 16,
                'definitionName': 'Production-Release-Saleor',
                'stage': 'PROD',
                'approval': {'manual': True,
                             'timeoutMinutes': 10,
                             'approver': '[ECom]\\DevOps Approver',
                             'requiredApproverCount': 1},
                'autoStartsOnReleaseCreation': True,
                'pins': [{'alias': '_ecom',
                          'type': 'Git',
                          'choose': 'user',
                          'requireBranch': 'master',
                          'note': 'The ONLY artifact. There is no build artifact, so this step '
                                  'cannot change which image is used - it always follows whatever '
                                  'ecom-app-api:master points at right now. Use the SAME commit as '
                                  'steps 1 and 2.'}],
                'reads': {'driverFile': '/devops/prod/release_config_saleor.json',
                          'field': 'yaml + version + deploy, per entry',
                          'deploymentDir': '/devops/prod/k8/deployments/'},
                'writes': {'kubernetes': ['deployment/saleor-dashboard',
                                          'deployment/saleor-admin-api',
                                          'deployment/saleor-app-api',
                                          'deployment/saleor-validator-api',
                                          'deployment/saleor-checkout-api',
                                          'deployment/saleor-worker-1',
                                          'deployment/saleor-worker-2',
                                          'deployment/saleor-worker-3']},
                'target': {'cluster': 'aks-ecom-prod-uaenorth-001',
                           'resourceGroup': 'rg-mepu-prod-uaenorth-001',
                           'namespace': "from each YAML's metadata.namespace (all say saleor)"},
                'mechanism': 'For each driver entry with deploy=true: sed releaseId -> version '
                             "('master'), sed REPLACE_WITH_DATE_STAMP -> run timestamp, then kubectl "
                             'apply -f. The timestamp changes the pod template every run, so this '
                             'ALWAYS rolls all eight workloads even when nothing else changed.',
                'verifyBy': {'logTask': 'Azure CLI ',
                             'expect': "eight lines 'Applying deployment for <name> using "
                                       "k8/deployments/<name>-deployment.yml', plus one line "
                                       "'Skipping deployment for saleor-profile-api (deploy flag is "
                                       "set to false)'"},
                'hazards': ['resets-replicas-and-fights-the-HPA',
                            'always-rolls-all-eight-even-for-a-one-service-change',
                            'no-rollout-status-check',
                            'kubectl-apply-loop-does-not-stop-on-first-failure']}],
     'knownProblems': ['ORDER: the ConfigMap and Secret MUST be applied before def 16. Across the '
                       'eight prod deployment YAMLs there are 393 configMapKeyRef/secretKeyRef '
                       "entries and only 2 carry 'optional: true' (both on saleor-checkout-api). A "
                       'workload rolled before its key exists gets CreateContainerConfigError and '
                       'never becomes Ready.',
                       'ORDER, the other way: applying the ConfigMap or Secret on its own changes '
                       'nothing. Env vars are injected at pod creation only, so a running pod never '
                       'sees the update. Def 16 must always follow, or the change is invisible and '
                       'looks like it silently failed.',
                       'OBSERVED ANTI-PATTERN: on 2026-08-26 the sequence actually run was def 34 '
                       "PROD_TAG (07:06) -> def 16 (07:09) -> def 56 PROD (07:42, ended 'canceled'). "
                       'The ConfigMap was attempted AFTER the workloads had already rolled, so it '
                       'could not have reached the pods. The correct run was 2026-08-25: def 56 PROD '
                       '(03:02) -> def 16 (03:02:37).',
                       "ONE-MINUTE APPROVAL, verified from a real release: def 56 Release-6's first "
                       "PROD approval was auto-rejected with the literal comment 'This approval was "
                       "rejected because of timeout 1 minute(s).' - created 02:54:03, rejected "
                       '02:55:03. A human then re-triggered and approved it at 03:01. Defs 34, 56, '
                       '58 and 33 all have a 60-second window. Only def 16 has a workable 10 '
                       'minutes. Do not start any of the first four steps unless the approver is '
                       'watching.',
                       "DEF 58's LOWER STAGES APPLY A DIFFERENT FILE. Only its PROD stage touches "
                       'saleor-core-secret. DEV/SIT/UAT apply '
                       'devops/common/k8/sercrets/ecom-common-secret-<env>.yml (note the misspelled '
                       "'sercrets' directory) into namespace saleor-<env> on the common cluster. So "
                       'running the UAT stage does NOT rehearse a prod secret change. This also '
                       "corrects ENVIRONMENT_RUNBOOK.md, which states flatly that def 58 'applies "
                       "ecom-common-secret-*.yml' - true for three stages, false for PROD.",
                       'DEF 34 DOES NOT TAG THE DASHBOARD. def 16 deploys saleor-dashboard from '
                       'image ecom-dashboard:releaseId, but def 34 PROD_TAG only touches '
                       'ecom-app-api. ecom-dashboard is tagged by def 33 CD-Ecom-Dashboard PROD_TAG, '
                       'which reads the same driver file release_config_saleor.json under service '
                       'name saleor-dashboard. A dashboard change that skips def 33 will appear to '
                       'deploy and silently keep the old dashboard.',
                       'REPLICAS FIGHT THE HPA. Every deployment YAML declares replicas, and '
                       "replicas is present in each deployment's last-applied-configuration, so "
                       'kubectl apply resets it. Measured 2026-08-27: saleor-admin-api YAML 1 vs '
                       'live 10 (HPA min 1 max 10, CPU already at 77% of its 75% target); '
                       'saleor-checkout-api YAML 2 vs live 4 (HPA min 4); saleor-validator-api YAML '
                       '6 vs live 7 (HPA min 7); saleor-app-api YAML 3 vs live 2. Def 16 therefore '
                       'drops admin-api from 10 pods to 1 and lets the HPA climb back. Deploy at low '
                       'traffic, or align the YAML replicas with the HPA minimums.',
                       "THE VERSION GUARD IS COMMENTED OUT in def 34's enabled Check Version task - "
                       "the whole 'image tag already exists in repository' block is commented. With "
                       'az acr import --force, re-running PROD_TAG silently overwrites. Because the '
                       "driver file's version is the literal string 'master' rather than a rising "
                       'number, the guard could never have fired anyway.',
                       'RE-RUNNING PROD_TAG TWICE DESTROYS THE ROLLBACK POINT. Tagging Images sets '
                       'prod-prv from the current prod, then sets prod from master. Run it twice '
                       'with no deploy in between and prod-prv becomes the same image as prod, '
                       'losing the previous release. Verified good right now: ecom-app-api:master '
                       'and :prod share digest sha256:1706..., while :prod-prv holds a different '
                       'digest sha256:4fe5....',
                       'ROLLBACK IS NOT A SINGLE BUTTON. The workloads run ecom-app-api:master, but '
                       'the rollback snapshot is ecom-app-api:prod-prv, and :prod / :prod-prv are '
                       'both writeEnabled=false while :master is writeEnabled=true. Rolling back '
                       'means re-pointing :master at the prod-prv digest and re-running def 16. No '
                       'pipeline does this; it is a manual ACR operation.',
                       "SECURITY: def 34's 'Repository Image Import From Common Registry' task "
                       'carries an ACR admin username and password for crmepucommonuaenorth001 '
                       'inline in the script body as --username / --password flags, in cleartext, '
                       'visible to anyone who can read the release definition. The adjacent tasks '
                       'use an ARM service connection instead and do not need it. Value not '
                       'reproduced here. Worth raising separately as a credential-rotation item.',
                       'DEF 16 DOES NOT VERIFY THE ROLLOUT. The script is a while-read loop of '
                       'kubectl apply with no kubectl rollout status and no set -e, so a failure on '
                       'one of the eight files does not stop the loop and the stage can still report '
                       'success. Confirm health with kubectl get deploy -n saleor afterwards rather '
                       'than trusting the green tick.',
                       'NO DRIFT AS OF 2026-08-27: the live saleor-core-config matches git at master '
                       'on all 75 keys, and the live saleor-core-secret has exactly the same 17 key '
                       'names as the file. The live ConfigMap does carry a '
                       'k8slens-edit-resource-version=v1 label, so it has been hand-edited through '
                       'Lens at some point - def 56 is not guaranteed to be the only writer.',
                       'STAGE VARIABLES ON DEFS 56 AND 58 PROD ARE MISLEADING BUT INERT. Both PROD '
                       'stages carry leftover DEV values (NAMESPACE_VAR=saleor-dev, ENV_VAR=dev, '
                       'BACKEND_NODEPOOL_NAME_VAR=devpool). The Kubernetes tasks ignore them '
                       'entirely - namespace and cluster are hardcoded to saleor and '
                       "aks-ecom-prod-uaenorth-001 in the task inputs. Do not 'fix' them without "
                       'checking; do not read them as evidence of where the stage deploys.'],
     'confidence': {'steps': 'verified',
                    'order': 'verified',
                    'pins': 'verified',
                    'workloads': 'verified',
                    'deploymentFiles': 'verified',
                    'configMapPlacement': 'verified',
                    'secretBelongsInSequence': 'verified',
                    'runningTag': 'verified',
                    'rollbackTag': 'verified',
                    'approvalTimeouts': 'verified',
                    'oneMinuteTimeoutBehaviour': 'verified',
                    'replicasResetMechanism': 'verified',
                    'replicasResetLiveImpact': 'inferred',
                    'def33PushTargetTag': 'inferred',
                    'def56And58AutoTrigger': 'inferred',
                    'source': 'authored and cross-verified 2026-08-27 by two independent passes '
                              'against the live definitions'},
     'repoId': 'd57e35b2-f3f5-4783-b8dc-7662730e1ad2',
     'branch': 'master'},
}


# ---------------------------------------------------------------------------------------------
# Static serving -- the React build lives in ./static (copied there by the Dockerfile). Flask
# serves it directly: one container, no nginx, no CORS (same origin as the API).
# ---------------------------------------------------------------------------------------------
def _index_response():
    """index.html must NEVER be cached. It is the only file whose URL does not change between
    builds, and it is what names the content-hashed JS/CSS bundle to load.

    Flask sends it with no Cache-Control at all, which lets browsers apply *heuristic* freshness
    off Last-Modified and serve a days-old copy without revalidating -- so the browser keeps
    requesting the previous build's bundle name and the user sees old UI code against a new API.
    That is what produced a row rendering the raw status "PENDINGAPPROVAL" instead of the
    "awaiting approval" label that was already deployed in the image (confirmed 2026-08-17: the
    string was present in the shipped bundle while the browser was not showing it).
    """
    resp = send_from_directory(STATIC_DIR, "index.html")
    resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    resp.headers["Pragma"] = "no-cache"
    resp.headers["Expires"] = "0"
    return resp


# ---------------------------------------------------------------------------------------------
# Logging Dashboard -- live Azure Function logs, read from Application Insights.
#
# WHY THIS EXISTS: a developer debugging a failed registration on the DEV site currently needs an
# Azure portal login, the right subscription selected and the exact function blade. Most of them
# have none of those. This puts the same log stream and the same invocation detail behind the
# portal login they already have.
#
# HOW IT READS: Application Insights' own query API (api.applicationinsights.io/v1/apps/<appId>),
# NOT the ARM-proxied .../providers/microsoft.insights/components/<name>/api/query endpoint --
# that one answers NoRegisteredProviderFound in uaenorth (measured 2026-09-24), which reads like a
# permissions problem and is not one.
#
# WHAT NEVER REACHES THE BROWSER: these logs carry live credentials. One userRegistrationApi
# invocation logs the POS bearer JWT, the inbound "AuthHeader Basic ..." and the customer's email
# and phone. Tokens and auth headers are redacted SERVER-SIDE by _redact_log before the message
# leaves this process -- the same rule the variables screen follows, because masking in the UI
# would leave the real credential sitting in the JSON behind the page.
# ---------------------------------------------------------------------------------------------

AZ_MONITOR_TENANT = os.environ.get("AZURE_MONITOR_TENANT_ID", "").strip()
AZ_MONITOR_CLIENT = os.environ.get("AZURE_MONITOR_CLIENT_ID", "").strip()
AZ_MONITOR_SECRET = os.environ.get("AZURE_MONITOR_CLIENT_SECRET", "").strip()
_AI_API = "https://api.applicationinsights.io/v1/apps"

# One entry per tile. `appId` is the Application Insights "Application ID" (a GUID -- not the
# instrumentation key, not the resource id). `operation` is what Application Insights records as
# operation_Name, which for a Function is the function name, not the route.
LOG_SOURCES = {
    "dev-adb2c-register": {
        "key": "dev-adb2c-register",
        "title": "Dev Env Azure ADB2C (Register User Logs)",
        "subtitle": "userRegistrationApi",
        "env": "DEV",
        "appId": "58570496-5bbc-4e36-b937-50e4d8eaea79",   # app-insight-dev-001
        "roleName": "magrabiexternalapidevapp",
        "operation": "userRegistrationApi",
        "description": ("Every user registration attempt on the DEV site: the request as it "
                        "arrives, the Saleor lookup, the POS create call, and what each one "
                        "answered."),
        "portalUrl": ("https://portal.azure.com/#view/WebsitesExtension/FunctionTabMenuBlade/~/logs"
                      "/resourceId/%2Fsubscriptions%2F72bde893-fa26-4129-a31f-648b81a48153"
                      "%2FresourceGroups%2Frg-mepu-dev-uaenorth-001%2Fproviders%2FMicrosoft.Web"
                      "%2Fsites%2Fmagrabiexternalapidevapp%2Ffunctions%2FuserRegistrationApi"),
    },
}

# Ordered most-specific first: the JWT pattern has to win over the generic bearer one, or a bearer
# JWT gets half-masked and the readable half is still a usable prefix.
_REDACTIONS = [
    (re.compile(r"eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]+"), "<jwt redacted>"),
    (re.compile(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9+/=._\-]{12,}"), r"\1 <redacted>"),
    (re.compile(r'(?i)"(token|access_token|apikey|api_key|password|secret|authorization)"\s*:\s*"[^"]{6,}"'),
     r'"\1":"<redacted>"'),
    (re.compile(r"(?i)\b(x-api-key|ocp-apim-subscription-key)\s*[:=]\s*\S{8,}"), r"\1=<redacted>"),
]


def _redact_log(text):
    """Strip credentials out of a log line before it can reach a browser.

    Deliberately conservative about what it keeps: emails and phone numbers stay, because on DEV
    they are test data and they are how a developer finds their own attempt in the stream. Only
    values that are usable as credentials are removed.
    """
    if not text:
        return text
    out = str(text)
    for pattern, replacement in _REDACTIONS:
        out = pattern.sub(replacement, out)
    return out


_ai_token_cache = {"token": None, "expires": 0.0}


def _ai_token():
    """Client-credentials token for the Application Insights query API, cached until it expires."""
    if not (AZ_MONITOR_TENANT and AZ_MONITOR_CLIENT and AZ_MONITOR_SECRET):
        raise RuntimeError(
            "Azure Monitor credentials are not configured. Set AZURE_MONITOR_TENANT_ID, "
            "AZURE_MONITOR_CLIENT_ID and AZURE_MONITOR_CLIENT_SECRET (see k8s/deployment.yaml).")
    now = time.time()
    if _ai_token_cache["token"] and _ai_token_cache["expires"] - 60 > now:
        return _ai_token_cache["token"]
    resp = requests.post(
        "https://login.microsoftonline.com/" + AZ_MONITOR_TENANT + "/oauth2/v2.0/token",
        data={"client_id": AZ_MONITOR_CLIENT, "client_secret": AZ_MONITOR_SECRET,
              "grant_type": "client_credentials",
              "scope": "https://api.applicationinsights.io/.default"},
        timeout=30)
    if resp.status_code != 200:
        # Never echo the body -- a failed token request can quote the client secret back.
        raise RuntimeError("Azure token request failed with HTTP %s" % resp.status_code)
    payload = resp.json()
    _ai_token_cache["token"] = payload["access_token"]
    _ai_token_cache["expires"] = now + float(payload.get("expires_in", 3600))
    return _ai_token_cache["token"]


def _ai_query(app_id, kql, timespan="PT24H"):
    """Run one KQL query. Returns a list of dicts, so callers never index columns by position."""
    resp = requests.post(
        "%s/%s/query" % (_AI_API, app_id),
        headers={"Authorization": "Bearer " + _ai_token(), "Content-Type": "application/json"},
        json={"query": kql, "timespan": timespan}, timeout=60)
    if resp.status_code != 200:
        raise RuntimeError("Application Insights query failed with HTTP %s" % resp.status_code)
    tables = resp.json().get("tables") or []
    if not tables:
        return []
    cols = [c["name"] for c in tables[0]["columns"]]
    return [dict(zip(cols, row)) for row in tables[0]["rows"]]


def _kql_literal(value):
    """A KQL string literal. Single quotes terminate it, so they are what must be escaped."""
    return "'" + str(value).replace("\\", "\\\\").replace("'", "\\'") + "'"


def _log_source_or_404(key):
    src = LOG_SOURCES.get(key)
    if not src:
        return None, (jsonify({"ok": False, "message": "unknown log source"}), 404)
    return src, None


@app.route("/api/logs/sources")
@require_role("admin", "viewer")
def api_log_sources():
    """The tiles. Cheap and credential-free, so the dashboard renders before any query runs.

    `appId` is dropped from the payload: it is not a secret, but nothing in the browser needs it
    and every field that leaves here is a field someone can build a dependency on.
    """
    return jsonify({
        "ok": True,
        "configured": bool(AZ_MONITOR_TENANT and AZ_MONITOR_CLIENT and AZ_MONITOR_SECRET),
        "sources": [{k: v for k, v in s.items() if k != "appId"} for s in LOG_SOURCES.values()],
    })


@app.route("/api/logs/<key>/stream")
@require_role("admin", "viewer")
def api_log_stream(key):
    """The live tail.

    `since` is an exact timestamp taken from the previous page of results rather than a rolling
    window, so polling can neither show a line twice nor skip one that arrived late.
    """
    src, err = _log_source_or_404(key)
    if err:
        return err
    since = (request.args.get("since") or "").strip()
    try:
        limit = max(1, min(int(request.args.get("limit", 200)), 500))
    except ValueError:
        limit = 200
    where_since = ""
    if since:
        where_since = "| where timestamp > datetime(%s) " % _kql_literal(since)
    kql = (
        "traces "
        "| where operation_Name == %s " % _kql_literal(src["operation"]) +
        "| where cloud_RoleName == %s " % _kql_literal(src["roleName"]) +
        where_since +
        "| project timestamp, severityLevel, operation_Id, itemId, message "
        "| order by timestamp asc | take %d" % limit
    )
    try:
        rows = _ai_query(src["appId"], kql, timespan="PT24H")
    except Exception as exc:
        return jsonify({"ok": False, "message": str(exc)}), 502
    return jsonify({"ok": True, "lines": [{
        "id": r.get("itemId"),
        "timestamp": r.get("timestamp"),
        "severity": r.get("severityLevel"),
        "invocationId": r.get("operation_Id"),
        "message": _redact_log(r.get("message")),
    } for r in rows]})


@app.route("/api/logs/<key>/invocations")
@require_role("admin", "viewer")
def api_log_invocations(key):
    """One row per run of the function -- the same data as the Azure portal's Invocations tab."""
    src, err = _log_source_or_404(key)
    if err:
        return err
    try:
        hours = max(1, min(int(request.args.get("hours", 24)), 168))
    except ValueError:
        hours = 24
    kql = (
        "requests "
        "| where name == %s " % _kql_literal(src["operation"]) +
        "| where cloud_RoleName == %s " % _kql_literal(src["roleName"]) +
        "| project timestamp, operation_Id, success, resultCode, duration, cloud_RoleInstance "
        "| order by timestamp desc | take 100"
    )
    try:
        rows = _ai_query(src["appId"], kql, timespan="PT%dH" % hours)
    except Exception as exc:
        return jsonify({"ok": False, "message": str(exc)}), 502
    return jsonify({"ok": True, "invocations": [{
        "invocationId": r.get("operation_Id"),
        "timestamp": r.get("timestamp"),
        # Application Insights returns this as the string "True"/"False", never a JSON bool.
        "success": str(r.get("success")).lower() == "true",
        "resultCode": r.get("resultCode"),
        "durationMs": r.get("duration"),
        "instance": r.get("cloud_RoleInstance"),
    } for r in rows]})


@app.route("/api/logs/<key>/invocations/<invocation_id>")
@require_role("admin", "viewer")
def api_log_invocation_detail(key, invocation_id):
    """Every line of one invocation, oldest first -- one registration attempt, start to finish."""
    src, err = _log_source_or_404(key)
    if err:
        return err
    # The id goes into a KQL literal; _kql_literal escapes it, and this rejects anything that is
    # not an Application Insights operation id in the first place.
    if not re.fullmatch(r"[0-9a-fA-F-]{8,64}", invocation_id or ""):
        return jsonify({"ok": False, "message": "invalid invocation id"}), 400
    lit = _kql_literal(invocation_id)
    try:
        traces = _ai_query(src["appId"],
                           "traces | where operation_Id == %s "
                           "| project timestamp, severityLevel, message "
                           "| order by timestamp asc | take 500" % lit, timespan="PT168H")
        reqs = _ai_query(src["appId"],
                         "requests | where operation_Id == %s "
                         "| project timestamp, success, resultCode, duration, cloud_RoleInstance "
                         "| take 1" % lit, timespan="PT168H")
        excs = _ai_query(src["appId"],
                         "exceptions | where operation_Id == %s "
                         "| project timestamp, type, outerMessage "
                         "| order by timestamp asc | take 50" % lit, timespan="PT168H")
    except Exception as exc:
        return jsonify({"ok": False, "message": str(exc)}), 502
    head = reqs[0] if reqs else {}
    return jsonify({
        "ok": True,
        "invocationId": invocation_id,
        "summary": {
            "timestamp": head.get("timestamp"),
            "success": (str(head.get("success")).lower() == "true") if head else None,
            "resultCode": head.get("resultCode"),
            "durationMs": head.get("duration"),
            "instance": head.get("cloud_RoleInstance"),
        },
        "lines": [{"timestamp": t.get("timestamp"), "severity": t.get("severityLevel"),
                   "message": _redact_log(t.get("message"))} for t in traces],
        "exceptions": [{"timestamp": e.get("timestamp"), "type": e.get("type"),
                        "message": _redact_log(e.get("outerMessage"))} for e in excs],
    })




# =================================================================================================
# Live Monitoring Insights - the production checkout funnel for Magrabi and DoctorM.
#
# WHY SQL AND NOT THE SALEOR GRAPHQL API. The API cannot answer this. Verified by introspecting
# https://ecom-admin-api.magrabi.com/graphql/ on 2026-09-30: OrderFilterInput.created and EVERY
# CheckoutFilterInput date field are `DateRangeInput`, i.e. whole days. Only OrderFilterInput
# .updatedAt takes a DateTime, and "updated" is not "placed". An hour-granularity funnel is
# therefore impossible over GraphQL without pulling every row for the day and filtering in memory.
#
# HOW THE THREE COLUMNS ARE DEFINED. Saleor DELETES a checkout row when its order is created, so
# every checkout still present is by definition an abandonment:
#   orders placed      -> order_order rows created in the window
#   reached checkout, no payment
#                      -> checkout_checkout rows with authorize_status AND charge_status 'none'
#   payment started, not completed
#                      -> checkout_checkout rows where either status has moved off 'none'
# Status values are lower-case in the database ('none' / 'partial' / 'full'), not the SCREAMING_CASE
# of the GraphQL enum - COALESCE guards a NULL on older rows.
#
# The query was validated against SIT (same schema) before ever being pointed at production.
# =================================================================================================

INSIGHTS_DB_DSN = os.environ.get("INSIGHTS_DB_DSN", "").strip()
INSIGHTS_CACHE_SECONDS = int(os.environ.get("INSIGHTS_CACHE_SECONDS", "20"))
INSIGHTS_MAX_HOURS = 168          # one week; beyond this it stops being a "live" view
INSIGHTS_QUERY_TIMEOUT_MS = 15000

_INSIGHTS_BRANDS = [
    {"key": "magrabi", "label": "Magrabi"},
    {"key": "doctorm", "label": "DoctorM"},
]

_INSIGHTS_SQL = """
WITH ch AS (
  SELECT id, slug,
         CASE WHEN slug LIKE 'magrabi%%' THEN 'magrabi'
              WHEN slug LIKE 'doctorm%%' OR slug LIKE 'drm%%' THEN 'doctorm'
              ELSE 'other' END AS brand
  FROM channel_channel
),
o AS (
  SELECT channel_id, COUNT(*) AS n
  FROM order_order
  WHERE created_at >= NOW() - (%(mins)s || ' minutes')::interval
  GROUP BY channel_id
),
c AS (
  SELECT channel_id,
         COUNT(*) FILTER (WHERE COALESCE(authorize_status,'none')='none'
                            AND COALESCE(charge_status,'none')='none')  AS no_payment,
         COUNT(*) FILTER (WHERE COALESCE(authorize_status,'none')<>'none'
                             OR COALESCE(charge_status,'none')<>'none') AS payment_started
  FROM checkout_checkout
  WHERE created_at >= NOW() - (%(mins)s || ' minutes')::interval
  GROUP BY channel_id
)
SELECT ch.brand,
       COALESCE(SUM(o.n),0)::bigint               AS orders_placed,
       COALESCE(SUM(c.no_payment),0)::bigint      AS checkout_no_payment,
       COALESCE(SUM(c.payment_started),0)::bigint AS payment_not_completed
FROM ch
LEFT JOIN o ON o.channel_id = ch.id
LEFT JOIN c ON c.channel_id = ch.id
WHERE ch.brand <> 'other'
GROUP BY ch.brand
ORDER BY ch.brand;
"""

_INSIGHTS_CHANNELS_SQL = """
SELECT slug, name,
       CASE WHEN slug LIKE 'magrabi%%' THEN 'magrabi'
            WHEN slug LIKE 'doctorm%%' OR slug LIKE 'drm%%' THEN 'doctorm'
            ELSE 'other' END AS brand
FROM channel_channel ORDER BY slug;
"""

_insights_cache = {"key": None, "at": 0.0, "payload": None}
_insights_lock = threading.Lock()


def _insights_query(minutes):
    """Run the funnel read. READ ONLY and time-boxed: this talks to the production order database
    and must never be capable of writing, nor of pinning a connection open."""
    import psycopg  # imported lazily so the portal still boots where the driver is absent

    with psycopg.connect(INSIGHTS_DB_DSN, connect_timeout=10,
                         options="-c statement_timeout=%d" % INSIGHTS_QUERY_TIMEOUT_MS) as conn:
        conn.read_only = True
        with conn.cursor() as cur:
            cur.execute(_INSIGHTS_SQL, {"mins": str(minutes)})
            rows = cur.fetchall()
            cur.execute(_INSIGHTS_CHANNELS_SQL)
            channels = cur.fetchall()

    by_brand = {r[0]: r for r in rows}
    out = []
    for b in _INSIGHTS_BRANDS:
        r = by_brand.get(b["key"])
        placed = int(r[1]) if r else 0
        no_pay = int(r[2]) if r else 0
        pay_started = int(r[3]) if r else 0
        started = placed + no_pay + pay_started
        out.append({
            "brand": b["key"],
            "label": b["label"],
            "ordersPlaced": placed,
            "checkoutNoPayment": no_pay,
            "paymentNotCompleted": pay_started,
            "checkoutsStarted": started,
            # Orders over everything that entered checkout in the window, so nobody has to divide
            # three columns in their head during an incident.
            "conversionPct": round(placed * 100.0 / started, 1) if started else None,
            "channels": [c[0] for c in channels if c[2] == b["key"]],
        })
    return out


@app.route("/api/insights/funnel")
@require_role("admin", "viewer")
def api_insights_funnel():
    """Live order / abandonment funnel for the production storefronts.

    `minutes` is the look-back window. The UI offers preset hours plus a custom box; the cap here
    is a week, past which this stops being a live view and becomes a report."""
    try:
        minutes = int(request.args.get("minutes", "180"))
    except ValueError:
        return jsonify({"ok": False, "error": "minutes must be a whole number"}), 400
    minutes = max(5, min(minutes, INSIGHTS_MAX_HOURS * 60))

    if not INSIGHTS_DB_DSN:
        # Deliberately a 200 carrying a clear state rather than a 500: the panel then renders an
        # explanation instead of an error, and says exactly what is missing.
        return jsonify({
            "ok": False,
            "configured": False,
            "minutes": minutes,
            "error": "No production order database configured.",
            "detail": ("Set INSIGHTS_DB_DSN on the portal deployment to a READ-ONLY Postgres user "
                       "on the production Saleor database. Nothing else is needed; this panel only "
                       "ever issues SELECTs, inside a read-only transaction."),
            "rows": [],
        })

    key = str(minutes)
    now = time.time()
    with _insights_lock:
        if (_insights_cache["key"] == key
                and now - _insights_cache["at"] < INSIGHTS_CACHE_SECONDS
                and _insights_cache["payload"] is not None):
            cached = dict(_insights_cache["payload"])
            cached["cached"] = True
            return jsonify(cached)

    try:
        rows = _insights_query(minutes)
    except ImportError:
        return jsonify({"ok": False, "configured": True, "minutes": minutes, "rows": [],
                        "error": "The psycopg driver is not installed in this portal image."}), 500
    except Exception as exc:
        # Never echo the exception text: a psycopg connection error can contain the DSN, and the
        # DSN contains the password. Type name only.
        app.logger.warning("insights funnel query failed: %s", type(exc).__name__)
        return jsonify({"ok": False, "configured": True, "minutes": minutes, "rows": [],
                        "error": "Query failed (%s). Check the portal logs and the database "
                                 "credential." % type(exc).__name__}), 502

    payload = {
        "ok": True,
        "configured": True,
        "minutes": minutes,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "rows": rows,
        "cached": False,
    }
    with _insights_lock:
        _insights_cache.update({"key": key, "at": now, "payload": payload})
    return jsonify(payload)


# ---------------------------------------------------------------------------------------------
# Traffic Counts is independent of the order database and SIT monitoring. Importing its modules
# performs no telemetry reads and starts no worker. Collections begin only from an authenticated
# same-origin request. Keep the existing one-worker portal topology for the collection budget.
from traffic_counts.service import TrafficReports as _TrafficReports
from traffic_counts.routes import make_blueprint as _traffic_blueprint

_traffic_reports = _TrafficReports(os.environ.get(
    "TRAFFIC_REPORTS_DIR", str(RUNS_DIR.parent / "traffic_reports")))
app.register_blueprint(_traffic_blueprint(_traffic_reports, require_role))


# ---------------------------------------------------------------------------------------------
# Key Rotation -- Azure Key Vault as the single source of truth for pipeline credentials.
# MLC-2635. Contract: ../KEY_ROTATION_CONTRACT.md.
#
# WHY THIS EXISTS: a sweep of the estate (2026-10-08) found one real credential copy-pasted into
# many pipeline places -- 441 credential entries across UAT/PROD/BETA holding only 139 distinct
# values, 647 of those copies readable in plaintext through the REST API. Rotating anything meant
# hunting every copy by hand, and missing one fails silently. The vault now holds each value once;
# this section pushes it to every place a pipeline actually reads it from, and can put the vault
# back to its previous version and push again.
#
# WHAT IT WRITES: Azure DevOps release DEFINITIONS and Key Vault secret VERSIONS. Nothing else.
# It does not touch a cluster and it does not create a release -- a rotation only reaches a running
# service when somebody later creates one, which is deliberately outside this feature.
#
# WHAT NEVER LEAVES THIS PROCESS: the values. A credential is represented on the wire, in the run
# records and in the logs by a 10-character SHA-256 prefix, a character length and a Key Vault
# version id -- never the value, never a masked form of it, never a prefix or suffix of it. A
# masked value in a JSON response is still the credential sitting behind the page.
#
# RELATIONSHIP TO kvsync: devops-tools/kvsync/kvsync.py is the command-line tool this mirrors. It
# cannot be imported here (it lives outside the image and shells out to the az CLI, which the image
# does not carry), so the three parts that matter are reimplemented below with identical semantics:
# reading a destination's current value out of a release definition, classifying it against the
# vault's VERSION HISTORY, and writing a value into either a stage variable or one line of a Docker
# task's buildArguments. Each of the three carries a note saying what it mirrors and where this
# deliberately differs.
# ---------------------------------------------------------------------------------------------

KEYVAULT_VAULTS = {
    "uat": os.environ.get("KEYVAULT_UAT", "kv-cicd-uat-uaenorth").strip(),
    "prod": os.environ.get("KEYVAULT_PROD", "kv-cicd-prod-uaenorth").strip(),
}
KEYVAULT_DNS_SUFFIX = os.environ.get("KEYVAULT_DNS_SUFFIX", "vault.azure.net").strip()

# The plan files are the routing table: which vault secret feeds which project, definition, stage,
# variable and placement. They are generated from the live pipelines by uat_scope.py/prod_scope.py
# and copied into the image at build time, never hand-maintained.
KEYVAULT_PLAN_DIR = Path(os.environ.get("KEYVAULT_PLAN_DIR", "/app/keyvault"))
KEYVAULT_PLAN_FILES = {"uat": "uat_plan.json", "prod": "prod_plan.json"}

# Sibling of RUNS_DIR for the same reason as every other bookkeeping directory in this file: the
# runs directory is globbed as RUNS_DIR/*.json and every match is parsed as a deployment run, so a
# key-rotation record living inside it would be read back as a malformed deployment row.
KEYVAULT_RUNS_DIR = Path(os.environ.get(
    "KEYVAULT_RUNS_DIR", str(RUNS_DIR.parent / "keyvault_runs")))

# Which release stages belong to each environment. Mirrors kvsync.DEFAULTS[env]["stages"] exactly,
# including the prefix match, because the estate spells the same stage four ways (PROD_TAG,
# PROD-TAG, "PROD TAG", PROD). One prod_plan row names a stage this filter drops ("DoctorM-Prod");
# kvsync drops it too, so both tools cover the same 225 of 226 rows and neither can silently
# disagree with the other about what a rotation covers.
KEYVAULT_STAGES = {
    "uat": ("UAT",),
    "prod": ("PROD", "PROD_TAG", "PROD-TAG", "PROD TAG", "BETA", "BETA_TAG"),
}

# A vault entry created but not yet filled in. Never pushed anywhere. Same literal as kvsync.
KEYVAULT_SENTINEL = "__SET_ME__"

# The whole status payload, per environment. 60s per the contract; ?refresh=1 bypasses it.
KEYVAULT_STATUS_TTL_SECONDS = 60
# Version-history hashes, per (vault, secret). This is the expensive read -- every version of every
# secret is one HTTPS round trip, and prod has 65 secrets -- and it cannot change underneath us
# except through this portal's own rollback, which invalidates the entry explicitly. Short anyway,
# because somebody rotating by hand with `az keyvault secret set` must not have to wait it out.
KEYVAULT_HISTORY_TTL_SECONDS = 300

# Pure network wait, not CPU work: this is what stops 65 secrets, their versions and ~20 release
# definitions from serializing into one very long request. Long-lived pools, like
# _my_deployments_pool, rather than one per request.
#
# TWO pools, deliberately. The outer fan-out is one task per secret and per definition; inside it,
# reading a secret's version history is itself one call per version. Submitting the inner work to
# the same pool would deadlock the moment every worker held an outer task waiting on an inner one
# -- which with 65 secrets and 8 workers is immediately, not occasionally.
_KEYVAULT_WORKERS = max(1, min(int(os.environ.get("KEYVAULT_WORKERS", "8")), 16))
_keyvault_pool = ThreadPoolExecutor(max_workers=_KEYVAULT_WORKERS, thread_name_prefix="keyvault")
_keyvault_version_pool = ThreadPoolExecutor(
    max_workers=_KEYVAULT_WORKERS, thread_name_prefix="keyvault-versions")

# Destination states a sync is allowed to write over. 'behind' is the normal rotation case;
# 'empty' is a destination present but blank, which the vault can only improve; 'padlocked' cannot
# be compared at all (see _kv_destination). 'match' and 'reference' need no write, 'unknown' must
# never be written, and 'absent' means the plan no longer describes the pipeline.
_KEYVAULT_WRITEABLE = ("behind", "empty", "padlocked")

_keyvault_lock = threading.Lock()
_keyvault_status_cache = {}          # env -> (fetched_at_monotonic, payload)
_keyvault_history_cache = {}         # (vault, secret) -> (fetched_at_monotonic, [version meta])
_keyvault_clients = {}               # vault name -> SecretClient
_keyvault_credential = {"cred": None, "error": None, "tried": False}

# The Azure SDK is imported at module scope BUT a failure here must not stop the pod booting -- the
# whole rest of the portal has nothing to do with Key Vault. Same shape as the lazy `import psycopg`
# in the insights panel and the credential check in the Logging Dashboard: a missing dependency or a
# missing credential degrades this one section to connected=false with a message that says what is
# missing, and every other route keeps working.
try:
    from azure.identity import DefaultAzureCredential as _AzureDefaultCredential
    from azure.keyvault.secrets import SecretClient as _AzureSecretClient

    _KEYVAULT_IMPORT_ERROR = ""
except Exception as _kv_import_exc:          # pragma: no cover - exercised by the degraded path
    _AzureDefaultCredential = None
    _AzureSecretClient = None
    # Type name only. An import error can quote a path, never a credential, but the house rule in
    # this file is that exception text from anything credential-adjacent does not get echoed.
    _KEYVAULT_IMPORT_ERROR = (
        "The Azure Key Vault client libraries are not installed in this portal image "
        "(%s). Add azure-identity and azure-keyvault-secrets to backend/requirements.txt and "
        "rebuild." % type(_kv_import_exc).__name__)


def _kv_hash(value) -> str:
    """The ONLY representation of a credential value this feature is allowed to emit.

    10 hex characters of SHA-256 -- enough to tell two values apart across a few hundred
    destinations, useless as a credential. Identical to kvsync's prefix, so a hash printed by the
    command-line tool and one shown in the portal are directly comparable.
    """
    return hashlib.sha256(str(value).encode("utf-8")).hexdigest()[:10]


def _kv_is_filled(value) -> bool:
    """A value the vault can actually push. Mirrors kvsync._vault_values."""
    return isinstance(value, str) and value != KEYVAULT_SENTINEL and bool(value.strip())


def _kv_norm_stage(name: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", (name or "").upper())


def _kv_service_of(row: dict) -> str:
    """The service bucket a plan row belongs to.

    A shared secret belongs to "shared", not to whichever service happened to be the first row
    generated for it -- it is stored once in the vault as <env>-shared-<key> and feeds several
    services, so filing it under one of them would make the other services look clean while their
    credential changed underneath them. 27 of prod's 65 secrets are shared.
    """
    return "shared" if row.get("shared") else (row.get("service") or "unknown")


def _kv_plan_rows(env: str):
    """(rows, error). The routing table for one environment, filtered to that env's stages."""
    path = KEYVAULT_PLAN_DIR / KEYVAULT_PLAN_FILES[env]
    if not path.is_file():
        return [], ("The %s routing table is not in this image. Expected %s. It is generated from "
                    "the live pipelines by devops-tools/kvsync/%s_scope.py and copied in at build "
                    "time; set KEYVAULT_PLAN_DIR if it lives elsewhere."
                    % (env.upper(), path, env))
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        return [], ("The %s routing table at %s could not be parsed (%s)."
                    % (env.upper(), path, type(exc).__name__))
    if not isinstance(raw, list):
        return [], "The %s routing table at %s is not a list of rows." % (env.upper(), path)

    stages = KEYVAULT_STAGES[env]
    rows = []
    for r in raw:
        if not isinstance(r, dict):
            continue
        if not all(r.get(k) for k in ("project", "defId", "stage", "pipelineName",
                                      "placement", "secretName")):
            continue
        if not any(str(r["stage"]).upper().startswith(s.upper()) for s in stages):
            continue
        rows.append(r)
    if not rows:
        return [], ("The %s routing table at %s has no rows for the %s stages."
                    % (env.upper(), path, "/".join(stages)))
    return rows, ""


# ------------------------------------------------------------------------ Key Vault access layer --
#
# Deliberately thin. Everything above it works in hashes; this is the only part that ever holds a
# plaintext value, and it holds it in a local variable for the length of one request. Nothing here
# caches a value: the caches hold hashes, lengths, version ids and timestamps only, so a long-lived
# process never has a credential sitting in its heap between requests.

def _kv_credential_or_error():
    """(credential, error). Built once, never raised out of. AKS workload identity in the cluster.

    DefaultAzureCredential picks up WorkloadIdentityCredential on its own once the pod carries the
    azure.workload.identity/use label and the service account is annotated with the managed
    identity's client id -- there is no secret in the image and no az CLI to shell out to.
    """
    if _AzureDefaultCredential is None:
        return None, _KEYVAULT_IMPORT_ERROR
    with _keyvault_lock:
        if _keyvault_credential["tried"]:
            return _keyvault_credential["cred"], _keyvault_credential["error"]
    cred, error = None, ""
    try:
        cred = _AzureDefaultCredential(exclude_interactive_browser_credential=True)
    except Exception as exc:
        # Type name only -- a credential construction failure can quote the environment it read.
        error = ("No Azure identity is available to this pod (%s). The Key Rotation section needs "
                 "AKS workload identity: the pod label azure.workload.identity/use=\"true\" and a "
                 "service account annotated with the managed identity's client id."
                 % type(exc).__name__)
    with _keyvault_lock:
        _keyvault_credential.update({"cred": cred, "error": error, "tried": True})
    return cred, error


def _kv_client(env: str):
    """(SecretClient, error) for one environment's vault. Never raises."""
    name = KEYVAULT_VAULTS.get(env) or ""
    if not name:
        return None, "No vault is configured for %s (set KEYVAULT_%s)." % (env, env.upper())
    with _keyvault_lock:
        hit = _keyvault_clients.get(name)
    if hit is not None:
        return hit, ""
    cred, error = _kv_credential_or_error()
    if cred is None:
        return None, error
    try:
        client = _AzureSecretClient(
            vault_url="https://%s.%s/" % (name, KEYVAULT_DNS_SUFFIX), credential=cred)
    except Exception as exc:
        return None, ("Could not open a client for vault %s (%s)."
                      % (name, type(exc).__name__))
    with _keyvault_lock:
        _keyvault_clients[name] = client
    return client, ""


def _kv_names(client):
    """(set of secret names, error). One paged list call."""
    try:
        return {p.name for p in client.list_properties_of_secrets() if p.name}, ""
    except Exception as exc:
        return set(), ("Vault %s is not readable by this pod's identity (%s). The managed identity "
                       "needs the 'Key Vault Secrets Officer' role on the vault -- Secrets User is "
                       "enough to read but not to roll back."
                       % (client.vault_url, type(exc).__name__))


def _kv_current_values(client, names):
    """{name: (value, versionId)} for the CURRENT version of each name, fetched concurrently.

    The return value carries plaintext and is treated accordingly: the caller keeps it in a local,
    hashes it, and lets it go. It is never cached, logged or serialized.
    """
    out, errors = {}, {}

    def one(name):
        secret = client.get_secret(name)
        return name, secret.value, getattr(secret.properties, "version", None)

    futures = {_keyvault_pool.submit(one, n): n for n in names}
    for fut in as_completed(futures):
        name = futures[fut]
        try:
            n, value, version = fut.result()
            out[n] = (value, version)
        except Exception as exc:
            errors[name] = type(exc).__name__
    return out, errors


def _kv_history(client, name, refresh=False):
    """Every version this entry has ever held, newest first, as metadata ONLY.

    Mirrors kvsync.Vault.history, and the two properties that make a rotation possible both live
    here:

      * It RAISES rather than returning a partial list. A version that failed to read silently
        turns 'behind' into 'unknown', which refuses the very rotation this check exists to allow
        -- that is exactly what happened in the 2026-10-09 rehearsal, where one transient failure
        blocked a correct rollback and left four UAT definitions holding a test value.
      * It records a HASH per version, never the value. The list is cached per process; a cache of
        plaintext credential history would be a worse leak than the one this feature removes.

    Disabled versions count: they were live once, so a pipeline still holding one is behind, not
    unrecognised.
    """
    key = (client.vault_url, name)
    if not refresh:
        with _keyvault_lock:
            hit = _keyvault_history_cache.get(key)
        if hit and (time.monotonic() - hit[0]) < KEYVAULT_HISTORY_TTL_SECONDS:
            return hit[1]

    try:
        props = list(client.list_properties_of_secret_versions(name))
    except Exception as exc:
        # Same rule as the per-version reads below: a failure here is NOT "no history". Raised with
        # a value-free message of our own rather than the SDK's, which the house style in this file
        # never echoes for anything credential-adjacent.
        raise RuntimeError("could not list the versions of %s (%s). Not treating this as 'no "
                           "history' -- an incomplete history would wrongly refuse a valid "
                           "rotation. Re-run." % (name, type(exc).__name__))
    props.sort(key=lambda p: (getattr(p, "created_on", None) or datetime.min.replace(
        tzinfo=timezone.utc)), reverse=True)

    def one(prop):
        return prop, client.get_secret(name, version=prop.version).value

    versions, failed = [], []
    futures = {_keyvault_version_pool.submit(one, p): p for p in props}
    results = {}
    for fut in as_completed(futures):
        prop = futures[fut]
        try:
            _, value = fut.result()
            results[prop.version] = value
        except Exception as exc:
            failed.append((prop.version, type(exc).__name__))
    if failed:
        # Deliberately not degraded to "no history" -- see the docstring. Version ids are not
        # secret, so naming the one that failed is safe and is what makes a re-run obviously right.
        raise RuntimeError(
            "could not read %d version(s) of %s (first failure: %s, %s). Refusing to return a "
            "partial history: an incomplete one would wrongly refuse a valid rotation. Re-run."
            % (len(failed), name, str(failed[0][0])[:12], failed[0][1]))

    for prop in props:
        value = results.get(prop.version)
        filled = _kv_is_filled(value)
        versions.append({
            "versionId": prop.version,
            "created": (getattr(prop, "created_on", None).isoformat()
                        if getattr(prop, "created_on", None) else None),
            "enabled": bool(getattr(prop, "enabled", True)),
            "hash": _kv_hash(value) if filled else None,
            "length": len(value) if isinstance(value, str) else None,
            # Internal. A blank or still-placeholder version was never a real credential, so
            # nothing in a pipeline can legitimately have come from it and nothing may roll back to
            # it -- but it IS a version, so the history list still reports it.
            "filled": filled,
        })

    with _keyvault_lock:
        if len(_keyvault_history_cache) > 400:
            _keyvault_history_cache.clear()
        _keyvault_history_cache[key] = (time.monotonic(), versions)
    return versions


def _kv_forget(client, name):
    """Drop the cached history for one secret. Called the moment this portal writes a new version,
    so the classification that follows a rollback is made against what the vault holds NOW."""
    with _keyvault_lock:
        _keyvault_history_cache.pop((client.vault_url, name), None)
        _keyvault_status_cache.clear()


def _kv_set_secret(client, name, value):
    """Write a new version, carrying the existing tags forward.

    set_secret does not inherit tags, and the five tags on these entries (service, destination,
    pipelineVar, usedBy, status) ARE the mapping documentation -- losing them on a rollback would
    quietly destroy it. Mirrors kvsync.Vault.set.
    """
    tags = None
    try:
        existing = client.get_secret(name).properties.tags or {}
        tags = {k: v for k, v in existing.items() if not str(k).startswith("__")} or None
    except Exception:
        tags = None
    secret = client.set_secret(name, value, tags=tags)
    return getattr(secret.properties, "version", None)


# ------------------------------------------------------------- destinations inside a definition --

def _kv_find_stage(definition, stage_name):
    """The release stage a plan row names. Exact match first, then a punctuation-insensitive one.

    The estate spells one stage four ways -- PROD_TAG, PROD-TAG, "PROD TAG", PROD -- and the plan
    records whichever spelling the definition used when it was generated. Exact first so a rename
    is never papered over; normalised second so a space-for-underscore edit does not read as a
    missing stage. PROD and PROD_TAG normalise differently, so they can never be confused.
    """
    for stage in definition.get("environments") or []:
        if (stage.get("name") or "") == stage_name:
            return stage
    want = _kv_norm_stage(stage_name)
    for stage in definition.get("environments") or []:
        if _kv_norm_stage(stage.get("name") or "") == want:
            return stage
    return None


def _kv_build_arg_value(build_args, name):
    """What one NAME=... line of a Docker buildArguments block holds. None when the line is absent.

    Mirrors kvsync's reader with one deliberate tightening: the name is matched the way this file's
    own _apply_build_arg matches it (split on the first '=', then strip) rather than by a bare
    "NAME=" prefix, and comment lines are skipped. Read and write therefore agree by construction
    -- a reader that found a line the writer would not rewrite is how a sync reports success and
    changes nothing.
    """
    for line in str(build_args or "").replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        if stripped.split("=", 1)[0].strip() == name:
            return stripped.split("=", 1)[1].strip()
    return None


def _kv_build_arg_task(stage, row):
    """The Docker task whose buildArguments actually carries this variable, or None.

    Prefers the task the plan named, then one that really builds: the same Docker task id serves
    build and push, Azure DevOps only reads buildArguments on a build, and a push task's copy is
    inert (see _task_builds_image -- CD-Ecom-Tabby UAT carries 17 live arguments on `build` against
    5 stale ones on `Push`). Writing the stale copy would report a rotation that changed nothing.
    """
    candidates = []
    for phase in stage.get("deployPhases") or []:
        for task in phase.get("workflowTasks") or []:
            inputs = task.get("inputs") or {}
            if not inputs.get("buildArguments"):
                continue
            if _kv_build_arg_value(inputs["buildArguments"], row["pipelineName"]) is None:
                continue
            candidates.append(task)
    wanted = str(row.get("task") or "").strip().lower()
    if wanted:
        # Case-insensitively: the plan records the task name as the definition spelled it, and the
        # same task is spelled build / Build / BUILD across these definitions.
        for task in candidates:
            if str(task.get("name") or "").strip().lower() == wanted:
                return task
    for task in candidates:
        if _task_builds_image(task):
            return task
    # Nothing that builds carries this variable. When the plan named a task, the only copy left in
    # view belongs to a task Azure DevOps never reads, so this destination is reported ABSENT
    # rather than rotated: writing the inert copy would report a rotation that changed nothing, and
    # reading it would classify the destination by a value nobody maintains.
    return None if wanted else (candidates[0] if candidates else None)


def _kv_destination(row, definition, vault_hash, history_hashes):
    """One Destination record for the contract, for one plan row against one live definition.

    THE CLASSIFICATION IS THE WHOLE SAFETY STORY, so it is spelled out. Mirrors
    kvsync._classify_destinations:

      match     the destination already holds the vault's current value -- nothing to do.
      behind    it holds a value this vault entry USED to hold. The vault is the source of truth,
                so it is merely stale and a sync overwrites it. This is the normal rotation case.
      unknown   it holds a value this vault entry has NEVER held. That does not mean "old" -- it
                means one vault entry is mapped to services which do not in fact share the
                credential, so pushing would hand a service somebody else's. A sync must refuse.
      padlocked a secret-marked stage variable. Azure DevOps will not read it back, so it cannot be
                compared with anything.
      empty     present but blank.
      reference holds a $(VARIABLE) macro, so the real value lives somewhere else.
      absent    the variable is not there at all -- the plan no longer matches the pipeline.

    Getting 'behind' and 'unknown' the wrong way round is the one mistake here that silently breaks
    a live service, which is why the history check is a membership test against every version the
    entry has ever held, not a comparison with the current one.
    """
    kind = "build-argument" if str(row["placement"]).startswith(("C", "D")) else "stage-variable"
    dest = {
        "project": row["project"],
        "defId": row["defId"],
        "defName": row.get("defName") or "",
        "stage": row["stage"],
        "variable": row["pipelineName"],
        "kind": kind,
        "placement": str(row["placement"])[:1],
        "state": "absent",
        "currentHash": None,
        "length": None,
    }
    if not isinstance(definition, dict):
        return dest
    stage = _kv_find_stage(definition, row["stage"])
    if stage is None:
        return dest

    if kind == "stage-variable":
        meta = (stage.get("variables") or {}).get(row["pipelineName"])
        if meta is None:
            return dest
        if isinstance(meta, dict):
            if meta.get("isSecret"):
                dest["state"] = "padlocked"
                return dest
            raw = meta.get("value")
        else:
            raw = meta
    else:
        task = _kv_build_arg_task(stage, row)
        if task is None:
            return dest
        raw = _kv_build_arg_value((task.get("inputs") or {}).get("buildArguments"),
                                  row["pipelineName"])
        if raw is None:
            return dest

    text = "" if raw is None else str(raw)
    dest["length"] = len(text)
    if not text.strip():
        dest["state"] = "empty"
        return dest
    if text.strip().startswith("$("):
        dest["state"] = "reference"
        return dest

    dest["currentHash"] = _kv_hash(text)
    if vault_hash and dest["currentHash"] == vault_hash:
        dest["state"] = "match"
    elif dest["currentHash"] in (history_hashes or ()):
        dest["state"] = "behind"
    else:
        dest["state"] = "unknown"
    return dest


def _kv_read_definitions(keys):
    """{(project, defId): definition} fetched concurrently, with the failures reported separately.

    Not cached, on purpose. A release definition carries live credentials in plaintext, so the one
    place this process holds one is inside the request that needs it. The cached thing is the vault
    history, which is the expensive read and contains only hashes.
    """
    defs, errors = {}, {}

    def one(project, def_id):
        return _get("%s/release/definitions/%s?api-version=%s"
                    % (release_base(project), def_id, API_VERSION))

    futures = {_keyvault_pool.submit(one, p, d): (p, d) for p, d in keys}
    for fut in as_completed(futures):
        key = futures[fut]
        try:
            defs[key] = fut.result()
        except Exception as exc:
            errors[key] = type(exc).__name__
    return defs, errors


# --------------------------------------------------------------------------- the status snapshot --

def _kv_snapshot(env: str):
    """Everything the status route returns, and the input every write route plans from.

    Returns (payload, values, rows, definitions). `values` carries plaintext and never leaves this
    process: the payload built from it holds hashes, lengths and version ids only.
    """
    vault_name = KEYVAULT_VAULTS.get(env) or ""
    base = {
        "ok": False,
        "connected": False,
        "env": env,
        "vault": vault_name,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "totals": {"secrets": 0, "filled": 0, "placeholders": 0, "destinations": 0,
                   "match": 0, "behind": 0, "unknown": 0, "other": 0},
        "blocked": False,
        "services": [],
        "secrets": [],
        "message": "",
    }

    rows, plan_error = _kv_plan_rows(env)
    if plan_error:
        base["message"] = plan_error
        return base, {}, [], {}

    client, client_error = _kv_client(env)
    if client is None:
        base["message"] = client_error
        return base, {}, rows, {}

    names, names_error = _kv_names(client)
    if names_error:
        base["message"] = names_error
        return base, {}, rows, {}

    wanted = sorted({r["secretName"] for r in rows})
    present = [n for n in wanted if n in names]
    values, value_errors = _kv_current_values(client, present)

    histories, history_errors = {}, {}

    def hist(name):
        return _kv_history(client, name)

    futures = {_keyvault_pool.submit(hist, n): n for n in present}
    for fut in as_completed(futures):
        name = futures[fut]
        try:
            histories[name] = fut.result()
        except RuntimeError as exc:
            # _kv_history raises these itself, with a message built here and known to carry no
            # value -- only a secret name, a version id and an exception TYPE. That message is the
            # whole point: a partial history must never be mistaken for a clean one.
            history_errors[name] = str(exc)
        except Exception as exc:
            history_errors[name] = ("the version history of this entry could not be read (%s)"
                                    % type(exc).__name__)

    def_keys = sorted({(r["project"], r["defId"]) for r in rows})
    definitions, def_errors = _kv_read_definitions(def_keys)

    plain_values = {n: v for n, (v, _ver) in values.items() if _kv_is_filled(v)}

    by_secret = {}
    for row in rows:
        by_secret.setdefault(row["secretName"], []).append(row)

    secret_rows, totals = [], dict(base["totals"])
    for name in wanted:
        group = by_secret[name]
        value, version = values.get(name, (None, None))
        filled = _kv_is_filled(value)
        vault_hash = _kv_hash(value) if filled else None
        history = histories.get(name) or []
        history_hashes = {h["hash"] for h in history if h["filled"]}
        previous = next((h["hash"] for h in history
                         if h["filled"] and h["hash"] != vault_hash), None)

        destinations, counts = [], {"match": 0, "behind": 0, "unknown": 0, "other": 0}
        for row in group:
            dest = _kv_destination(row, definitions.get((row["project"], row["defId"])),
                                   vault_hash, history_hashes)
            destinations.append(dest)
            counts[dest["state"] if dest["state"] in counts else "other"] += 1

        note = ""
        if name not in names:
            note = "not in the vault -- nothing to push from"
        elif name in value_errors:
            note = "the current version could not be read (%s)" % value_errors[name]
        elif not filled:
            note = "still holding the %s placeholder -- a sync skips it" % KEYVAULT_SENTINEL
        elif name in history_errors:
            note = history_errors[name]

        secret_rows.append({
            "name": name,
            "service": _kv_service_of(group[0]),
            "variables": sorted({r["pipelineName"] for r in group}),
            "vaultState": "set" if filled else "placeholder",
            "vaultHash": vault_hash,
            "vaultLength": len(value) if filled else None,
            "versionCount": len(history),
            "previousHash": previous,
            "canRollback": bool(filled and previous),
            "currentVersion": version,
            "destinations": destinations,
            "counts": counts,
            "message": note,
        })

        totals["secrets"] += 1
        totals["filled" if filled else "placeholders"] += 1
        totals["destinations"] += len(destinations)
        for k in ("match", "behind", "unknown", "other"):
            totals[k] += counts[k]

    # 'blocked' only counts an unknown destination on a secret the vault can actually push. An
    # unfilled placeholder entry has never held anything, so EVERY literal under it reads as
    # 'unknown' -- letting those set this flag would disable Sync for the whole environment over
    # two entries a sync already skips, which is the opposite of the warning's purpose. Documented
    # as a refinement of the contract sentence, not a change to what 'unknown' means.
    def _blocking(secret):
        return (secret["vaultState"] == "set"
                and any(d["state"] == "unknown" for d in secret["destinations"]))

    services = {}
    for secret in secret_rows:
        svc = services.setdefault(secret["service"], {
            "service": secret["service"], "secrets": 0, "destinations": 0,
            "counts": {"match": 0, "behind": 0, "unknown": 0, "other": 0},
            "canRollback": False, "blocked": False})
        svc["secrets"] += 1
        svc["destinations"] += len(secret["destinations"])
        for k in svc["counts"]:
            svc["counts"][k] += secret["counts"][k]
        svc["canRollback"] = svc["canRollback"] or secret["canRollback"]
        svc["blocked"] = svc["blocked"] or _blocking(secret)

    problems = [s["message"] for s in secret_rows if s["message"]]
    payload = dict(base)
    payload.update({
        "ok": True,
        "connected": True,
        "totals": totals,
        "blocked": any(_blocking(s) for s in secret_rows),
        "services": sorted(services.values(), key=lambda s: s["service"]),
        "secrets": secret_rows,
        "message": ("%d secret(s) need attention before a sync covers everything -- see the rows."
                    % len(problems)) if problems else "",
    })
    if def_errors:
        payload["message"] = ((payload["message"] + " ") if payload["message"] else "") + (
            "%d release definition(s) could not be read, so their destinations are reported as "
            "absent: %s." % (len(def_errors),
                             ", ".join("%s/%s" % k for k in sorted(def_errors)[:6])))
    return payload, plain_values, rows, definitions


# ------------------------------------------------------------------------------ the write engine --

def _kv_apply_to_stage(stage, row, value):
    """Put `value` where this one plan row says the pipeline reads it. (ok, note).

    Mirrors kvsync._push_direct's two write shapes:

      A/B stage variable  -- written PLAIN. Verified on this org: a release-DEFINITION variable
                             marked secret does not persist through the REST API; the padlock is
                             accepted and the value is silently lost. Writing it plain is the only
                             form that survives, and it is how the pipeline already stores the other
                             hundreds. allowOverride is carried forward rather than reset, so a
                             rotation changes the value and nothing else about the entry.
      C/D build argument  -- one line of the Docker task's buildArguments, through this file's own
                             _apply_build_arg, which rewrites NAME=... in place and leaves every
                             other byte of the block alone.
    """
    if not str(row["placement"]).startswith(("C", "D")):
        variables = stage.setdefault("variables", {})
        existing = variables.get(row["pipelineName"])
        allow_override = bool(existing.get("allowOverride")) if isinstance(existing, dict) else False
        variables[row["pipelineName"]] = {
            "value": value, "allowOverride": allow_override, "isSecret": False}
        was_secret = isinstance(existing, dict) and bool(existing.get("isSecret"))
        return True, ("the padlock was dropped: Azure DevOps does not persist a secret "
                      "release-definition variable, so a padlocked copy cannot be rotated in place"
                      if was_secret else "")
    task = _kv_build_arg_task(stage, row)
    if task is None:
        return False, "no Docker task on this stage carries %s in its build arguments" % (
            row["pipelineName"])
    inputs = task.setdefault("inputs", {})
    new_text, found = _apply_build_arg(inputs.get("buildArguments") or "",
                                       row["pipelineName"], value)
    if not found:
        return False, "the %s= line is no longer in task '%s'" % (row["pipelineName"],
                                                                  task.get("name"))
    inputs["buildArguments"] = new_text
    return True, ""


def _kv_push(env, scope_rows, values, snapshot, definitions, dry_run):
    """Push the vault values to every in-scope destination. (results, totals, refused).

    Per-destination best-effort with per-destination results, in the style of
    /api/env-vars/bulk-update: one definition that has drifted from the plan must not stop the
    other nineteen. WITHIN one definition the write stays all-or-nothing, and the definition is
    only saved when no stage other than the targeted ones would change -- kvsync has that same
    guard and it has already stopped one accident.
    """
    index = {s["name"]: s for s in snapshot.get("secrets") or []}
    # Keyed on the PLACEMENT as well as the name. 35 prod rows and 54 UAT rows are an A row (the
    # stage variable) and a D row (the build-arg line that reads it) for the same definition, stage
    # and variable -- two different destinations, routinely in two different states. Leaving the
    # placement out of the key makes one silently shadow the other in this index, and the sync
    # would then classify the stage variable by what the build-arg line holds.
    dest_index = {}
    for secret in snapshot.get("secrets") or []:
        for dest in secret["destinations"]:
            dest_index[(secret["name"], dest["project"], dest["defId"], dest["stage"],
                        dest["variable"], dest["placement"])] = dest

    def row_key(row):
        return (row["secretName"], row["project"], row["defId"], row["stage"],
                row["pipelineName"], str(row["placement"])[:1])

    def record(row, dest, action, message, before=None, after=None):
        return {
            "secret": row["secretName"],
            "service": _kv_service_of(row),
            "project": row["project"],
            "defId": row["defId"],
            "defName": row.get("defName") or "",
            "stage": row["stage"],
            "variable": row["pipelineName"],
            "kind": (dest or {}).get("kind") or (
                "build-argument" if str(row["placement"]).startswith(("C", "D"))
                else "stage-variable"),
            "placement": str(row["placement"])[:1],
            "state": (dest or {}).get("state") or "absent",
            "action": action,
            "hashBefore": (dest or {}).get("currentHash"),
            "hashAfter": _kv_hash(values[row["secretName"]]) if (
                action == "written" and row["secretName"] in values) else (
                (dest or {}).get("currentHash")),
            "revisionBefore": before,
            "revisionAfter": after,
            "message": message,
        }

    results, refused = [], []
    groups = {}
    for row in scope_rows:
        groups.setdefault((row["project"], row["defId"], row.get("defName") or ""), []).append(row)

    for (project, def_id, _def_name), group in sorted(groups.items()):
        definition = definitions.get((project, def_id))
        if not isinstance(definition, dict):
            for row in group:
                results.append(record(row, dest_index.get(row_key(row)), "failed",
                                      "release definition %s/%s could not be read" % (project,
                                                                                      def_id)))
            continue

        working = json.loads(json.dumps(definition))
        revision_before = working.get("revision")
        pending, deferred = [], []

        for row in group:
            dest = dest_index.get(row_key(row))
            secret = index.get(row["secretName"]) or {}
            if row["secretName"] not in values:
                deferred.append(record(row, dest, "failed",
                                       secret.get("message")
                                       or "the vault has no usable value for this entry"))
                continue
            state = (dest or {}).get("state") or "absent"
            if state == "unknown":
                # The one case worth stopping for. Never written, in any mode.
                refused.append(dest)
                deferred.append(record(
                    row, dest, "refused",
                    "this destination holds a value the vault entry has never held, so one entry "
                    "is mapped to services that do not share the credential -- pushing would give "
                    "a service the wrong one. Give each service its own vault entry first."))
                continue
            if state == "match":
                deferred.append(record(row, dest, "unchanged",
                                       "already holds the vault's current value"))
                continue
            if state == "reference":
                # kvsync's direct push would overwrite the macro with a literal. That turns an
                # indirection into a hardcoded credential, which is the problem this whole feature
                # exists to remove, so this portal leaves it alone: the backing variable is the
                # real destination and the plan carries its own row for it.
                deferred.append(record(
                    row, dest, "unchanged",
                    "holds a $(...) macro and resolves elsewhere -- left as a reference; the "
                    "backing variable is the destination that gets written"))
                continue
            if state == "absent":
                # No blind creation, the same rule /api/env-vars/update follows. The plan is
                # generated from the live pipelines, so 'absent' means the pipeline changed since
                # -- inventing the variable would be a guess about a credential.
                deferred.append(record(
                    row, dest, "failed",
                    "not present on this stage any more -- the routing table is out of date for "
                    "this definition. Regenerate the plan and re-read the status."))
                continue
            if state not in _KEYVAULT_WRITEABLE:
                deferred.append(record(row, dest, "unchanged", "nothing to do for state '%s'"
                                       % state))
                continue
            pending.append((row, dest))

        if not pending:
            results.extend(deferred)
            continue

        targeted = {row["stage"] for row, _ in pending}
        applied, failures = [], []
        for row, dest in pending:
            stage = _kv_find_stage(working, row["stage"])
            if stage is None:
                failures.append(record(row, dest, "failed",
                                       "stage '%s' is not on this definition" % row["stage"]))
                continue
            ok, note = _kv_apply_to_stage(stage, row, values[row["secretName"]])
            if ok:
                applied.append((row, dest, note))
            else:
                failures.append(record(row, dest, "failed", note))

        if not applied:
            results.extend(deferred + failures)
            continue

        # Refuse the whole definition if a stage nobody targeted would change. Compared by name,
        # not by position, so a reordered or added stage cannot be read as an edit to a different
        # one.
        original_stages = {s.get("name"): s for s in definition.get("environments") or []}
        collateral = []
        for stage in working.get("environments") or []:
            name = stage.get("name")
            if name in targeted or _kv_norm_stage(name) in {_kv_norm_stage(t) for t in targeted}:
                continue
            before = original_stages.get(name)
            if before is None or json.dumps(stage, sort_keys=True, default=str) != json.dumps(
                    before, sort_keys=True, default=str):
                collateral.append(name or "?")
        if collateral:
            for row, dest, _note in applied:
                failures.append(record(
                    row, dest, "failed",
                    "refused: saving this definition would also change stage(s) %s, which nothing "
                    "asked for" % ", ".join(sorted(set(collateral))), revision_before, None))
            results.extend(deferred + failures)
            continue

        if dry_run:
            for row, dest, note in applied:
                results.append(record(
                    row, dest, "written",
                    ("dry run -- nothing was written. " + note).strip(),
                    revision_before, None))
            results.extend(deferred + failures)
            continue

        try:
            response = _put("%s/release/definitions?api-version=%s"
                            % (release_base(project), API_VERSION), working)
        except Exception as exc:
            for row, dest, _note in applied:
                failures.append(record(row, dest, "failed",
                                       "write to Azure DevOps failed (%s)" % type(exc).__name__,
                                       revision_before, None))
            results.extend(deferred + failures)
            continue
        if response.status_code >= 400:
            hint = ""
            if response.status_code in (401, 403):
                hint = (" -- the Azure DevOps token this portal uses cannot edit release "
                        "definitions; it needs Release 'manage' scope")
            for row, dest, _note in applied:
                failures.append(record(
                    row, dest, "failed",
                    "Azure DevOps rejected the write: HTTP %s%s" % (response.status_code, hint),
                    revision_before, None))
            results.extend(deferred + failures)
            continue
        try:
            revision_after = response.json().get("revision")
        except ValueError:
            revision_after = None

        # Read-back, because the padlock lesson was learned exactly this way: ADO accepted a write
        # and did not keep it. Hashes only.
        try:
            saved = _get("%s/release/definitions/%s?api-version=%s"
                         % (release_base(project), def_id, API_VERSION))
        except Exception:
            saved = None
        for row, dest, note in applied:
            expected = _kv_hash(values[row["secretName"]])
            verified = None
            if isinstance(saved, dict):
                back = _kv_destination(row, saved, expected, {expected})
                verified = back["currentHash"] == expected
            if verified is False:
                results.append(record(
                    row, dest, "failed",
                    "Azure DevOps accepted the write but the read-back does not match -- the "
                    "value did not persist. " + note, revision_before, revision_after))
            else:
                results.append(record(
                    row, dest, "written",
                    (note + (" Read-back not confirmed (the definition could not be re-read)."
                             if verified is None else "")).strip(),
                    revision_before, revision_after))
        results.extend(deferred + failures)

    totals = {
        "written": sum(1 for r in results if r["action"] == "written"),
        "unchanged": sum(1 for r in results if r["action"] == "unchanged"),
        "refused": sum(1 for r in results if r["action"] == "refused"),
        "failed": sum(1 for r in results if r["action"] == "failed"),
    }
    results.sort(key=lambda r: (r["secret"], r["project"], r["defId"], r["stage"], r["variable"]))
    return results, totals, [d for d in refused if d]


# ------------------------------------------------------------------------------- run bookkeeping --

_KEYVAULT_RUN_ID = re.compile(r"^[0-9A-Za-z._\-]{1,120}$")


def _kv_record_run(record: dict) -> None:
    """Append-only audit of every sync and rollback, on the same PVC as the deploy runs.

    Follows _record_env_change exactly, including the rule that matters most: NO VALUE is recorded.
    A record holds hashes, lengths, version ids, revisions, who and when. Dry runs are recorded too
    -- unlike the env-vars audit, because here the response hands the caller a runId and the run
    list IS this feature's history; the record says dryRun: true and reports nothing written.
    """
    try:
        KEYVAULT_RUNS_DIR.mkdir(parents=True, exist_ok=True)
        (KEYVAULT_RUNS_DIR / ("%s.json" % record["runId"])).write_text(
            json.dumps(record, indent=2, default=str), encoding="utf-8")
    except Exception as exc:
        print("key rotation run record write failed:", type(exc).__name__)


def _kv_new_run_id(action: str, env: str) -> str:
    """A filename-safe, UNIQUE id of the documented shape, e.g. 2026-10-09T12-00-00_sync_uat.

    The suffix exists because the timestamp is only second-resolution: a rehearsal dry run followed
    immediately by the real thing lands in the same second, and without this the second record
    silently overwrote the first -- so the history would show the rehearsal and lose the run that
    actually changed the estate. Measured, not theoretical: it happened on the first full pass of
    the offline test.
    """
    base = "%s_%s_%s" % (datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S"), action, env)
    candidate, n = base, 1
    while (KEYVAULT_RUNS_DIR / ("%s.json" % candidate)).exists() and n < 100:
        n += 1
        candidate = "%s-%d" % (base, n)
    return candidate


def _kv_scope_rows(rows, snapshot, services, secrets):
    """Which plan rows one write covers.

    `secrets` takes precedence over `services`, per the contract. Both null means every secret the
    vault can push -- which is what "all at once" means on rotation day, and what makes the
    individual-service selection a narrowing of the same single operation rather than a second one.
    """
    service_of = {s["name"]: s["service"] for s in snapshot.get("secrets") or []}
    if secrets:
        wanted = {str(s).strip() for s in secrets if str(s).strip()}
        known = set(service_of)
        unknown = sorted(wanted - known)
        return [r for r in rows if r["secretName"] in wanted], unknown
    if services:
        wanted = {str(s).strip() for s in services if str(s).strip()}
        known = {s["service"] for s in snapshot.get("services") or []}
        unknown = sorted(wanted - known)
        return [r for r in rows if service_of.get(r["secretName"]) in wanted], unknown
    return list(rows), []


def _kv_env_or_error(payload_or_args, key="env"):
    env = str((payload_or_args.get(key) or "")).strip().lower()
    if env not in KEYVAULT_VAULTS:
        return "", (jsonify({"ok": False,
                             "message": "env must be 'uat' or 'prod'"}), 400)
    return env, None


# ------------------------------------------------------------------------------------- the routes --

@app.route("/api/keyvault/status")
@require_role("admin")
def api_keyvault_status():
    """Where every credential stands: the vault against what each pipeline holds.

    Cached for 60 seconds because it costs one read per secret, one per secret VERSION and one per
    release definition; ?refresh=1 forces it. Never carries a value -- hashes, lengths and version
    ids only.
    """
    env, err = _kv_env_or_error(request.args)
    if err:
        return err
    refresh = str(request.args.get("refresh") or "").lower() in ("1", "true", "yes")
    if not refresh:
        with _keyvault_lock:
            hit = _keyvault_status_cache.get(env)
        if hit and (time.monotonic() - hit[0]) < KEYVAULT_STATUS_TTL_SECONDS:
            cached = dict(hit[1])
            cached["cached"] = True
            return jsonify(cached)

    payload, _values, _rows, _defs = _kv_snapshot(env)
    payload["cached"] = False
    if payload.get("connected"):
        with _keyvault_lock:
            _keyvault_status_cache[env] = (time.monotonic(), payload)
    # A 200 carrying connected=false, not a 500: the section then renders an explanation of what is
    # missing instead of an error, the way the Logging Dashboard and the insights panel do.
    return jsonify(payload)


@app.route("/api/keyvault/versions")
@require_role("admin")
def api_keyvault_versions():
    """Every version of one secret, newest first. Hash, length, version id and created time only.

    The secret must be in that environment's routing table. This is not a general-purpose vault
    reader: it answers "what would a rollback go back to" for the entries this feature manages.
    """
    env, err = _kv_env_or_error(request.args)
    if err:
        return err
    name = (request.args.get("secret") or "").strip()
    if not name:
        return jsonify({"ok": False, "message": "secret is required"}), 400

    rows, plan_error = _kv_plan_rows(env)
    if plan_error:
        return jsonify({"ok": False, "connected": False, "message": plan_error, "secret": name,
                        "versions": []})
    if name not in {r["secretName"] for r in rows}:
        return jsonify({"ok": False,
                        "message": "%s is not in the %s routing table" % (name, env.upper()),
                        "secret": name, "versions": []}), 404

    client, client_error = _kv_client(env)
    if client is None:
        return jsonify({"ok": False, "connected": False, "message": client_error,
                        "secret": name, "versions": []})
    try:
        history = _kv_history(client, name,
                              refresh=str(request.args.get("refresh") or "").lower()
                              in ("1", "true", "yes"))
        current = client.get_secret(name)
        current_version = getattr(current.properties, "version", None)
    except RuntimeError as exc:
        # Built in _kv_history and known to be value-free.
        return jsonify({"ok": False, "connected": True, "secret": name, "versions": [],
                        "message": str(exc)}), 502
    except Exception as exc:
        return jsonify({"ok": False, "connected": True, "secret": name, "versions": [],
                        "message": "the version history of %s could not be read (%s)"
                                   % (name, type(exc).__name__)}), 502

    # `filled` is internal bookkeeping; it does not go on the wire.
    versions = [{k: v for k, v in dict(
        version, current=(version["versionId"] == current_version)).items() if k != "filled"}
        for version in history]
    return jsonify({"ok": True, "connected": True, "env": env, "secret": name,
                    "versions": versions})


@app.route("/api/keyvault/sync", methods=["POST"])
@require_role("admin")
def api_keyvault_sync():
    """Push the vault's current values out to the pipelines.

    `services` omitted or null means every service. `dryRun` does every read and every check and
    writes nothing, returning the identical shape -- which is how a rotation gets rehearsed on the
    morning it happens rather than discovered mid-window.
    """
    payload = request.get_json(force=True, silent=True) or {}
    env, err = _kv_env_or_error(payload)
    if err:
        return err
    dry_run = bool(payload.get("dryRun"))
    services = payload.get("services")
    secrets_in = payload.get("secrets")
    if services is not None and not isinstance(services, list):
        return jsonify({"ok": False, "message": "services must be a list or null"}), 400
    if secrets_in is not None and not isinstance(secrets_in, list):
        return jsonify({"ok": False, "message": "secrets must be a list or null"}), 400

    snapshot, values, rows, definitions = _kv_snapshot(env)
    if not snapshot.get("connected"):
        return jsonify({"ok": False, "connected": False, "message": snapshot.get("message", ""),
                        "dryRun": dry_run, "runId": None,
                        "totals": {"written": 0, "unchanged": 0, "refused": 0, "failed": 0},
                        "refused": [], "results": []})

    scope_rows, unknown_scope = _kv_scope_rows(rows, snapshot, services, secrets_in)
    if unknown_scope:
        return jsonify({"ok": False, "message": "unknown %s: %s"
                        % ("secret(s)" if secrets_in else "service(s)",
                           ", ".join(unknown_scope[:8]))}), 400
    if not scope_rows:
        return jsonify({"ok": False, "message": "that selection covers no destinations"}), 400

    results, totals, refused = _kv_push(env, scope_rows, values, snapshot, definitions, dry_run)
    definition_count = len({(r["project"], r["defId"]) for r in results
                            if r["action"] == "written"})
    message = ("%s %d destination(s) across %d definition(s) on %s."
               % ("would update" if dry_run else "updated", totals["written"],
                  definition_count, env.upper()))
    if dry_run:
        message += " Nothing was written."
    if totals["refused"]:
        message += (" %d destination(s) refused: they hold a value this vault entry has never held."
                    % totals["refused"])
    if totals["failed"]:
        message += " %d destination(s) failed -- see the rows." % totals["failed"]
    message += (" New releases pick this up; releases already created do not, and a destination "
                "that is a Docker build argument needs a rebuild rather than a redeploy -- it is "
                "baked into the image.")

    record = {
        "runId": _kv_new_run_id("sync", env),
        "action": "sync",
        "env": env,
        "vault": snapshot.get("vault"),
        "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "by": get_username(),
        "dryRun": dry_run,
        "scope": {"services": services, "secrets": secrets_in},
        "ok": totals["written"] > 0 or (totals["refused"] == 0 and totals["failed"] == 0),
        "message": message,
        "totals": totals,
        "refused": refused,
        "results": results,
    }
    _kv_record_run(record)
    if not dry_run and totals["written"]:
        with _keyvault_lock:
            _keyvault_status_cache.pop(env, None)
    return jsonify(record)


@app.route("/api/keyvault/rollback", methods=["POST"])
@require_role("admin")
def api_keyvault_rollback():
    """Put the vault back to its previous version and push that value out again.

    This is the mid-incident command. Every in-scope secret is set back to its most recent
    DIFFERENT version and then pushed to its own destinations, so one press undoes a rotation
    across the estate -- or, with `services` or `secrets`, for just the one service that broke.

    A secret with no earlier distinct version is skipped, not failed: there is nothing to go back
    to, and reporting that as an error would make a correct partial rollback look broken.
    """
    payload = request.get_json(force=True, silent=True) or {}
    env, err = _kv_env_or_error(payload)
    if err:
        return err
    dry_run = bool(payload.get("dryRun"))
    services = payload.get("services")
    secrets_in = payload.get("secrets")
    if services is not None and not isinstance(services, list):
        return jsonify({"ok": False, "message": "services must be a list or null"}), 400
    if secrets_in is not None and not isinstance(secrets_in, list):
        return jsonify({"ok": False, "message": "secrets must be a list or null"}), 400

    snapshot, values, rows, definitions = _kv_snapshot(env)
    if not snapshot.get("connected"):
        return jsonify({"ok": False, "connected": False, "message": snapshot.get("message", ""),
                        "dryRun": dry_run, "runId": None,
                        "totals": {"written": 0, "unchanged": 0, "refused": 0, "failed": 0},
                        "refused": [], "results": [], "rolledBack": [], "skipped": []})

    client, client_error = _kv_client(env)
    if client is None:
        return jsonify({"ok": False, "connected": False, "message": client_error,
                        "dryRun": dry_run, "runId": None,
                        "totals": {"written": 0, "unchanged": 0, "refused": 0, "failed": 0},
                        "refused": [], "results": [], "rolledBack": [], "skipped": []})

    scope_rows, unknown_scope = _kv_scope_rows(rows, snapshot, services, secrets_in)
    if unknown_scope:
        return jsonify({"ok": False, "message": "unknown %s: %s"
                        % ("secret(s)" if secrets_in else "service(s)",
                           ", ".join(unknown_scope[:8]))}), 400
    if not scope_rows:
        return jsonify({"ok": False, "message": "that selection covers no secrets"}), 400

    index = {s["name"]: s for s in snapshot.get("secrets") or []}
    in_scope = sorted({r["secretName"] for r in scope_rows})

    rolled_back, skipped, vault_notes, restored, histories = [], [], {}, {}, {}

    def skip(name, note, from_hash=None):
        skipped.append(name)
        vault_notes[name] = {"vaultHashFrom": from_hash, "vaultHashTo": None,
                             "vaultVersionRestored": None, "note": note}

    for name in in_scope:
        secret = index.get(name) or {}
        current_hash = secret.get("vaultHash")
        if not secret.get("canRollback"):
            skip(name, secret.get("message")
                 or "no earlier distinct version in the vault -- nothing to roll back to",
                 current_hash)
            continue
        try:
            # Cached from the snapshot a moment ago, and it raises rather than handing back a
            # partial list -- a missing version would turn the one value we are allowed to restore
            # into "no history", which is how the 2026-10-09 rehearsal blocked a correct rollback.
            history = _kv_history(client, name)
        except RuntimeError as exc:
            # Raised by _kv_history itself, with a message built there and known to carry no value.
            skip(name, str(exc), current_hash)
            continue
        except Exception as exc:
            skip(name, "the version history of %s could not be read (%s)"
                 % (name, type(exc).__name__), current_hash)
            continue
        histories[name] = history
        target = next((v for v in history if v["filled"] and v["hash"] != current_hash), None)
        if target is None:
            skip(name, "no earlier distinct version in the vault", current_hash)
            continue

        try:
            previous_value = client.get_secret(name, version=target["versionId"]).value
        except Exception as exc:
            skip(name, "version %s of %s could not be read (%s)"
                 % (str(target["versionId"])[:12], name, type(exc).__name__), current_hash)
            continue
        # Re-read rather than trusted from the cached hash, and the hash re-checked: restoring a
        # value that no longer reads back as what it was recorded as would push an unidentified
        # credential to every destination of this entry.
        if not _kv_is_filled(previous_value) or _kv_hash(previous_value) != target["hash"]:
            skip(name, "the previous version of %s no longer reads back as the value it was "
                       "recorded with -- refusing to restore it" % name, current_hash)
            continue

        note = {"vaultHashFrom": current_hash, "vaultHashTo": target["hash"],
                "vaultVersionRestored": target["versionId"]}
        if dry_run:
            vault_notes[name] = dict(note, note="dry run -- the vault was not changed")
        else:
            try:
                new_version = _kv_set_secret(client, name, previous_value)
            except Exception as exc:
                skip(name, "the vault refused the restore (%s). The managed identity needs the "
                           "'Key Vault Secrets Officer' role to write a version."
                     % type(exc).__name__, current_hash)
                continue
            _kv_forget(client, name)
            rolled_back.append(name)
            vault_notes[name] = dict(
                note, note="restored as new version %s" % str(new_version or "")[:12])
        # The push below uses the value the vault holds NOW, not the one the snapshot read.
        restored[name] = previous_value

    # Re-classify the restored secrets' destinations against the value just restored. A destination
    # still holding the value we rolled away FROM is 'behind', never 'unknown': that value is in
    # this entry's own history, which is exactly what makes a rollback pushable. The history set is
    # built from the pre-rollback list plus the restored hash rather than by re-reading the vault,
    # because _kv_forget has just dropped the cache and a re-read would cost every version again.
    push_values = dict(values)
    push_values.update(restored)
    for secret in snapshot.get("secrets") or []:
        name = secret["name"]
        if name not in restored:
            continue
        new_hash = _kv_hash(restored[name])
        history_hashes = {h["hash"] for h in histories.get(name, []) if h["filled"]}
        history_hashes |= {new_hash, secret.get("vaultHash")}
        history_hashes.discard(None)
        secret["vaultHash"] = new_hash
        secret["destinations"] = [
            _kv_destination(row, definitions.get((row["project"], row["defId"])),
                            new_hash, history_hashes)
            for row in rows if row["secretName"] == name]

    push_rows = [r for r in scope_rows if r["secretName"] in restored]
    results, totals, refused = [], {"written": 0, "unchanged": 0, "refused": 0, "failed": 0}, []
    if push_rows:
        results, totals, refused = _kv_push(env, push_rows, push_values, snapshot, definitions,
                                            dry_run)

    # The three per-secret vault fields ride on every result row for that secret, so one table can
    # show what the vault went from, what it went to, and exactly where that landed -- which is the
    # "show clearly which ones updated where" this screen exists for.
    for row in results:
        extra = vault_notes.get(row["secret"]) or {}
        row["vaultHashFrom"] = extra.get("vaultHashFrom")
        row["vaultHashTo"] = extra.get("vaultHashTo")
        row["vaultVersionRestored"] = extra.get("vaultVersionRestored")

    # A skipped secret still gets its real destination rows, reported as unchanged with the reason.
    # Synthesising one placeholder row per skipped secret instead would leave the UI unable to say
    # which pipelines are still holding the value nobody could roll back.
    for name in skipped:
        extra = vault_notes.get(name) or {}
        secret = index.get(name) or {}
        for dest in secret.get("destinations") or []:
            results.append({
                "secret": name, "service": secret.get("service") or "",
                "project": dest["project"], "defId": dest["defId"], "defName": dest["defName"],
                "stage": dest["stage"], "variable": dest["variable"], "kind": dest["kind"],
                "placement": dest["placement"], "state": dest["state"],
                "action": "unchanged",
                "hashBefore": dest["currentHash"], "hashAfter": dest["currentHash"],
                "revisionBefore": None, "revisionAfter": None,
                "vaultHashFrom": extra.get("vaultHashFrom"), "vaultHashTo": None,
                "vaultVersionRestored": None,
                "message": extra.get("note") or "skipped",
            })
    totals["unchanged"] = sum(1 for r in results if r["action"] == "unchanged")
    results.sort(key=lambda r: (r["secret"], r["project"], r["defId"], r["stage"], r["variable"]))

    definition_count = len({(r["project"], r["defId"]) for r in results
                            if r["action"] == "written"})
    message = ("%s %d secret(s) to their previous version and %s %d destination(s) across %d "
               "definition(s) on %s."
               % ("would roll back" if dry_run else "rolled back", len(restored),
                  "would update" if dry_run else "updated",
                  totals["written"], definition_count, env.upper()))
    if dry_run:
        message += " Nothing was written, in the vault or in Azure DevOps."
    if skipped:
        message += (" %d secret(s) skipped -- no earlier distinct version to go back to."
                    % len(skipped))
    if totals["refused"]:
        message += " %d destination(s) refused -- see the rows." % totals["refused"]
    if totals["failed"]:
        message += " %d destination(s) failed -- see the rows." % totals["failed"]
    message += (" A rotation only reaches a running service when a release is created afterwards, "
                "and a destination that is a Docker build argument needs a rebuild rather than a "
                "redeploy -- it is baked into the image.")

    record = {
        "runId": _kv_new_run_id("rollback", env),
        "action": "rollback",
        "env": env,
        "vault": snapshot.get("vault"),
        "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "by": get_username(),
        "dryRun": dry_run,
        "scope": {"services": services, "secrets": secrets_in},
        "ok": bool(restored) and totals["failed"] == 0,
        "message": message,
        "totals": totals,
        "refused": refused,
        "results": results,
        "rolledBack": rolled_back,
        "skipped": skipped,
    }
    _kv_record_run(record)
    if not dry_run and (rolled_back or totals["written"]):
        with _keyvault_lock:
            _keyvault_status_cache.pop(env, None)
    return jsonify(record)


@app.route("/api/keyvault/runs")
@require_role("admin")
def api_keyvault_runs():
    """Every sync and rollback this portal has run, newest first. Hashes only, never a value."""
    items = []
    if KEYVAULT_RUNS_DIR.exists():
        for path in sorted(glob.glob(str(KEYVAULT_RUNS_DIR / "*.json")), reverse=True)[:100]:
            try:
                record = json.loads(Path(path).read_text(encoding="utf-8"))
            except Exception:
                continue
            # The list view carries the headline only -- a prod rollback record holds 225 result
            # rows, and sending twenty of those to render a history table is what makes a page slow.
            items.append({k: v for k, v in record.items()
                          if k not in ("results", "refused")})
    return jsonify({"ok": True, "items": items})


@app.route("/api/keyvault/runs/<run_id>")
@require_role("admin")
def api_keyvault_run(run_id):
    """One past run in full, in the same shape the sync or rollback returned."""
    # run_id names a file, so it must not be able to escape KEYVAULT_RUNS_DIR -- the same guard
    # /api/deployment-name uses.
    if not run_id or not _KEYVAULT_RUN_ID.match(run_id) or any(
            c in run_id for c in ("/", "\\", "..")):
        return jsonify({"ok": False, "message": "invalid runId"}), 400
    path = KEYVAULT_RUNS_DIR / ("%s.json" % run_id)
    if not path.is_file():
        return jsonify({"ok": False, "message": "run not found"}), 404
    try:
        return jsonify(json.loads(path.read_text(encoding="utf-8")))
    except Exception as exc:
        return jsonify({"ok": False,
                        "message": "that run record could not be read (%s)"
                                   % type(exc).__name__}), 500


@app.route("/", defaults={"path": ""})
@app.route("/<path:path>")
def serve_react(path):
    if path:
        candidate = STATIC_DIR / path
        if candidate.is_file():
            resp = send_from_directory(STATIC_DIR, path)
            # Vite fingerprints everything under assets/ with a content hash, so those URLs are
            # immutable by construction and can be cached hard -- which is also what makes the
            # no-store on index.html cheap.
            if path.startswith("assets/"):
                resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
            return resp
    index_file = STATIC_DIR / "index.html"
    if index_file.is_file():
        return _index_response()
    # Local dev without a built frontend yet -- friendly message instead of a raw 404.
    return jsonify({
        "ok": False,
        "message": "No frontend build found at backend/static/. Run `npm run build` in "
                   "../frontend (or `npm run dev` for local development against http://localhost:5173).",
    }), 404


if __name__ == "__main__":
    print("Magrabi Deployment Portal backend -- http://127.0.0.1:5151")
    print("For local frontend development, run `npm run dev` in ../frontend (proxies /api here).")
    app.run(host="127.0.0.1", port=5151, debug=False)
