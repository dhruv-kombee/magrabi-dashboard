import { keepPreviousData, useMutation, useQuery, useQueryClient, useQueries } from '@tanstack/react-query'
import {
  createProdPlan,
  deleteFeedback,
  fetchBuildTimeline,
  fetchDeploymentTimeline,
  fetchDeployments,
  fetchEnvVarFind,
  fetchEnvVars,
  fetchFeedback,
  fetchGitConfig,
  fetchIdentity,
  fetchKeyVaultRun,
  fetchKeyVaultRuns,
  fetchKeyVaultStatus,
  fetchKeyVaultVersions,
  fetchLiveStatus,
  fetchMyDeployments,
  fetchPortalMeta,
  fetchProdApp,
  fetchProdApps,
  fetchProdBuilds,
  fetchProdNotRun,
  fetchProdPlan,
  fetchProdPlans,
  fetchProdWatchlist,
  fetchTaskLog,
  patchFeedback,
  postCancelDeployment,
  postDeploymentName,
  postDismissDeployment,
  postDismissDeployments,
  postEnvVarsBulkUpdate,
  postEnvVarsCreate,
  postEnvVarsUpdate,
  fetchLogSources,
  fetchInsightsFunnel,
  fetchLogInvocations,
  fetchLogInvocationDetail,
  postFeedback,
  postGitConfigApply,
  postGitConfigDeploy,
  postGitConfigPreview,
  postHideDeployment,
  postKeyVaultRollback,
  postKeyVaultSync,
  postLogin,
  postLogout,
  postNewDeployment,
  postRebuildDeploy,
  postRedeployApprove,
  postUnhideDeployment,
  prodStepAction,
  rejectProdApproval,
} from './client'
import type {
  DeploymentFilters,
  EnvVarChange,
  FeedbackDraft,
  FeedbackStatus,
  KeyVaultEnv,
  KeyVaultRollbackRequest,
  KeyVaultSyncRequest,
  MyDeploymentsResponse,
} from './types'

export function useIdentityQuery() {
  return useQuery({
    queryKey: ['identity'],
    queryFn: fetchIdentity,
    // A 401/403 here just means "not logged in" -- not worth retrying.
    retry: false,
  })
}

/** Live environment status. refreshMs is caller-supplied for the same reason as the deployment feed
 * below: MLC-2113 requires the cadence to be user-configurable. A hard-coded interval here would
 * quietly override the user's choice of 30s/60s, so anything above the old constant never took
 * effect. Pass 0 (or rely on `enabled`) to stop polling entirely. */
export function useLiveStatusQuery(enabled: boolean, refreshMs = 15_000) {
  return useQuery({
    queryKey: ['live-status'],
    queryFn: fetchLiveStatus,
    refetchInterval: refreshMs > 0 ? refreshMs : false,
    enabled,
  })
}

/** 2s to match the Live Deployments board. The backend refresher now wakes on any state change
 * rather than sleeping out a fixed interval, so a slower poll here would be the only remaining
 * source of lag between what ADO shows and what this table shows. */
export function useMyDeploymentsQuery(enabled: boolean) {
  return useQuery({
    queryKey: ['my-deployments'],
    queryFn: fetchMyDeployments,
    refetchInterval: 2_000,
    enabled,
  })
}

/** Stage variables for one pipeline+env. Only fetched while the viewer has the panel open, and
 * cached for a while: release definitions change rarely and this is a fairly heavy ADO read
 * (definition + any variable groups). */
export function useEnvVarsQuery(pipeline: string | null, env: string | null, refreshMs = 0) {
  return useQuery({
    // Only pipeline and environment are in the key, so only the stage actually on screen is ever
    // polled -- and switching either one is a different query, which fetches on its own. The
    // filter box is client-side and never triggers a request.
    queryKey: ['env-vars', pipeline, env],
    queryFn: () => fetchEnvVars(pipeline as string, env as string),
    enabled: Boolean(pipeline && env),
    // Zero, not 60s: switching to a stage is a request to see its CURRENT state, and a cached
    // answer from a minute ago is exactly what gets misread as "this is what is configured now".
    staleTime: 0,
    // Caller passes 0 to suspend polling -- see the unsaved-changes guard on the Variables page.
    refetchInterval: refreshMs > 0 ? refreshMs : false,
  })
}

/** The same read as useEnvVarsQuery, for SEVERAL pipelines at once.
 *
 * Deliberately shares the query keys with the single-pipeline hook, so switching between one and
 * many reuses whatever is already cached instead of re-reading every definition.
 *
 * Each pipeline is its own request: one slow or failing definition degrades that row only, rather
 * than emptying the whole table.
 */
