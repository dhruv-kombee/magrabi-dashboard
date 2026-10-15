"""A bounded, allowlisted portal trace view. No filesystem, network, auth or application imports.

Trace/span IDs in OTLP JSON are hexadecimal; legacy protobuf JSON can use base64.
The adapter must select the encoding explicitly, never infer it from a string.
Only approved service identities, identifiers, timestamps and numeric status are returned.
Raw span names, attributes, events, links, SQL, URLs and exception messages never leave here.
"""
from __future__ import annotations

import base64
import binascii
import json
import re
from dataclasses import dataclass
from types import MappingProxyType
from typing import Mapping, FrozenSet

MAX_BYTES = 16_000_000
MAX_SPANS = 10_000
MAX_RESOURCE_BATCHES = 512
MAX_SCOPES = 512
MAX_ATTRIBUTES = 512
# Service names are the reviewed OTEL_SERVICE_NAME contract, usually the Deployment name.
# Retail deliberately uses retail-storefront while its Deployment is storefront. Browser
# names are separate identities, never substitutes for an unapproved server. Admission here
# prepares the reader; it does not prove the corresponding application emits traces.
SIT_SERVICES = MappingProxyType({
    "macula-sit": frozenset({"api-gateway", "app-api", "auth-server",
        "batch-processor", "external-api", "integrations", "singlemicro", "macula-dashboard", "macula-dashboard-web"}),
    # The *-web names are the browser apps (Faro app.name = service.name on browser spans); they
    # must be listed BEFORE any site's SDK goes live, or a browser-initiated trace is refused whole.
    "saleor-sit": frozenset({"saleor-admin-api", "saleor-app-api", "saleor-checkout-api",
        "saleor-validator-api", "saleor-worker-1", "saleor-worker-2", "saleor-worker-3",
        "ecom-dashboard-web"}),
    "storefront-sit": frozenset({"storefront", "storefront-checkout", "doctorm-storefront", "doctorm-storefront-checkout",
        "magrabi-storefront-web", "doctorm-storefront-web"}),
    "storefront-retail-sit": frozenset({"retail-storefront", "iclinic-storefront", "rivoli-storefront",
        "shodo-storefront", "zwei-storefront", "magrabi-retail-web", "magrabi-iclinic-web",
        "magrabi-rivoli-web", "magrabi-shodo-web", "magrabi-zwei-web"}),
})
KINDS = {0: "unspecified", 1: "internal", 2: "server", 3: "client", 4: "producer", 5: "consumer"}


class TraceError(ValueError):
    """Public error text is always a fixed code, never an input value."""


class ScopeError(TraceError):
    pass


def validate_trace_id(value: str) -> str:
    # Tempo's search API reports trace IDs with leading zeros stripped, so a caller pasting an ID
    # straight out of Grafana can legitimately arrive with fewer than 32 characters. Pad back to the
    # canonical 32 here, at the one entry point; every downstream check still requires exactly 32.
    # An all-zero ID stays invalid, and anything longer than 32 or non-hex is still rejected.
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-fA-F]{1,32}", value) or int(value, 16) == 0:
        raise TraceError("invalid_trace_id")
    return value.lower().zfill(32)


def _identifier(value, size: int, encoding: str, optional=False):
    if optional and value in (None, ""):
        return None
    if not isinstance(value, str):
        raise TraceError("invalid_span_identifier")
    try:
        if encoding == "hex":
            if not re.fullmatch(r"[0-9a-fA-F]{" + str(size * 2) + r"}", value):
                raise ValueError()
            raw = bytes.fromhex(value)
        elif encoding == "base64":
            if len(value) != 4 * ((size + 2) // 3):
                raise ValueError()
            raw = base64.b64decode(value, validate=True)
            if base64.b64encode(raw).decode("ascii") != value:
                raise ValueError()
        else:
            raise ValueError()
        if len(raw) != size or not any(raw):
            raise ValueError()
        return raw.hex()
    except (ValueError, binascii.Error):
        raise TraceError("invalid_span_identifier") from None


def _object(value):
    if not isinstance(value, dict):
        raise TraceError("invalid_trace_shape")
    return value


def _array(value, limit):
    if not isinstance(value, list) or len(value) > limit:
        raise TraceError("invalid_trace_shape")
    return value


def _number(value, maximum=(1 << 64) - 1):
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        raise TraceError("invalid_numeric_field")
    if isinstance(value, str) and (len(value) > 20 or not re.fullmatch(r"[0-9]+", value)):
        raise TraceError("invalid_numeric_field")
    n = int(value)
    if not 0 <= n <= maximum:
        raise TraceError("invalid_numeric_field")
    return n


def _attrs(items, allowed, *, identity=False):
    selected = {}
    for item in _array(items, MAX_ATTRIBUTES):
        item = _object(item)
        key = item.get("key")
        if not isinstance(key, str):
            raise TraceError("invalid_trace_shape")
        if key not in allowed:
            continue
        if key in selected:
            raise TraceError("duplicate_identity_attribute")
        val = _object(item.get("value", {}))
        # AnyValue is a protobuf oneof. Do not accept malformed/conflicting arms as identity.
        if len(val) != 1 or not set(val) <= ({"stringValue"} if identity else {"stringValue", "intValue"}):
            raise TraceError("invalid_attribute_value")
        arm, selected_value = next(iter(val.items()))
        if arm == "stringValue" and not isinstance(selected_value, str):
            raise TraceError("invalid_attribute_value")
        selected[key] = selected_value
    return selected


def _unique_object(pairs):
    obj = {}
    for key, val in pairs:
        if key in obj:
            raise TraceError("duplicate_json_key")
        obj[key] = val
    return obj


def _reject_constant(_value):
    raise TraceError("invalid_json")


def decode_payload(raw: bytes) -> dict:
    if not isinstance(raw, bytes) or len(raw) > MAX_BYTES:
        raise TraceError("trace_size_limit")
    try:
        return _object(json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_object,
            parse_constant=_reject_constant))
    except (UnicodeError, json.JSONDecodeError, RecursionError, ValueError) as exc:
        if isinstance(exc, TraceError):
            raise
        raise TraceError("invalid_json") from None


