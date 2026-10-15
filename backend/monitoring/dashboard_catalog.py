"""Reviewed route inventory, GET-verified 2026-09-09; never discovered from user input.

This is configured topology, not proof of traffic, reachability or an observed request path.
beta.magrabi.com shares SIT resources but is deliberately excluded from the SIT endpoint list.
"""
MAPPING_VERIFIED_AT = "2026-09-09"
NAMESPACES = ("macula-sit", "saleor-sit", "saleor-apps-sit", "storefront-sit", "storefront-retail-sit")

# namespace, Service, backing Deployment (None = mapping missing at inventory time)
_COMPONENTS = [
    ("storefront-sit", "magrabi-storefront", "storefront"),
    ("storefront-sit", "magrabi-storefront-checkout", "storefront-checkout"),
    ("storefront-sit", "doctorm-storefront", "doctorm-storefront"),
    ("storefront-sit", "doctorm-storefront-checkout", "doctorm-storefront-checkout"),
    ("storefront-retail-sit", "retail-storefront", "storefront"),
    *[("storefront-retail-sit", n + "-storefront", n + "-storefront") for n in ("iclinic", "rivoli", "shodo", "zwei")],
    *[("saleor-sit", n, n) for n in ("ecom-dashboard", "saleor-app-api", "saleor-validator-api", "saleor-admin-api", "saleor-checkout-api", "graphql-cache")],
    ("saleor-sit", "ecom-promotion-dashboard", None),
    *[("saleor-apps-sit", n + "-app", n + "-app") for n in ("checkout", "search", "paymob", "tabby", "tamara")],
    *[("macula-sit", n, n) for n in ("macula-dashboard", "api-gateway", "app-api", "auth-server", "external-api", "batch-processor", "singlemicro", "integrations")],
]
COMPONENTS = {ns + "/" + service: {"id": ns + "/" + service, "namespace": ns, "service": service,
    "deployment": deployment} for ns, service, deployment in _COMPONENTS}

# Browser app per website host: the Faro `app.name` each site's build sends (= service.name on its
# browser spans). Used by the RUM reader to attribute browser data to a tile. Kept out of ENDPOINTS
# so the endpoint dashboard's response contract does not change.
RUM_APPS = {
    "magrabi-ui-sit.test-magrabi.com": "magrabi-storefront-web",
    "doctorm-ui-sit.test-magrabi.com": "doctorm-storefront-web",
    "magrabi-retail-ui-sit.test-magrabi.com": "magrabi-retail-web",
    "magrabi-iclinic-ui-sit.test-magrabi.com": "magrabi-iclinic-web",
    "magrabi-rivoli-ui-sit.test-magrabi.com": "magrabi-rivoli-web",
    "magrabi-shodo-ui-sit.test-magrabi.com": "magrabi-shodo-web",
    "magrabi-zwei-ui-sit.test-magrabi.com": "magrabi-zwei-web",
    "ecom-dashboard-sit.test-magrabi.com": "ecom-dashboard-web",
    "macula-dashboard-sit.test-magrabi.com": "macula-dashboard-web",
}

def endpoint(id, name, host, type, ns, *services):
    return {"id": id, "name": name, "host": host, "type": type, "component_ids": [ns + "/" + s for s in services]}

ENDPOINTS = [
    endpoint("magrabi", "Magrabi", "magrabi-ui-sit.test-magrabi.com", "website", "storefront-sit", "magrabi-storefront", "magrabi-storefront-checkout"),
    endpoint("doctor-m", "Doctor M", "doctorm-ui-sit.test-magrabi.com", "website", "storefront-sit", "doctorm-storefront", "doctorm-storefront-checkout"),
    *[endpoint(n, title, "magrabi-" + n + "-ui-sit.test-magrabi.com", "website", "storefront-retail-sit", svc)
      for n, title, svc in [("retail", "Magrabi Retail", "retail-storefront"), ("iclinic", "iClinic", "iclinic-storefront"),
        ("rivoli", "Rivoli", "rivoli-storefront"), ("shodo", "Shodo", "shodo-storefront"), ("zwei", "Zwei", "zwei-storefront")]],
    *[endpoint(id, title, id + "-sit.test-magrabi.com", type, ns, service) for id, title, type, ns, service in [
        ("ecom-dashboard", "Saleor Dashboard", "website", "saleor-sit", "ecom-dashboard"),
        ("ecom-promotion-dashboard", "Promotion Dashboard", "website", "saleor-sit", "ecom-promotion-dashboard"),
        ("ecom-app-api", "Saleor App API", "api", "saleor-sit", "saleor-app-api"),
        ("ecom-validator-api", "Saleor Validator API", "api", "saleor-sit", "saleor-validator-api"),
        ("ecom-admin-api", "Saleor Admin API", "api", "saleor-sit", "saleor-admin-api"),
        ("ecom-checkout-api", "Saleor Checkout API", "api", "saleor-sit", "saleor-checkout-api"),
        ("ecom-graphql-cache", "GraphQL Cache", "api", "saleor-sit", "graphql-cache"),
        *[("ecom-" + n, n.title() + " App", "api", "saleor-apps-sit", n + "-app") for n in ("search", "checkout", "paymob", "tabby", "tamara")],
        ("macula-dashboard", "Macula Dashboard", "website", "macula-sit", "macula-dashboard"),
        ("macula-api", "Macula Gateway", "api", "macula-sit", "api-gateway"),
    ]],
]
# Only strong direct upstream references. Browser links/return URLs and ambiguous references
# were excluded. These still do not prove that a particular request traversed the edge.
_DEPENDENCIES = [
    ("storefront-sit/magrabi-storefront", "saleor-sit/saleor-validator-api"),
    ("storefront-sit/magrabi-storefront-checkout", "saleor-sit/saleor-checkout-api"),
    ("storefront-sit/doctorm-storefront", "saleor-sit/saleor-validator-api"),
    ("storefront-sit/doctorm-storefront-checkout", "saleor-sit/saleor-checkout-api"),
    *[("macula-sit/" + a, "macula-sit/" + b) for a, b in [("api-gateway", "app-api"), ("api-gateway", "auth-server"),
        ("api-gateway", "external-api"), ("app-api", "api-gateway"), ("app-api", "singlemicro"), ("auth-server", "singlemicro"),
        ("batch-processor", "singlemicro"), ("external-api", "singlemicro"), ("singlemicro", "integrations")]],
    ("macula-sit/integrations", "saleor-sit/saleor-admin-api"),
    *[("saleor-apps-sit/" + n + "-app", "saleor-sit/saleor-app-api") for n in ("checkout", "paymob", "search", "tabby", "tamara")],
]
EDGES = [{"source": e["id"], "target": c, "evidence": "configured_route"} for e in ENDPOINTS for c in e["component_ids"]] + [
    {"source": a, "target": b, "evidence": "configured_dependency"} for a, b in _DEPENDENCIES]