export function useEnvVarsQueries(pipelines: string[], env: string | null, refreshMs = 0) {
  return useQueries({
    queries: pipelines.map((p) => ({
      queryKey: ['env-vars', p, env],
      queryFn: () => fetchEnvVars(p, env as string),
      enabled: Boolean(p && env),
      staleTime: 0,
      refetchInterval: refreshMs > 0 ? refreshMs : false,
    })),
  })
}

/** Which pipelines define a given variable on a given environment. Manual only (no auto-fetch):
 * it reads every release definition in both projects, so it runs when the user asks for it. */
export function useEnvVarFindQuery(
  name: string,
  env: string,
  enabled: boolean,
  scope?: 'all',
) {
  return useQuery({
    queryKey: ['env-var-find', name, env, scope ?? 'workingSet'],
    queryFn: () => fetchEnvVarFind(name, env, scope),
    enabled,
    staleTime: 60_000,
  })
}

/** Applies one variable across many pipelines. Invalidates every cached env-vars view afterwards,
 * since any of them could have been one of the targets. */
export function useEnvVarsBulkUpdateMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: {
      pipelines: string[]
      env: string
      changes: EnvVarChange[]
      values?: Record<string, Record<string, string>>
    }) => postEnvVarsBulkUpdate(v.pipelines, v.env, v.changes, v.values),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['env-vars'] })
      void qc.invalidateQueries({ queryKey: ['env-var-find'] })
    },
  })
}

/** Saves a run's Name. Optimistic: the cell shows the new value immediately rather than waiting
 * for the 2s poll, because a name that snaps back for a beat reads as "it did not save". */
export function useDeploymentNameMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { runId: string; name: string }) => postDeploymentName(v.runId, v.name),
    onSuccess: (_d, v) => {
      qc.setQueryData<MyDeploymentsResponse>(['my-deployments'], (prev) =>
        prev
          ? {
              ...prev,
              rows: prev.rows.map((r) =>
                r.runId === v.runId ? { ...r, requestedBy: v.name || '-------' } : r,
              ),
            }
          : prev,
      )
      void qc.invalidateQueries({ queryKey: ['my-deployments'] })
    },
  })
}

/** Creates a new variable across the selected pipelines. */
export function useEnvVarsCreateMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: {
      pipelines: string[]
      env: string
      name: string
      value: string
      target: 'auto' | 'stage' | 'buildArg' | 'scriptExport' | 'yamlPlaceholder'
      taskName?: string
      dryRun?: boolean
    }) => postEnvVarsCreate(v.pipelines, v.env, v.name, v.value, v.target, v.taskName, v.dryRun),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['env-vars'] })
      void qc.invalidateQueries({ queryKey: ['env-var-find'] })
    },
  })
}

/** Saves variable edits, then invalidates the cached view so the table re-reads the definition --
 * including its new revision, without which the very next save would 409 against a stale one. */
export function useEnvVarsUpdateMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: {
      pipeline: string
      env: string
      changes: EnvVarChange[]
      revision: number
    }) => postEnvVarsUpdate(v.pipeline, v.env, v.changes, v.revision),
    onSuccess: (_data, v) => {
      void qc.invalidateQueries({ queryKey: ['env-vars', v.pipeline, v.env] })
    },
  })
}

/** The deployment feed. refreshMs is a caller-supplied value rather than a constant because
 * MLC-2112 requires the auto-refresh interval to be user-configurable (and pausable -- pass 0).
 * Filters live in the queryKey so changing one refetches and caches per filter combination, and
 * keepPreviousData holds the old rows on screen during that refetch instead of flashing empty. */
export function useDeploymentsQuery(
  filters: DeploymentFilters = {},
  refreshMs = 15_000,
  enabled = true,
  showHidden = false,
) {
  return useQuery({
    // showHidden is part of the key: it changes which rows come back, so sharing a cache entry with
    // the normal view would show one mode's rows under the other's toggle.
    queryKey: ['deployments', filters, showHidden],
    queryFn: () => fetchDeployments(filters, showHidden),
    refetchInterval: refreshMs > 0 ? refreshMs : false,
    placeholderData: keepPreviousData,
    enabled,
  })
}

/** Hiding is global, so every cached deployments query is stale afterwards -- invalidate the whole
 * ['deployments'] tree rather than the one key the caller happened to be looking at. */
