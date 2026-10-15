"""Non-secret source definitions for the read-only traffic panel."""
from copy import deepcopy

SUBSCRIPTION = "72bde893-fa26-4129-a31f-648b81a48153"
_PREFIX = f"/subscriptions/{SUBSCRIPTION}/resourceGroups/"
AZURE_RESOURCES = {
    "frontdoor_main": _PREFIX + "rg-mepu-prod-uaenorth-001/providers/Microsoft.Cdn/profiles/frontdoor-ecom-prod-uaenorth-001",
    "ecom_cdn": _PREFIX + "Magrabi-Prod/providers/Microsoft.Cdn/profiles/ecom-cdn",
    "macula_gateway": _PREFIX + "rg-mepu-prod-uaenorth-001/providers/Microsoft.Network/applicationGateways/agw-macula-prod-uaenorth-001",
}
BACKEND_BRANDS = {
    "ecom-storefront-9900": "Magrabi",
    "ecom-storefront-checkout-9902": "Magrabi",
    "ecom-storefront-profile-9903": "Magrabi",
    "storefront-doctorm-sf-3000": "DoctorM",
    "storefront-doctorm-sf-checkout-3001": "DoctorM",
    "storefront-doctorm-sf-browse-ae-3000": "DoctorM",
    "ecom-retail-rivoli-storefront-9900": "Rivoli",
    "ecom-retail-iclinic-storefront-9900": "iClinic",
    "ecom-retail-retail-storefront-9900": "Magrabi Retail Group",
    "ecom-retail-shodo-storefront-9900": "Shodo",
    "ecom-retail-zwei-storefront-9900": "Zwei",
}
CLASSES = (
    "monitoring_telemetry", "internal_or_script_automation", "declared_bot_or_crawler",
    "retained_browser_like", "retained_unknown",
)
CLASS_LABELS = {
    "monitoring_telemetry": "Monitoring / telemetry",
    "internal_or_script_automation": "Internal / scripted automation",
    "declared_bot_or_crawler": "Declared bots / crawlers",
    "retained_browser_like": "Retained browser-like",
    "retained_unknown": "Retained unknown clients",
}
_OVERLAP = "Sources and detail rows overlap; do not add layers or parent/detail rows together."
SOURCES = {
    "frontdoor_main": {
        "id": "frontdoor_main", "label": "Main Front Door", "layer": "edge",
        "url": "https://portal.azure.com/#resource" + AZURE_RESOURCES["frontdoor_main"] + "/metrics",
        "granularity": "exact_status",
        "notes": [_OVERLAP, "Shared production/beta/API/auth/assets profile; endpoint is not a reliable brand or hostname split.",
                  "Platform metrics cannot exclude bots, monitoring or internal traffic."],
    },
    "ecom_cdn": {
        "id": "ecom_cdn", "label": "Separate ECom CDN", "layer": "edge",
        "url": "https://portal.azure.com/#resource" + AZURE_RESOURCES["ecom_cdn"] + "/metrics",
        "granularity": "exact_status", "notes": [_OVERLAP, "All CDN requests, not unique customers."],
    },
    "ecom_ingress": {
        "id": "ecom_ingress", "label": "ECom cluster ingress", "layer": "ingress",
        "url": "https://ecom-grafana.test-magrabi.com", "granularity": "exact_status",
        "notes": [_OVERLAP, "Recorded ingress requests include monitoring, internal calls, beta and preview.",
                  "Query success does not prove lossless log ingestion. 499 means the client closed the connection."],
    },
    "macula_gateway": {
        "id": "macula_gateway", "label": "Macula Application Gateway", "layer": "gateway",
        "url": "https://portal.azure.com/#resource" + AZURE_RESOURCES["macula_gateway"] + "/metrics",
        "granularity": "status_group",
        "notes": [_OVERLAP, "Azure ResponseStatus groups only; exact HTTP 200/500/502/503/504 are unavailable.",
                  "Shared gateway includes OMS and storefront apex redirects. Unclassified preserves the measured group reconciliation remainder."],
    },
    "filtered_storefront": {
        "id": "filtered_storefront", "label": "Filtered production storefront", "layer": "ingress_subset",
        "url": "https://ecom-grafana.test-magrabi.com", "granularity": "exact_status",
        "notes": [_OVERLAP, "Customer-facing proxy, not verified human customers; unknown clients remain separate.",
                  "The overall row retains browser-like and unknown clients. Excluded classes are diagnostic detail, not added to this total.",
                  "Known probes, client telemetry, script/server clients and declared crawler signatures are excluded heuristically.",
                  "Static assets and repeated requests remain; these are not visitor, session or order counts.",
                  "Production backend allowlist is a configuration mapping, not a historical hostname guarantee."],
    },
}
for _source in SOURCES.values():
    _source["notes"].append("Configured means credential settings are present; permissions and source availability are verified only when queried.")


def source_catalog():
    return deepcopy(list(SOURCES.values()))
