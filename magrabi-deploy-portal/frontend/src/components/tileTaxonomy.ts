/** How the Live Environment Status tiles are grouped and coloured.
 *
 * Both maps are keyed on the NORMALISED pipeline name (lowercase, and `-`/`_`/space all treated
 * alike), the same rule the backend registry uses — so `ecom-tabby`, `ecom tabby` and `Ecom_Tabby`
 * cannot land in different groups.
 *
 * Anything not listed falls through to `backend` / `grey`. That is deliberate: a pipeline added to
 * the registry later shows up in a sane place instead of disappearing, and the grey tells you at a
 * glance that nobody has classified it yet.
 */

export type TileGroup = 'frontend' | 'backend'
export type TileTone = 'green' | 'yellow' | 'blue' | 'grey'

/** Same normalisation as EnvSection's pipelineSortValue and the backend's _normalize_pipeline_name. */
export function normPipeline(name: string): string {
  return (name || '').toLowerCase().replace(/[\s_-]+/g, ' ').trim()
}

/** Things a person looks at in a browser: storefronts, dashboards and the content studios.
 * Everything else — APIs, workers, function apps — is backend. */
const FRONTEND = [
  // Storefronts
  'magrabi storefront',
  'doctor-storefront',
  'magrabi retail',
  'magrabi rivoli',
  'magrabi i-clinic',
  'magrabi shodo',
  'magrabi zwei',
  // Dashboards
  'ecom-dashboard',
  'ecom promotion dashboard',
  'macula dashboard',
  // Content management (Sanity studios)
  'magrabi sanity',
  'drm sanity',
  'magrabi rivoli sanity',
  'magrabi retail sanity',
]

const FRONTEND_SET = new Set(FRONTEND.map(normPipeline))

/** The four colours Sanskar asked for (2026-09-23):
 *  - green  : the main customer-facing sites and the two dashboards that get watched daily
 *  - yellow : the CMS / Sanity studios
 *  - blue   : Saleor core and the Saleor apps
 *  - grey   : everything else
 */
const TONES: Record<TileTone, string[]> = {
  green: ['magrabi storefront', 'doctor-storefront', 'ecom-dashboard', 'macula dashboard'],
  yellow: ['magrabi sanity', 'drm sanity', 'magrabi rivoli sanity', 'magrabi retail sanity'],
  blue: [
    'ecom saleor core',
    'ecom search app',
    'ecom tamara',
    'ecom-tabby',
    'ecom paymob',
    'ecom-checkout-app',
    // Runs in the `saleor` namespace next to core rather than in `saleor-apps`, but it is part of
    // the same Saleor stack, so it reads better blue than grey.
    'ecom graphql cache',
  ],
  grey: [],
}

const TONE_INDEX = new Map<string, TileTone>()
for (const [tone, names] of Object.entries(TONES) as [TileTone, string[]][]) {
  for (const n of names) TONE_INDEX.set(normPipeline(n), tone)
}

export function tileGroup(pipeline: string): TileGroup {
  return FRONTEND_SET.has(normPipeline(pipeline)) ? 'frontend' : 'backend'
}

export function tileTone(pipeline: string): TileTone {
  return TONE_INDEX.get(normPipeline(pipeline)) ?? 'grey'
}

/** True when the application name adds nothing the heading has not already said.
 *
 * The feed carries both `pipeline` ("magrabi storefront") and `application` ("magrabi-storefront"),
 * and for most rows they are the same words with different punctuation — printing both just makes
 * the tile look like it is stuttering. Compared after normalisation so hyphen-vs-space does not
 * count as a difference. */
export function applicationIsRedundant(pipeline: string, application?: string): boolean {
  if (!application) return true
  return normPipeline(application) === normPipeline(pipeline)
}