export function useHideDeploymentMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, project, label }: { id: number; project: string; label?: string }) =>
      postHideDeployment(id, project, label),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['deployments'] })
    },
  })
}

export function useUnhideDeploymentMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, project }: { id: number; project: string }) =>
      postUnhideDeployment(id, project),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['deployments'] })
    },
  })
}

/** Step-by-step view of one release environment. Poll it (refreshMs > 0) only while the deployment
 * is actually live -- ADO's release detail call is far heavier than the bulk feed, so a finished
 * deployment should be fetched once and left alone. */
export function useDeploymentTimelineQuery(
  releaseId: number | null | undefined,
  rawEnv: string,
  pipeline: string,
  enabled = true,
  refreshMs = 0,
) {
  const hasTarget = typeof releaseId === 'number' && rawEnv !== '' && pipeline !== ''
  return useQuery({
    queryKey: ['deployment-timeline', releaseId, rawEnv, pipeline],
    // The ?? 0 is unreachable: `enabled` is false whenever releaseId is missing.
    queryFn: () => fetchDeploymentTimeline(releaseId ?? 0, rawEnv, pipeline),
    refetchInterval: refreshMs > 0 ? refreshMs : false,
    enabled: enabled && hasTarget,
  })
}

/** A build's own steps. Polled while the build is running, since that is exactly when someone is
 * watching it; left alone once it has finished. */
export function useBuildTimelineQuery(
  buildId: number | null | undefined,
  pipeline: string,
  project: string,
  enabled = true,
  refreshMs = 0,
) {
  return useQuery({
    queryKey: ['build-timeline', buildId, pipeline, project],
    queryFn: () => fetchBuildTimeline(buildId ?? 0, pipeline, project),
    refetchInterval: refreshMs > 0 ? refreshMs : false,
    enabled: enabled && typeof buildId === 'number' && buildId > 0,
    retry: false,
  })
}

/** Filter dropdown contents. Long staleTime -- the set of pipelines and applications changes on
 * the order of weeks, so re-fetching it on every mount is pure waste. */
export function usePortalMetaQuery(enabled = true) {
  return useQuery({
    queryKey: ['portal-meta'],
    queryFn: fetchPortalMeta,
    staleTime: 5 * 60_000,
    enabled,
  })
}

/** One task's raw log, as text. Never polled: a task's log is only fetched once the user opens it,
 * and a task that is still running is better re-read by re-opening than by a background timer. */
export function useTaskLogQuery(
  releaseId: number | null | undefined,
  rawEnv: string,
  pipeline: string,
  phaseId: number | null | undefined,
  taskId: number | null | undefined,
  enabled = true,
) {
  const hasTarget =
    typeof releaseId === 'number' && typeof phaseId === 'number' && typeof taskId === 'number'
  return useQuery({
    queryKey: ['task-log', releaseId, rawEnv, pipeline, phaseId, taskId],
    queryFn: () => fetchTaskLog(releaseId ?? 0, rawEnv, pipeline, phaseId ?? 0, taskId ?? 0),
    enabled: enabled && hasTarget,
    // Logs are immutable once written; no reason to re-hit ADO when the pane is reopened.
    staleTime: 60_000,
    retry: false,
  })
}

/** The admin feedback inbox. Admin-only server-side, so callers must gate `enabled` on the role --
 * a viewer session would otherwise retry a guaranteed 403 on a timer. Slow poll: feedback arrives
 * at human speed, unlike the deployment feed. */
export function useFeedbackQuery(enabled: boolean) {
  return useQuery({
    queryKey: ['feedback'],
    queryFn: fetchFeedback,
    refetchInterval: 30_000,
    enabled,
  })
}

export function useLoginMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ username, password }: { username: string; password: string }) =>
      postLogin(username, password),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['identity'] })
    },
  })
}

export function useLogoutMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: postLogout,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['identity'] })
      qc.clear()
    },
  })
}

export function useNewDeploymentMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ text, name }: { text: string; name: string }) => postNewDeployment(text, name),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['my-deployments'] })
    },
  })
}

export function useRedeployApproveMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ releaseId, env, pipeline }: { releaseId: number; env: string; pipeline: string }) =>
      postRedeployApprove(releaseId, env, pipeline),
    // Replaces the old vanilla-JS version's setTimeout(refreshMine, 1500) guess-and-wait --
    // this refetches the moment the mutation settles, success or failure either way.
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['my-deployments'] })
    },
  })
}

