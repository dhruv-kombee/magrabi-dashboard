import type {
  ApiMessage,
  BulkUpdateResponse,
  CreateVarResponse,
  DeploymentFilters,
  DeploymentTimeline,
  DeploymentsResponse,
  EnvVarChange,
  EnvVarFindResponse,
  EnvVarsResponse,
  EnvVarsUpdateResponse,
  FeedbackDraft,
  FeedbackItem,
  FeedbackListResponse,
  FeedbackStatus,
  InsightsFunnelResponse,
  GitConfigApplied,
  GitConfigDeployStarted,
  GitConfigPreview,
  GitConfigResponse,
  KeyVaultEnv,
  KeyVaultRollbackRequest,
  KeyVaultRollbackResponse,
  KeyVaultRunRecord,
  KeyVaultRunsResponse,
  KeyVaultStatusResponse,
  KeyVaultSyncRequest,
  KeyVaultSyncResponse,
  KeyVaultVersionsResponse,
  LiveStatusResponse,
  LogInvocationDetail,
  LogInvocationsResponse,
  LogSourcesResponse,
  LogStreamResponse,
  MyDeploymentsResponse,
  PortalMeta,
  ProdApp,
  ProdAppDetail,
  ProdBuild,
  ProdCheck,
  ProdNotRun,
  ProdPlan,
  ProdPlanDetail,
  ProdStepProgress,
  ProdWatchItem,
  Role,
} from './types'

/** Surface the backend's own {ok, message} body when present -- most of this app's error paths
 * (bad login, forbidden route, ADO call failures) all return that shape. Shared so the handful of
 * calls that cannot go through request<T> still fail with the same message the rest of the app
 * shows. Consumes the body, so only call it on a response you are about to discard. */
async function errorMessage(res: Response): Promise<string> {
  try {
    const body = await res.json()
    if (body?.message) return body.message as string
  } catch {
    /* non-JSON error body, fall through to the generic message */
  }
  return `HTTP ${res.status}`
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  })
  if (!res.ok) {
    throw new Error(await errorMessage(res))
  }
  return res.json() as Promise<T>
}

/** Companion to request<T> for endpoints that answer text/plain (task logs). Kept separate rather
 * than adding a mode flag to request<T> because the error path differs too: there is no {message}
 * body to dig out, the body itself IS the message. */
async function requestText(path: string): Promise<string> {
  const res = await fetch(path, { credentials: 'same-origin' })
  const body = await res.text()
  if (!res.ok) {
    throw new Error(body.trim() || `HTTP ${res.status}`)
  }
  return body
}

/** Drops undefined/null/blank params entirely instead of sending `?env=&search=`, because the
 * backend treats a present-but-empty filter as a real (never-matching) value. */
function buildQuery(params: Record<string, string | number | undefined | null>): string {
  const qs = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue
    const text = String(value).trim()
    if (!text) continue
    qs.set(key, text)
  }
  const encoded = qs.toString()
  return encoded ? `?${encoded}` : ''
}

export const fetchIdentity = () => request<{ role: Role }>('/api/me')

export const fetchLiveStatus = () => request<LiveStatusResponse>('/api/live-status')

export const fetchMyDeployments = () => request<MyDeploymentsResponse>('/api/my-deployments')

/** `showHidden` is honoured for admins only -- the backend re-checks the role, so passing it as a
 * viewer changes nothing. Hidden rows come back flagged rather than filtered so each can offer an
 * Unhide button. */
export const fetchDeployments = (filters: DeploymentFilters = {}, showHidden = false) =>
  request<DeploymentsResponse>(
    `/api/deployments${buildQuery({ ...filters, showHidden: showHidden ? '1' : undefined })}`,
  )

/** Hides one board tile for EVERY user, until an admin unhides it. Portal display only -- it never
 * touches Azure DevOps, and the deployment it describes still happened. */
export const postHideDeployment = (id: number, project: string, label?: string) =>
  request<ApiMessage & { hiddenCount?: number }>('/api/deployments/hide', {
    method: 'POST',
    body: JSON.stringify({ id, project, label }),
  })

export const postUnhideDeployment = (id: number, project: string) =>
  request<ApiMessage & { hiddenCount?: number }>('/api/deployments/unhide', {
    method: 'POST',
    body: JSON.stringify({ id, project }),
  })

/** rawEnv, not the normalized DEV/SIT/UAT/PROD bucket -- ADO needs the real environment name to
 * resolve which release environment's deploy steps to read. */