@dataclass(frozen=True)
class TracePolicy:
    """An explicit service identity boundary, not a query-string namespace selector."""
    services: Mapping[str, FrozenSet[str]]
    id_encoding: str = "hex"

    def __post_init__(self):
        if self.id_encoding not in ("hex", "base64") or not self.services:
            raise TraceError("invalid_policy")
        # Restrict policies to the explicitly reviewed namespace/service pairs. Expand via review.
        for ns, services in self.services.items():
            if ns not in SIT_SERVICES or not services or not set(services) <= SIT_SERVICES[ns]:
                raise TraceError("invalid_policy")
        object.__setattr__(self, "services", MappingProxyType({ns: frozenset(names) for ns, names in self.services.items()}))


def summarize_trace(raw: bytes, trace_id: str, policy: TracePolicy | None = None) -> dict:
    requested_id = validate_trace_id(trace_id)
    policy = policy or TracePolicy(SIT_SERVICES)
    doc = decode_payload(raw)
    if ("resourceSpans" in doc) == ("batches" in doc):
        raise TraceError("invalid_trace_shape")
    batches = _array(doc.get("resourceSpans", doc.get("batches")), MAX_RESOURCE_BATCHES)
    spans = {}
    total = duplicates = 0
    for batch in batches:
        batch = _object(batch)
        resource = _object(batch.get("resource", {}))
        identity = _attrs(resource.get("attributes", []), {
            "service.name", "k8s.namespace.name", "deployment.environment", "deployment.environment.name"}, identity=True)
        ns, svc = identity.get("k8s.namespace.name"), identity.get("service.name")
        if not isinstance(ns, str) or ns not in policy.services or not isinstance(svc, str) or svc not in policy.services[ns]:
            raise ScopeError("trace_scope_not_verified")
        for key in ("deployment.environment", "deployment.environment.name"):
            if key in identity and identity[key] not in ("sit", ns):
                raise ScopeError("trace_scope_not_verified")
        if "scopeSpans" in batch and "instrumentationLibrarySpans" in batch:
            raise TraceError("invalid_trace_shape")
        scopes = _array(batch.get("scopeSpans", batch.get("instrumentationLibrarySpans", [])), MAX_SCOPES)
        for scope in scopes:
            for span in _array(_object(scope).get("spans", []), MAX_SPANS):
                total += 1
                if total > MAX_SPANS:
                    raise TraceError("trace_span_limit")
                span = _object(span)
                if _identifier(span.get("traceId"), 16, policy.id_encoding) != requested_id:
                    raise TraceError("trace_id_mismatch")
                sid = _identifier(span.get("spanId"), 8, policy.id_encoding)
                parent = _identifier(span.get("parentSpanId"), 8, policy.id_encoding, optional=True)
                if parent == sid:
                    raise TraceError("cyclic_trace")
                start, end = _number(span.get("startTimeUnixNano")), _number(span.get("endTimeUnixNano"))
                if start == 0 or end < start:
                    raise TraceError("invalid_span_time")
                status = _object(span.get("status", {})).get("code", 0)
                # Tempo legacy protobuf JSON can return enum names; OTLP/JSON returns integers.
                if isinstance(status, str):
                    status = {"STATUS_CODE_UNSET": 0, "STATUS_CODE_OK": 1, "STATUS_CODE_ERROR": 2}.get(status, -1)
                if isinstance(status, bool) or not isinstance(status, int) or status not in (0, 1, 2):
                    raise TraceError("invalid_status")
                kind = span.get("kind", 0)
                if isinstance(kind, str):
                    kind = {"SPAN_KIND_" + val.upper(): key for key, val in KINDS.items()}.get(kind, -1)
                if isinstance(kind, bool) or not isinstance(kind, int) or kind not in KINDS:
                    raise TraceError("invalid_span_kind")
                http = _attrs(span.get("attributes", []), {"http.response.status_code", "http.status_code"})
                http_code = None
                for candidate in http.values():
                    code = _number(candidate, 599)
                    if code < 100 or (http_code is not None and code != http_code):
                        raise TraceError("invalid_http_status")
                    http_code = code
                row = {"span_id": sid, "parent_span_id": parent, "namespace": ns, "service": svc,
                    "service_id": ns + "/" + svc, "start_ns": start, "end_ns": end,
                    "kind": KINDS[kind], "otel_status": ("unset", "ok", "error")[status],
                    "http_status_code": http_code, "error_observed": status == 2 or (http_code is not None and http_code >= 500)}
                if sid in spans:
                    if row != spans[sid]:
                        raise TraceError("conflicting_duplicate_span")
                    duplicates += 1
                spans[sid] = row
    if not spans:
        raise TraceError("empty_trace")
    # Iterative O(n) parent walk; no recursion on untrusted trace depth.
    done = set()
    for sid in spans:
        path = set()
        at = sid
        while at in spans and at not in done:
            if at in path:
                raise TraceError("cyclic_trace")
            path.add(at)
            at = spans[at]["parent_span_id"]
        done.update(path)
    trace_start = min(s["start_ns"] for s in spans.values())
    trace_end = max(s["end_ns"] for s in spans.values())
    services, edges = {}, {}
    roots = []
    missing = []
    for s in spans.values():
        duration = (s["end_ns"] - s["start_ns"]) / 1e6
        node = services.setdefault(s["service_id"], {"id": s["service_id"], "namespace": s["namespace"],
            "service": s["service"], "span_count": 0, "error_span_count": 0,
            "span_duration_sum_ms": 0.0, "max_span_duration_ms": 0.0,
            "first_start_ns": s["start_ns"], "last_end_ns": s["end_ns"]})
        node["span_count"] += 1
        node["error_span_count"] += int(s["error_observed"])
        node["span_duration_sum_ms"] += duration
        node["max_span_duration_ms"] = max(node["max_span_duration_ms"], duration)
        node["first_start_ns"] = min(node["first_start_ns"], s["start_ns"])
        node["last_end_ns"] = max(node["last_end_ns"], s["end_ns"])
        parent = spans.get(s["parent_span_id"])
        if s["parent_span_id"] is None:
            roots.append(s["span_id"])
        elif parent is None:
            missing.append({"span_id": s["span_id"], "missing_parent_span_id": s["parent_span_id"]})
        elif parent["service_id"] != s["service_id"]:
            key = (parent["service_id"], s["service_id"])
            edge = edges.setdefault(key, {"source": key[0], "target": key[1],
                "evidence": "observed_cross_service_parent_child", "span_relationship_count": 0,
                "child_error_span_count": 0})
            edge["span_relationship_count"] += 1
            edge["child_error_span_count"] += int(s["error_observed"])
    public_spans = []
    for s in sorted(spans.values(), key=lambda x: (x["start_ns"], x["span_id"])):
        row = {k: v for k, v in s.items() if k not in ("start_ns", "end_ns")}
        row.update(start_offset_ms=round((s["start_ns"]-trace_start)/1e6, 6),
            duration_ms=round((s["end_ns"]-s["start_ns"])/1e6, 6))
        public_spans.append(row)
    nodes = []
    for n in services.values():
        start, end = n.pop("first_start_ns"), n.pop("last_end_ns")
        n["observed_window_ms"] = round((end-start)/1e6, 6)
        n["span_duration_sum_ms"] = round(n["span_duration_sum_ms"], 6)
        n["max_span_duration_ms"] = round(n["max_span_duration_ms"], 6)
        n["health"] = "not_inferred_from_one_trace"
        nodes.append(n)
    return {"schema_version": 1, "trace_id": requested_id, "environment": "sit",
        "observation": "returned_trace_spans_only", "start_time_unix_nano": str(trace_start),
        "end_time_unix_nano": str(trace_end), "observed_duration_ms": round((trace_end-trace_start)/1e6, 6),
        "span_count": len(spans), "duplicate_span_count": duplicates,
        "nodes": sorted(nodes, key=lambda n: n["id"]), "edges": sorted(edges.values(), key=lambda e: (e["source"], e["target"])),
        "spans": public_spans, "error_span_ids": sorted(s["span_id"] for s in spans.values() if s["error_observed"]),
        "root_span_ids": sorted(roots), "missing_parents": sorted(missing, key=lambda s: s["span_id"]),
        "known_partial": bool(missing) or len(roots) != 1,
        "complete_end_to_end": "not_established", "root_cause": "not_inferred",
        "latency_semantics": "Span-duration sums overlap; they are not request latency or traffic rates."}