/** Kicks off a fresh CI build plus deploy plus approve. The mutation resolves as soon as the build
 * is QUEUED, not when it finishes -- the poll tracks it from there.
 *
 * With a runId the rebuild targets the row it was started from: the backend rewrites that run
 * rather than creating a second one, and onMutate flips the row to "rebuilding" locally the
 * instant the button is pressed. That immediacy is the point -- the old behaviour left the row
 * sitting at REJECTED until a later poll produced a *separate* new row, which read as "nothing
 * happened" and got the button pressed again, producing genuine duplicate builds.
 *
 * releaseId/approvalStatus are cleared alongside the status because every action button on the row
 * is gated on them; blanking them is what stops a second click during the optimistic window. */
export function useRebuildDeployMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      pipeline,
      branch,
      env,
      runId,
    }: {
      pipeline: string
      branch: string
      env: string
      runId?: string
    }) => postRebuildDeploy(pipeline, branch, env, runId),
    onMutate: async ({ runId }) => {
      if (!runId) return { previous: undefined }
      // Stops an in-flight poll from landing after the optimistic write and undoing it.
      await qc.cancelQueries({ queryKey: ['my-deployments'] })
      const previous = qc.getQueryData<MyDeploymentsResponse>(['my-deployments'])
      qc.setQueryData<MyDeploymentsResponse>(['my-deployments'], (old) =>
        old
          ? {
              ...old,
              rows: old.rows.map((row) =>
                row.runId === runId
                  ? {
                      ...row,
                      status: 'rebuilding',
                      releaseId: null,
                      releaseName: '',
                      approvalStatus: null,
                      failureReason: null,
                    }
                  : row,
              ),
            }
          : old,
      )
      return { previous }
    },
    // A refused rebuild (409 duplicate, bad pipeline) must not leave the row looking like it is
    // rebuilding when nothing was started.
    onError: (_err, _vars, context) => {
      if (context?.previous) qc.setQueryData(['my-deployments'], context.previous)
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['my-deployments'] })
    },
  })
}

export function useCancelDeploymentMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ releaseId, env, pipeline }: { releaseId: number; env: string; pipeline: string }) =>
      postCancelDeployment(releaseId, env, pipeline),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['my-deployments'] })
    },
  })
}

export function useDismissDeploymentsMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ runIds }: { runIds: string[] }) => postDismissDeployments(runIds),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['my-deployments'] })
    },
  })
}

export function useDismissDeploymentMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ runId }: { runId: string }) => postDismissDeployment(runId),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['my-deployments'] })
    },
  })
}

/** Submitting is open to viewers too, but the invalidation only ever hits a cache an admin has --
 * for a viewer there is no ['feedback'] query mounted and this is a no-op. */
export function useSubmitFeedbackMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (draft: FeedbackDraft) => postFeedback(draft),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['feedback'] })
    },
  })
}

export function useUpdateFeedbackMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      id,
      status,
      adminNote,
    }: {
      id: string
      status?: FeedbackStatus
      adminNote?: string
    }) => patchFeedback(id, { status, adminNote }),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['feedback'] })
    },
  })
}

export function useDeleteFeedbackMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id }: { id: string }) => deleteFeedback(id),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['feedback'] })
    },
  })
}

/** Settings held in Git for the stage on screen.
 *
 * Not polled. Reading this means fetching the settings file plus one deployment file per service --
 * eight or nine repository reads for saleor -- and a repository file does not change on its own the
 * way a running deployment does. It refetches when the pipeline or environment changes, and when
 * the user asks.
 */
export function useGitConfigQuery(pipeline: string | null, env: string | null, enabled = true) {
  return useQuery({
    queryKey: ['git-config', pipeline, env],
    queryFn: () => fetchGitConfig(pipeline as string, env as string),
    enabled: Boolean(enabled && pipeline && env),
    staleTime: 0,
  })
}

export function useGitConfigPreviewMutation() {
  return useMutation({ mutationFn: postGitConfigPreview })
}

export function useGitConfigApplyMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: postGitConfigApply,
    // The settings file has changed underneath the read, so drop it rather than showing a table
    // that no longer matches the repository.
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['git-config'] }) },
  })
}

export function useGitConfigDeployMutation() {
  return useMutation({ mutationFn: postGitConfigDeploy })
}

/** The production board. Slower cadence than the deployment pages on purpose: this reads the
 * settings file out of Git on every call, and nothing here changes second to second. */
export function useProdAppsQuery() {
  return useQuery({ queryKey: ['prod-apps'], queryFn: fetchProdApps, refetchInterval: 60_000 })
}