export const fetchDeploymentTimeline = (releaseId: number, rawEnv: string, pipeline: string) =>
  request<DeploymentTimeline>(
    `/api/deployments/${releaseId}/timeline?env=${encodeURIComponent(rawEnv)}&pipeline=${encodeURIComponent(pipeline)}`,
  )

/** A CI build's own stages and steps, in the same shape as the deployment timeline so the drawer
 * can render either with one component. */
export const fetchBuildTimeline = (buildId: number, pipeline: string, project: string) =>
  request<DeploymentTimeline>(
    `/api/builds/${buildId}/timeline${buildQuery({ pipeline, project })}`,
  )

export const fetchPortalMeta = () => request<PortalMeta>('/api/meta')

/** Configured variables for one pipeline stage. Values of anything that looks like a credential are
 * withheld by the backend and never travel over this call at all. */
export const fetchEnvVars = (pipeline: string, env: string) =>
  request<EnvVarsResponse>(`/api/env-vars${buildQuery({ pipeline, env })}`)

/** Settings held in Git for one pipeline stage: the settings file, the services that read each
 * entry, and the pipelines that apply them. Read-only -- there is no write path on this route. */
export const fetchGitConfig = (pipeline: string, env: string) =>
  request<GitConfigResponse>(`/api/git-config${buildQuery({ pipeline, env })}`)

/** Preview for a bulk rotation: which pipelines actually define this variable on this environment.
 * Returns existence and source only, never a value. */
export const fetchEnvVarFind = (name: string, env: string, scope?: 'all') =>
  request<EnvVarFindResponse>(`/api/env-vars/find${buildQuery({ name, env, scope })}`)

/** Creates a variable that does not exist yet, in a named section of one stage.
 *
 * The sections behave completely differently at runtime and putting a value in the wrong one fails
 * silently, so the section is always stated. "auto" is the answer for almost every real request: it
 * adds the stage variable plus every other piece the stage needs -- the build argument that bakes it
 * into the image, and the deploy YAML substitution that gets it into the running pod. */
export const postEnvVarsCreate = (
  pipelines: string[],
  env: string,
  name: string,
  value: string,
  target: 'auto' | 'stage' | 'buildArg' | 'scriptExport' | 'yamlPlaceholder',
  /** Which Docker task's buildArguments to add to. Omitted means EVERY Docker task in the stage,
   * which is what these pipelines want -- Rivoli SIT builds in both `build` and `Push`, and an
   * argument on only one of them silently misses the other image. */
  taskName?: string,
  /** Resolves and validates everything, then stops before writing. */
  dryRun?: boolean,
) =>
  request<CreateVarResponse>('/api/env-vars/create', {
    method: 'POST',
    body: JSON.stringify({ pipelines, env, name, value, target, taskName, dryRun }),
  })

/** Applies one variable change across many pipelines at once. Per-pipeline results: a pipeline that
 * does not carry the variable is reported, not allowed to fail the whole batch. */
export const postEnvVarsBulkUpdate = (
  pipelines: string[],
  env: string,
  changes: EnvVarChange[],
  /** Optional per-pipeline overrides: { pipeline: { VAR: value } }. Lets one submit carry
   * "set these to X, except that one which gets Y". */
  values?: Record<string, Record<string, string>>,
) =>
  request<BulkUpdateResponse>('/api/env-vars/bulk-update', {
    method: 'POST',
    body: JSON.stringify({ pipelines, env, changes, values }),
  })

/** Writes variable values back to the release definition. `revision` is what the caller read, and
 * the backend passes it to ADO so a concurrent edit is rejected rather than silently overwritten. */
export const postEnvVarsUpdate = (
  pipeline: string,
  env: string,
  changes: EnvVarChange[],
  revision: number,
) =>
  request<EnvVarsUpdateResponse>('/api/env-vars/update', {
    method: 'POST',
    body: JSON.stringify({ pipeline, env, changes, revision }),
  })

