/**
 * Which pipelines' variables a viewer may read on every environment, values in full.
 *
 * The list comes from the backend (`variablesOpenAliases` on the portal meta response), which also
 * enforces the rule on /api/env-vars -- this file only decides what to OFFER on screen.
 */

/** Same normalisation as the backend's _normalize_pipeline_name, so a name shown anywhere in the
 * portal (including the live status board) matches the registry's aliases. */
export function normalizePipelineName(name: string): string {
  return name
    .trim()
    .replace(/^[.,;:!?]+|[.,;:!?]+$/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s\-_]+/g, ' ')
}

export function isVariablesOpen(
  openAliases: string[] | undefined,
  pipeline: string | null | undefined,
): boolean {
  if (!pipeline || !openAliases?.length) return false
  return openAliases.includes(normalizePipelineName(pipeline))
}