export function useProdAppQuery(appKey: string | null, tier: string) {
  return useQuery({
    queryKey: ['prod-app', appKey, tier],
    queryFn: () => fetchProdApp(appKey as string, tier),
    enabled: Boolean(appKey),
    refetchInterval: 60_000,
  })
}

export function useProdNotRunQuery() {
  return useQuery({ queryKey: ['prod-not-run'], queryFn: fetchProdNotRun, staleTime: 300_000 })
}

export function useProdPlanQuery(planId: string | null) {
  return useQuery({
    queryKey: ['prod-plan', planId],
    queryFn: () => fetchProdPlan(planId as string),
    enabled: Boolean(planId),
    // Faster than the board: once a step is started its stage status changes minute to minute, and
    // the start token is only valid for ten.
    refetchInterval: 20_000,
  })
}

export function useProdBuildsQuery(appKey: string, tier: string, stepId: string | null) {
  return useQuery({
    queryKey: ['prod-builds', appKey, tier, stepId],
    queryFn: () => fetchProdBuilds(appKey, tier, stepId as string),
    enabled: Boolean(stepId),
    staleTime: 60_000,
  })
}

export function useCreateProdPlanMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: createProdPlan,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['prod-plans'] }) },
  })
}

export function useProdStepActionMutation(planId: string | null) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { stepId: string; action: 'prepare' | 'start' | 'discard' | 'reject' | 'verify' | 'confirm'; body?: Record<string, unknown> }) =>
      prodStepAction(planId as string, v.stepId, v.action, v.body ?? {}),
    // Always refetch, including on failure: a refusal usually means the checks moved, and the
    // stale ones on screen are exactly what must not be acted on next.
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['prod-plan', planId] })
      qc.invalidateQueries({ queryKey: ['prod-apps'] })
    },
  })
}

/** Pending production approvals, including ones nothing asked for. Checked often: an approval that
 * queued itself is only dangerous while it is still pending. */
export function useProdWatchlistQuery() {
  return useQuery({ queryKey: ['prod-watchlist'], queryFn: fetchProdWatchlist, refetchInterval: 45_000 })
}

export function useRejectProdApprovalMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: rejectProdApproval,
    onSettled: () => { qc.invalidateQueries({ queryKey: ['prod-watchlist'] }) },
  })
}

/** Runs already open, so closing the page does not lose your place in a sequence. */
export function useProdPlansQuery() {
  return useQuery({ queryKey: ['prod-plans'], queryFn: fetchProdPlans, refetchInterval: 60_000 })
}

/** The tiles. Static for a session in practice, so it is cached hard rather than polled. */
export function useLogSourcesQuery() {
  return useQuery({ queryKey: ['log-sources'], queryFn: fetchLogSources, staleTime: 5 * 60_000 })
}

/** The invocation list, polled while the page is open. `refreshMs` of 0 means the user paused it. */
export function useLogInvocationsQuery(key: string | null, hours = 24, refreshMs = 15_000) {
  return useQuery({
    queryKey: ['log-invocations', key, hours],
    queryFn: () => fetchLogInvocations(key as string, hours),
    enabled: !!key,
    refetchInterval: refreshMs > 0 ? refreshMs : false,
  })
}

/** One invocation's full trace. Not polled: an invocation that has finished does not change, and
 * one still running is better re-opened than watched by a timer. */
export function useLogInvocationDetailQuery(key: string | null, invocationId: string | null) {
  return useQuery({
    queryKey: ['log-invocation', key, invocationId],
    queryFn: () => fetchLogInvocationDetail(key as string, invocationId as string),
    enabled: !!key && !!invocationId,
  })
}


/** The funnel, polled while the panel is open. `refreshMs` of 0 means the user paused it. */
export function useInsightsFunnelQuery(minutes: number, refreshMs = 30_000) {
  return useQuery({
    queryKey: ['insights-funnel', minutes],
    queryFn: () => fetchInsightsFunnel(minutes),
    refetchInterval: refreshMs > 0 ? refreshMs : false,
    // Keep the previous window's numbers on screen while a new window loads, so changing the
    // time filter does not blank the table.
    placeholderData: keepPreviousData,
  })
}


/* ---------------------------------------------------------------------------------------------
 * Key Rotation (MLC-2635). Admin-only server-side, so callers must gate `enabled` on the role --
 * a viewer session would otherwise retry a guaranteed 403.
 * --------------------------------------------------------------------------------------------- */

