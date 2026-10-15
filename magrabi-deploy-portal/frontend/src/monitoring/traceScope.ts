// Exact reviewed SIT resource pairs: mirror backend trace_model.SIT_SERVICES. Admission is
// reader readiness, not evidence of SDK delivery. Retail intentionally reports retail-storefront
// although its Deployment is storefront; browser names are never server identity aliases.
export const servicesByNamespace: Readonly<Record<string, ReadonlySet<string>>> = {
  'macula-sit': new Set(['api-gateway', 'app-api', 'auth-server', 'batch-processor', 'external-api',
    'integrations', 'singlemicro', 'macula-dashboard', 'macula-dashboard-web']),
  'saleor-sit': new Set(['saleor-admin-api', 'saleor-app-api', 'saleor-checkout-api', 'saleor-validator-api',
    'saleor-worker-1', 'saleor-worker-2', 'saleor-worker-3', 'ecom-dashboard-web']),
  'storefront-sit': new Set(['storefront', 'storefront-checkout', 'doctorm-storefront', 'doctorm-storefront-checkout',
    'magrabi-storefront-web', 'doctorm-storefront-web']),
  'storefront-retail-sit': new Set(['retail-storefront', 'iclinic-storefront', 'rivoli-storefront', 'shodo-storefront',
    'zwei-storefront', 'magrabi-retail-web', 'magrabi-iclinic-web', 'magrabi-rivoli-web', 'magrabi-shodo-web', 'magrabi-zwei-web']),
}

// Finite dashboard_catalog.RUM_APPS values, not a suffix heuristic. Pair approval is still
// required: a known browser name in the wrong namespace must not form a Faro query.
export const browserServices: ReadonlySet<string> = new Set(['magrabi-storefront-web', 'doctorm-storefront-web',
  'magrabi-retail-web', 'magrabi-iclinic-web', 'magrabi-rivoli-web', 'magrabi-shodo-web', 'magrabi-zwei-web',
  'ecom-dashboard-web', 'macula-dashboard-web'])
export const maxTraceNodes = Object.values(servicesByNamespace).reduce((sum, names) => sum + names.size, 0)
export function approvedTracePair(namespace: unknown, service: unknown): boolean {
  return typeof namespace === 'string' && Object.hasOwn(servicesByNamespace, namespace)
    && typeof service === 'string' && servicesByNamespace[namespace].has(service)
}