export const postLogin = (username: string, password: string) =>
  request<{ ok: boolean; role?: Role; message?: string }>('/api/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  })

export const postLogout = () => request<{ ok: boolean }>('/api/logout', { method: 'POST' })

export const postNewDeployment = (text: string, name: string) =>
  request<ApiMessage>('/api/new-deployment', {
    method: 'POST',
    body: JSON.stringify({ text, name }),
  })

export const postRedeployApprove = (releaseId: number, env: string, pipeline: string) =>
  request<ApiMessage>('/api/redeploy-approve', {
    method: 'POST',
    body: JSON.stringify({ releaseId, env, pipeline }),
  })

/** Queues a fresh CI build and runs the whole chain through to approval. Unlike
 * postRedeployApprove this does NOT reuse the existing artifact, so it is the one to use when the
 * build itself failed. Returns as soon as the build is queued -- it does not wait for it.
 *
 * Passing the originating row's runId makes the backend rewrite THAT run instead of creating a
 * second one, so the rebuild updates the row in place rather than adding a duplicate. */
export const postRebuildDeploy = (pipeline: string, branch: string, env: string, runId?: string) =>
  request<ApiMessage>('/api/rebuild-deploy', {
    method: 'POST',
    body: JSON.stringify({ pipeline, branch, env, runId }),
  })

export const postCancelDeployment = (releaseId: number, env: string, pipeline: string) =>
  request<ApiMessage>('/api/cancel-deployment', {
    method: 'POST',
    body: JSON.stringify({ releaseId, env, pipeline }),
  })

/** Sets a run's Name after the fact. Portal bookkeeping only -- never touches Azure DevOps. */
export const postDeploymentName = (runId: string, name: string) =>
  request<ApiMessage & { requestedBy?: string }>('/api/deployment-name', {
    method: 'POST',
    body: JSON.stringify({ runId, name }),
  })

/** Bulk dismiss, for the Backup failed tab's Flush. Each run is re-checked server-side on its own
 * terms, so a row that stopped being dead is kept and reported rather than deleted with the rest. */
export const postDismissDeployments = (runIds: string[]) =>
  request<ApiMessage & { removed?: number; skipped?: { runId: string; reason: string }[] }>(
    '/api/dismiss-deployments',
    { method: 'POST', body: JSON.stringify({ runIds }) },
  )

export const postDismissDeployment = (runId: string) =>
  request<ApiMessage>('/api/dismiss-deployment', {
    method: 'POST',
    body: JSON.stringify({ runId }),
  })

/** Log downloads are plain GET links, not fetch()+blob -- the session cookie rides along on a
 * same-origin navigation automatically, and letting the browser handle the download natively
 * (via the backend's Content-Disposition header) avoids buffering a multi-MB zip in JS memory. */
export function allLogsUrl(releaseId: number, pipeline: string): string {
  return `/api/deployment-logs/all?releaseId=${releaseId}&pipeline=${encodeURIComponent(pipeline)}`
}

export function failedSectionLogsUrl(releaseId: number, env: string, pipeline: string): string {
  return `/api/deployment-logs/failed-section?releaseId=${releaseId}&env=${encodeURIComponent(env)}&pipeline=${encodeURIComponent(pipeline)}`
}

/** Exposed as a URL as well as a fetcher: the same address serves an in-app log pane (fetchTaskLog)
 * and an "open raw" link, and duplicating the query-string construction is how they drift apart. */
export function taskLogUrl(
  releaseId: number,
  rawEnv: string,
  pipeline: string,
  phaseId: number,
  taskId: number,
): string {
  return `/api/deployments/${releaseId}/task-log?env=${encodeURIComponent(rawEnv)}&pipeline=${encodeURIComponent(pipeline)}&phaseId=${phaseId}&taskId=${taskId}`
}

export const fetchTaskLog = (
  releaseId: number,
  rawEnv: string,
  pipeline: string,
  phaseId: number,
  taskId: number,
) => requestText(taskLogUrl(releaseId, rawEnv, pipeline, phaseId, taskId))

/** Deliberately does NOT go through request<T>: this endpoint takes multipart/form-data, and
 * request<T> stamps 'Content-Type: application/json' onto anything with a body. Setting the header
 * by hand is just as wrong -- multipart needs a boundary parameter that only the browser knows, so
 * the header must be left off entirely and derived from the FormData body. */
export async function postFeedback(
  draft: FeedbackDraft,
): Promise<{ ok: boolean; id?: string; message?: string }> {
  const form = new FormData()
  form.set('type', draft.type)
  form.set('title', draft.title)
  form.set('description', draft.description)
  form.set('link', draft.link)
  // An empty file input would otherwise post a zero-byte part named "attachment".
  if (draft.attachment) form.set('attachment', draft.attachment)

  const res = await fetch('/api/feedback', {
    method: 'POST',
    credentials: 'same-origin',
    body: form,
  })
  if (!res.ok) {
    throw new Error(await errorMessage(res))
  }
  return res.json() as Promise<{ ok: boolean; id?: string; message?: string }>
}

export const fetchFeedback = () => request<FeedbackListResponse>('/api/feedback')

export const patchFeedback = (id: string, body: { status?: FeedbackStatus; adminNote?: string }) =>
  request<{ ok: boolean; item: FeedbackItem }>(`/api/feedback/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })

export const deleteFeedback = (id: string) =>
  request<ApiMessage>(`/api/feedback/${encodeURIComponent(id)}`, { method: 'DELETE' })

/** Same reasoning as allLogsUrl: a plain same-origin GET link so the browser fetches (and caches)
 * the image itself with the session cookie attached, rather than shuttling bytes through JS. */
export function feedbackAttachmentUrl(id: string): string {
  return `/api/feedback/${encodeURIComponent(id)}/attachment`
}

/** What adding this setting WOULD change. Writes nothing -- pure dry run. */
export const postGitConfigPreview = (body: {
  pipeline: string; env: string; name: string; value: string; services: string[]
  /** "add" wires a new setting into the chosen services; "setValue" only changes an
   * existing value in the settings file and touches no service file. */
  op?: 'add' | 'setValue'
}) => request<GitConfigPreview>('/api/git-config/preview', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})

/** Commits the change and opens a pull request. On DEV/SIT/UAT the portal also merges it; on PROD
 * it never does, and the backend enforces that rather than trusting this call. */
export const postGitConfigApply = (body: {
  pipeline: string; env: string; name: string; value: string; services: string[]
  /** "add" wires a new setting into the chosen services; "setValue" only changes an
   * existing value in the settings file and touches no service file. */
  op?: 'add' | 'setValue'
}) => request<GitConfigApplied>('/api/git-config/apply', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})

/** Runs one of the two pipelines that apply the change. Lower environments only. */
export const postGitConfigDeploy = (body: {
  pipeline: string; env: string; purpose: 'configmap' | 'workloads'
}) => request<GitConfigDeployStarted>('/api/git-config/deploy', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})

export const fetchProdApps = () =>
  request<{ ok: boolean; apps: ProdApp[]; tiers: string[] }>('/api/production/apps')

export const fetchProdApp = (appKey: string, tier: string) =>
  request<ProdAppDetail>(`/api/production/apps/${encodeURIComponent(appKey)}/${encodeURIComponent(tier)}`)

export const fetchProdNotRun = () => request<ProdNotRun>('/api/production/not-run')

export const fetchProdPlans = () => request<{ ok: boolean; plans: ProdPlan[] }>('/api/production/plans')

export const fetchProdPlan = (planId: string) =>
  request<ProdPlanDetail>(`/api/production/plans/${encodeURIComponent(planId)}`)

export const fetchProdBuilds = (appKey: string, tier: string, stepId: string) =>
  request<{ ok: boolean; alias: string; builds: ProdBuild[]; message?: string }>(
    `/api/production/apps/${encodeURIComponent(appKey)}/${encodeURIComponent(tier)}/builds?stepId=${encodeURIComponent(stepId)}`)

export const createProdPlan = (body: { appKey: string; tier: string; reason: string }) =>
  request<{ ok: boolean; planId: string; message?: string }>('/api/production/plans', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })

/** prepare | start | discard | reject | verify | confirm. There is no approve and no cancel. */
export const prodStepAction = (
  planId: string, stepId: string,
  action: 'prepare' | 'start' | 'discard' | 'reject' | 'verify' | 'confirm',
  body: Record<string, unknown> = {},
) =>
  request<{ ok: boolean; message?: string; note?: string; progress?: ProdStepProgress; checks?: ProdCheck[]; evidence?: string[] }>(
    `/api/production/plans/${encodeURIComponent(planId)}/steps/${encodeURIComponent(stepId)}/${action}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

export const fetchProdWatchlist = () =>
  request<{ ok: boolean; items: ProdWatchItem[]; autoQueued: number }>('/api/production/watchlist')

export const rejectProdApproval = (body: { project: string; approvalId: number; reason?: string }) =>
  request<{ ok: boolean; message?: string }>('/api/production/watchlist/reject', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })

export const fetchLogSources = () => request<LogSourcesResponse>('/api/logs/sources')

/** `since` is the exact timestamp of the newest line already on screen, so the tail neither
 * repeats a line nor drops one that Application Insights indexed late. */
export const fetchLogStream = (key: string, since?: string) =>
  request<LogStreamResponse>(
    `/api/logs/${encodeURIComponent(key)}/stream` + (since ? `?since=${encodeURIComponent(since)}` : ''),
  )

export const fetchLogInvocations = (key: string, hours = 24) =>
  request<LogInvocationsResponse>(
    `/api/logs/${encodeURIComponent(key)}/invocations?hours=${hours}`,
  )

export const fetchLogInvocationDetail = (key: string, invocationId: string) =>
  request<LogInvocationDetail>(
    `/api/logs/${encodeURIComponent(key)}/invocations/${encodeURIComponent(invocationId)}`,
  )


/** Live order / abandonment funnel. `minutes` is the look-back window; the backend clamps it to
 *  between 5 minutes and a week, and caches briefly so a fast refresh cannot hammer the
 *  production order database. */
export const fetchInsightsFunnel = (minutes: number) =>
  request<InsightsFunnelResponse>(`/api/insights/funnel?minutes=${minutes}`)


/* ---------------------------------------------------------------------------------------------
 * Key Rotation (MLC-2635). Every route here is admin-only server-side, and none of them can
 * return a credential value -- only a 10-char SHA-256 prefix, a length and a Key Vault version
 * id. Nothing here touches a cluster or creates a release: it writes Azure DevOps definitions and
 * Key Vault secret versions, and the rotation only reaches a running service when somebody later
 * deploys.
 * --------------------------------------------------------------------------------------------- */

/** Where every credential stands: the vault value against what each pipeline holds.
 *
 * An expensive read -- it fetches every release definition named in the plan file -- which is why
 * the backend caches it for 60 seconds. `refresh` forces past that cache and is for the explicit
 * Refresh button, not for a timer. */
export const fetchKeyVaultStatus = (env: KeyVaultEnv, refresh = false) =>
  request<KeyVaultStatusResponse>(
    `/api/keyvault/status${buildQuery({ env, refresh: refresh ? '1' : undefined })}`,
  )

/** Every version of one secret, newest first, so the page can show exactly which version a
 * rollback would restore. Hashes and lengths only. */
export const fetchKeyVaultVersions = (env: KeyVaultEnv, secret: string) =>
  request<KeyVaultVersionsResponse>(`/api/keyvault/versions${buildQuery({ env, secret })}`)

/** Pushes the vault values out to the pipelines. `services: null` (or omitted) means all of them.
 *
 * Per-destination best-effort, like /api/env-vars/bulk-update: one failing definition is reported
 * on its own row and does not abort the rest. A destination in state 'unknown' is REFUSED, never
 * written. Pass dryRun to get the identical response shape with nothing written. */
export const postKeyVaultSync = (body: KeyVaultSyncRequest) =>
  request<KeyVaultSyncResponse>('/api/keyvault/sync', {
    method: 'POST',
    body: JSON.stringify(body),
  })

/** Puts the vault back to each in-scope secret's most recent DIFFERENT version, then pushes that
 * value to that secret's destinations.
 *
 * `secrets` wins over `services`; both null means every secret that can roll back. A secret with
 * no earlier distinct version comes back as skipped, which is not an error. */
export const postKeyVaultRollback = (body: KeyVaultRollbackRequest) =>
  request<KeyVaultRollbackResponse>('/api/keyvault/rollback', {
    method: 'POST',
    body: JSON.stringify(body),
  })

/** Past sync and rollback runs, newest first.
 *
 * Normalizes the array onto `items` -- /api/env-vars/history, the existing route over this same
 * kind of audit directory, calls it `items`, and reading two spellings in the page is how a
 * missing history silently renders as "no runs yet". */
export async function fetchKeyVaultRuns(): Promise<KeyVaultRunsResponse> {
  const body = await request<
    Omit<KeyVaultRunsResponse, 'items'> & { items?: KeyVaultRunRecord[]; runs?: KeyVaultRunRecord[] }
  >('/api/keyvault/runs')
  return { ...body, items: body.items ?? body.runs ?? [] }
}

/** One past run in full, by its runId, for showing what it did where. */
export const fetchKeyVaultRun = (runId: string) =>
  request<KeyVaultRunRecord & { ok: boolean }>(
    `/api/keyvault/runs/${encodeURIComponent(runId)}`,
  )