/** Where every credential stands on one environment.
 *
 * Deliberately NOT polled. This read fetches every release definition named in the plan file --
 * the heaviest read in the portal -- and the backend caches it for 60 seconds anyway, so a timer
 * would mostly re-serve the same cached answer while occasionally paying for a full re-read.
 * staleTime matches that server cache: remounting the page inside the minute reuses what is
 * already here. Pass refreshMs only if a screen genuinely needs a timer.
 *
 * `refresh` is for the explicit Refresh button: it forces past the server cache, and is a separate
 * cache entry so one forced read does not become the cached answer for every later mount. */
export function useKeyVaultStatusQuery(
  env: KeyVaultEnv,
  opts?: { enabled?: boolean; refresh?: boolean; refreshMs?: number },
) {
  const refresh = opts?.refresh ?? false
  const refreshMs = opts?.refreshMs ?? 0
  return useQuery({
    queryKey: ['keyvault-status', env, refresh],
    queryFn: () => fetchKeyVaultStatus(env, refresh),
    enabled: opts?.enabled ?? true,
    staleTime: 60_000,
    refetchInterval: refreshMs > 0 ? refreshMs : false,
    // Switching UAT/PROD keeps the previous environment's table on screen while the new one
    // loads, rather than blanking a page that takes seconds to come back.
    placeholderData: keepPreviousData,
  })
}

/** Every version of one secret, for the rollback dialog: which version it would go back to, and
 * when that one was written. Not polled -- a vault version only changes when somebody rotates or
 * rolls back, and both of those invalidate this query themselves. */
export function useKeyVaultVersionsQuery(
  env: KeyVaultEnv,
  secret: string | null,
  opts?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: ['keyvault-versions', env, secret],
    queryFn: () => fetchKeyVaultVersions(env, secret as string),
    enabled: Boolean((opts?.enabled ?? true) && secret),
    staleTime: 60_000,
  })
}

/** Past sync and rollback runs, newest first. Not polled: runs only appear when somebody on this
 * screen starts one, and the mutations below invalidate this themselves. */
export function useKeyVaultRunsQuery(opts?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ['keyvault-runs'],
    queryFn: fetchKeyVaultRuns,
    enabled: opts?.enabled ?? true,
    staleTime: 30_000,
  })
}

/** One past run in full. Beyond the five hooks the contract names, for a history row's detail. */
export function useKeyVaultRunQuery(runId: string | null) {
  return useQuery({
    queryKey: ['keyvault-run', runId],
    queryFn: () => fetchKeyVaultRun(runId as string),
    enabled: Boolean(runId),
    // A finished run is immutable, so there is no reason to re-read it when a row is reopened.
    staleTime: 5 * 60_000,
  })
}

/** Which caches a completed sync or rollback has made stale.
 *
 * A dry run deliberately does NOT invalidate the status read: it wrote nothing, so the table on
 * screen is still correct, and dropping it would force the expensive re-read for no change. It is
 * still recorded as a run, so the history is always invalidated. `versions` only moves on a real
 * rollback -- a sync pushes the vault's CURRENT value out and adds no version. */
function invalidateAfterKeyVaultRun(
  qc: ReturnType<typeof useQueryClient>,
  env: KeyVaultEnv,
  dryRun: boolean,
  touchedVault: boolean,
) {
  void qc.invalidateQueries({ queryKey: ['keyvault-runs'] })
  if (dryRun) return
  void qc.invalidateQueries({ queryKey: ['keyvault-status', env] })
  if (touchedVault) void qc.invalidateQueries({ queryKey: ['keyvault-versions', env] })
}

/** Pushes the vault values out to the pipelines. Invalidates the status read afterwards so the
 * table re-reads the definitions rather than showing the pre-sync hashes. */
export function useKeyVaultSyncMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: KeyVaultSyncRequest) => postKeyVaultSync(v),
    // onSuccess, not onSettled: a request that never reached the backend changed nothing, and a
    // partial failure still answers 200 with per-destination rows, which lands here.
    onSuccess: (_data, v) => {
      invalidateAfterKeyVaultRun(qc, v.env, v.dryRun ?? false, false)
    },
  })
}

/** Restores each in-scope secret's previous vault version and pushes it out. Invalidates the
 * status read AND the version lists, because the vault's current version has moved. */
export function useKeyVaultRollbackMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: KeyVaultRollbackRequest) => postKeyVaultRollback(v),
    onSuccess: (_data, v) => {
      invalidateAfterKeyVaultRun(qc, v.env, v.dryRun ?? false, true)
    },
  })
}
