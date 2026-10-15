export type Role = 'admin' | 'viewer' | null

export interface LiveStatusRow {
  pipeline: string
  env: 'DEV' | 'SIT' | 'UAT' | 'BETA' | 'PROD'
  release: string
  branch: string
  deployedOn: string
  /** ADO's own deployment `reason` for the latest attempt: "automated" | "manual" | "".
   * This CANNOT be derived from deployedBy -- ADO records a real person as requestedFor on
   * automated deployments too (sampled live: one user appears on 105 automated and 84 manual
   * deployments), so the actor and the trigger are independent facts. */
  trigger: string
  // MLC-2113 additions. These are best-effort: the backend still emits a placeholder row for every
  // pipeline x env pair even when nothing was ever deployed there, so expect null/"" on those rows.
  releaseId: number | null
  buildNumber: string
  commitId: string
  /** The full 40-char SHA. The column renders the short form; this is what the dialog shows and
   * what is actually usable in a git command. Empty on placeholder rows. */
  commitFull?: string
  application: string
  deployedBy: string
  adoReleaseUrl: string
  adoBuildUrl: string
}

export interface LiveStatusResponse {
  rows: LiveStatusRow[]
  updated: string | null
}

export interface MyDeploymentRow {
  pipeline: string | null
  branch: string | null
  env: string | null
  startedAt: string | null
  releaseId: number | null
  status: string
  approvalStatus: string | null
  approvalUrl: string | null
  failureReason: string | null
  runId: string
  requestedBy: string | null
  /** ADO's own name for the release, e.g. "Release-156". Empty until ADO has created the release --
   * during the CI build phase there is nothing named yet, which is why buildNumber exists too. */
  releaseName: string
  /** The CD definition behind that release, e.g. "CD-Macula-Batch-Processor". */
  releaseDefinitionName: string
  releaseUrl: string
  buildId: number | null
  buildNumber: string
  buildUrl: string
  environmentId: number | null
  project: string
  /** 1 on a first run, incremented by each in-place rebuild of the same row. */
  attempt: number
  /** Azure DevOps' own deploy-attempt number for the CURRENT attempt, and how many there have
   * been. Matches the release page's "Deployment attempt #2" / "Attempt # 2 of 2". Null until a
   * release exists. */
  adoAttempt: number | null
  adoAttemptCount: number
  /** Why an approval ended up in its state, when that is not obvious -- currently the auto-reject
   * timeout message. Empty otherwise. */
  approvalNote: string
  /** Countdown inputs for a gate that is open right now. All three are null unless the approval is
   * actually pending. `approvalDeadline` is computed server-side from ADO's own createdOn plus the
   * definition's configured timeout, so it does not drift with when the browser last polled. */
  approvalCreatedOn: string | null
  approvalTimeoutMinutes: number | null
  approvalDeadline: string | null
  /** When THIS attempt actually began in ADO -- not when the portal was asked, which on a retried
   * run can be far earlier. Null until a release exists. */
  deployStartedOn: string | null
  /** Median duration of past succeeded runs of this pipeline+env, in seconds. Null when there is
   * too little history (under three runs) to estimate honestly. */
  etaSeconds: number | null
  /** Groups rows submitted together in one paste. Empty for a standalone deployment. */
  batchId: string
}

export interface MyDeploymentsResponse {
  rows: MyDeploymentRow[]
  updated: string | null
  /** false when the last refresh could not reach Azure DevOps. Every row is then frozen at
   * whatever it last saw, and a deployment started since will be missing entirely. */
  adoReachable?: boolean
  adoError?: string | null
  adoFailedSince?: string | null
}

export interface ApiMessage {
  ok: boolean
  message: string
}

export interface EnvVarEntry {
  name: string
  /** null means the backend judged this a credential and withheld it. It is not an empty value and
   * must never be rendered as one -- these definitions really do carry live secrets in plaintext. */
  value: string | null
  isSecret: boolean
  /** Where it came from: definition variable, stage variable, a variable group, or a build arg. */
  source: string
  /** Variable-group values live on a different ADO resource with its own API, so they are shown
   * here but cannot be written through the release definition. */
  editable: boolean
  /** Only present on build-argument and script-export rows. False means the task is switched OFF in
   * Azure DevOps and contributes nothing at build time -- which is why lower-environment stages show
   * production URLs that are never actually used. */
  taskEnabled?: boolean
  /** Stage-variable rows only. False means NOTHING consumes this variable: no build argument
   * references it as $(NAME), no script exports it. The value is real and saved, and it still
   * reaches nothing at runtime. This is the single commonest way a pipeline looks fully configured
   * on screen while the application sees no value at all. */
  wired?: boolean
  /** What consumes it, when it is wired -- e.g. ["build argument (build)", "script (Tag Images)"]. */
  wiredBy?: string[]
  /** Build-argument rows only. False means the task is a PUSH task: Azure DevOps never reads its
   * buildArguments and does not even render the field, so this line is stored but inert. Several
   * pipelines carry stale argument lists on their push task for exactly this reason. */
  buildsImage?: boolean
}

/** Set when a definition edit will NOT change what actually runs -- currently the storefront
 * prod/beta stages, whose pod env comes from YAML in ADO repo `ecom`, not from the definition. */
export interface LiveValueSource {
  warning: boolean
  message: string
}

export interface EnvVarsResponse {
  ok: boolean
  pipeline: string
  env: string
  stageName: string
  definitionName: string
  project: string
  variableGroups: string[]
  /** Docker tasks on this stage that can take a new build argument. Empty means this stage has
   * none, and "build argument" must not be offered as a target for it. */
  buildArgTasks?: string[]
  /** Tasks with an inline script that can take a new `export NAME=value` line. Empty means this
   * stage has no script, and "script export" must not be offered as a target for it. */
  scriptTasks?: string[]
  /** The task that rewrites placeholder tokens in the deploy YAML, if this stage has one. Empty
   * means the stage has no such step, so a value cannot be delivered to the pod that way. */
  yamlTasks?: string[]
  entries: EnvVarEntry[]
  secretCount: number
  /** True when this response carries real credential values. Admin: always. Viewer: DEV/SIT/UAT
   * only -- BETA and PROD values are dropped from the payload entirely, not masked. */
  revealed: boolean
  /** True for a pipeline every role may read in full on every environment (Rivoli, Rivoli Sanity). */
  openToViewers?: boolean
  /** Whether this caller may write. False for viewers, who get a read-only screen. */
  canEdit?: boolean
  /** Echoed back on save so ADO rejects the write if the definition changed meanwhile. */
  revision: number
  liveValueSource: LiveValueSource
}

export interface EnvVarChange {
  name: string
  value: string
  source: string
}

/** One pipeline's answer to "do you carry this variable on this environment, and where?".
 * No value is ever returned -- only existence and source. */
export interface EnvVarFindHit {
  pipeline: string
  project?: string
  stageName?: string
  found: boolean
  sources?: string[]
  /** Current value on THIS pipeline. Populated for admin only; null for viewer, and null when the
   * variable is not defined here. The same variable legitimately differs per pipeline, which is
   * why the search returns it per row rather than assuming one shared value. */
  value?: string | null
  isSecret?: boolean
  revision?: number
  reason?: string
  stages?: string[]
}

export interface EnvVarFindResponse {
  ok: boolean
  name: string
  env: string
  found: EnvVarFindHit[]
  notFound: EnvVarFindHit[]
  total: number
}

export interface BulkUpdateResult {
  pipeline: string
  ok: boolean
  message: string
  changed: { name: string; source: string }[]
  stageName?: string
  revisionBefore?: number
  revisionAfter?: number
  missing?: string[]
}

export interface CreateVarResult {
  pipeline: string
  ok: boolean
  message?: string
  createdIn?: string
  stageName?: string
  revisionBefore?: number
  revisionAfter?: number
}

export interface CreateVarResponse {
  ok: boolean
  message: string
  updated: number
  total: number
  results: CreateVarResult[]
}

export interface BulkUpdateResponse {
  ok: boolean
  message: string
  updated: number
  total: number
  results: BulkUpdateResult[]
}

export interface EnvVarsUpdateResponse {
  ok: boolean
  message: string
  changed?: { name: string; source: string }[]
  revisionBefore?: number
  revisionAfter?: number
  /** Present on a 409 so the UI can tell the user what the definition moved to. */
  revision?: number
}

/** Environment bucket the backend normalizes every raw ADO environment name into. Anything that
 * does not map onto the four known tiers lands in OTHER rather than being dropped. */
export type EnvBucket = 'DEV' | 'SIT' | 'UAT' | 'PROD' | 'OTHER'

/** Normalized deployment status. The backend collapses ADO's two overlapping state fields
 * (deploymentStatus + operationStatus) into exactly these values -- the frontend must never
 * re-derive status from rawStatus/operationStatus, only display them. */
export type DeploymentStatus =
  | 'succeeded'
  | 'inProgress'
  /** CI build running -- no release exists yet, so nothing is deploying. Distinct from inProgress
   * on purpose: the two are different phases and conflating them misreports what is happening. */
  | 'building'
  | 'failed'
  | 'canceled'
  | 'queued'
  | 'waiting'
  | 'rejected'
  | 'notDeployed'

export interface DeploymentRow {
  /** The Name someone set on this deployment in the portal, joined on releaseId+env. Empty when
   * the deployment did not come through the portal or has no name yet. */
  portalName?: string
  /** True for a portal run whose CI build is still going, so Azure DevOps has no release -- and
   * therefore no deployment record -- for it yet. Synthesised by the backend so the board shows
   * the work immediately instead of only once a release exists. */
  preRelease?: boolean
  /** Triggered by a merge, schedule or PR rather than a person. Cannot be inferred from the actor:
   * ADO records a real person as requestedFor on automated runs too. */
  automated?: boolean
  /** This pipeline deploys INSIDE its build -- no classic release exists, so it is absent from
   * ADO's release/deployments feed entirely and is sourced from the build API instead. */
  ciDeploy?: boolean
  /** A person started this from this portal. Set by matching the row against the portal's own run
   * files, because ADO often reports a portal-started deployment as reason "automated" -- see
   * _portal_owned_releases in the backend. When true, `automated` is forced false. */
  portalInitiated?: boolean
  id: number
  releaseId: number
  releaseName: string
  pipeline: string
  definitionName: string
  application: string
  env: EnvBucket
  /** Real ADO environment name (e.g. "PROD_TAG"). This -- not `env` -- is what the timeline and
   * task-log endpoints expect, because the bucket is lossy. */
  rawEnv: string
  branch: string
  buildNumber: string
  /** The CI build behind this deployment. Lets the drawer show the build's own steps while it is
   * still running, before any release exists. */
  buildId?: number
  commitId: string
  status: DeploymentStatus
  rawStatus: string
  operationStatus: string
  attempt: number
  reason: string
  triggeredBy: string
  queuedOn: string | null
  startedOn: string | null
  completedOn: string | null
  durationSeconds: number | null
  isStuck: boolean
  stuckReason: string | null
  project: string
  adoReleaseUrl: string
  adoLogsUrl: string
  adoBuildUrl: string
  /** An admin has hidden this tile from the board for everyone. Only ever present when an admin is
   * explicitly revealing hidden rows -- for every other reader the row is absent entirely, so a
   * missing flag means "not hidden", never "unknown". */
  hidden?: boolean
}

export interface DeploymentsResponse {
  rows: DeploymentRow[]
  updated: string | null
  /** Hidden rows that match the CURRENT filters, i.e. what the reader would otherwise be seeing. */
  hiddenCount?: number
  /** Hidden rows in total, regardless of filters. Lets an admin discover a hide exists even when
   * the active filters would have excluded that tile anyway. */
  hiddenTotal?: number
  /** false when the last refresh could not reach Azure DevOps. An empty board only means nothing
   * is deploying if the portal was actually able to look. */
  adoReachable?: boolean
  adoError?: string | null
  adoFailedSince?: string | null
}

/** Server-side filters for /api/deployments. Every field is optional and empty values are stripped
 * before the request goes out, so a component can bind these straight to unset form controls. */
export interface DeploymentFilters {
  env?: string
  pipeline?: string
  status?: string
  application?: string
  /** ISO date (YYYY-MM-DD). */
  from?: string
  /** ISO date (YYYY-MM-DD). */
  to?: string
  search?: string
  top?: number
}

export interface TaskIssue {
  type: string
  message: string
}

export interface TimelineTask {
  id: number
  name: string
  /** ADO's own task state verbatim (succeeded, failed, skipped, pending, ...) -- deliberately NOT
   * the normalized DeploymentStatus set, which only describes a whole deployment. */
  status: string
  startTime: string | null
  finishTime: string | null
  durationSeconds: number | null
  agentName: string | null
  issues: TaskIssue[]
  hasLog: boolean
  phaseId: number
}

export interface TimelinePhase {
  id: number
  name: string
  rank: number
  status: string
  startedOn: string | null
  tasks: TimelineTask[]
}

export interface TimelineApproval {
  id: number
  status: string
  approver: string | null
  comments: string | null
  type: string
}

export interface DeploymentTimeline {
  ok: boolean
  releaseId: number
  releaseName: string
  env: string
  status: string
  startedOn: string | null
  completedOn: string | null
  durationSeconds: number | null
  triggeredBy: string
  attempt: number
  phases: TimelinePhase[]
  approvals: TimelineApproval[]
}

/** Distinct values across the whole feed, for populating filter dropdowns. */
export interface PortalMetaWorkingSet {
  workingSet: string[]
}

export interface PortalMeta {
  /** Derived from ADO deployment rows, so it carries raw definition names the pipeline registry
   * cannot resolve. Fine for FILTERING the deployment board; wrong for anything that then asks the
   * backend about a named pipeline -- use variablePipelines for that. */
  pipelines: string[]
  applications: string[]
  environments: string[]
  statuses: string[]
  /** Every pipeline the registry can resolve. The Variables screen's picker. */
  variablePipelines?: string[]
  /** The subset the variables requests actually name, in the team's own order. */
  workingSet?: string[]
  /** Pipelines whose variables every role may read in full, on every environment. */
  variablesOpenPipelines?: string[]
  /** Every normalised spelling of those pipelines -- match with isVariablesOpen(). */
  variablesOpenAliases?: string[]
}

export type FeedbackType = 'bug' | 'improvement' | 'suggestion'

export type FeedbackStatus = 'new' | 'planned' | 'done' | 'dismissed'

export interface FeedbackItem {
  /** "<iso-with-dashes>_<6 hex>" -- also the stem of the JSON file the backend stores it in. */
  id: string
  type: FeedbackType
  title: string
  description: string
  /** "" when the submitter did not supply one. */
  link: string
  /** Stored filename, null when nothing was uploaded. Fetch the bytes via feedbackAttachmentUrl. */
  attachment: string | null
  submittedBy: string
  submittedByRole: string
  submittedAt: string
  status: FeedbackStatus
  adminNote: string
}

export interface FeedbackCounts {
  new: number
  planned: number
  done: number
  dismissed: number
  total: number
}

export interface FeedbackListResponse {
  items: FeedbackItem[]
  counts: FeedbackCounts
}

/** What the submit form holds. `attachment` is a live File rather than a name because the POST is
 * multipart -- the item that comes back has a stored filename string instead. */
export interface FeedbackDraft {
  type: FeedbackType
  title: string
  description: string
  link: string
  attachment: File | null
}

/** One entry in a Git-held settings file (a Kubernetes ConfigMap). `usedBy` is the join the portal
 * does for you: which services actually read this setting. A setting nothing reads is dead weight;
 * a service reading a setting that is not here is a mismatch, reported separately. */
export interface GitConfigKey extends EnvVarEntry {
  usedBy: string[]
}

export interface GitConfigFile {
  role: 'configmap' | 'deployment'
  service?: string
  path: string
  objectId: string | null
  keyCount?: number
  alphabetical?: boolean
  envCount?: number
  /** False when the portal cannot work out where a new entry would go in this file. It is never
   * guessed at -- the file is reported as not addable instead. */
  canInsert?: boolean
  insertNote?: string
  /** Every stage that applies this same file. Below production these YAMLs are shared, so a change
   * made "for UAT" also lands in DEV and SIT on their next release. */
  appliedByStages?: string[]
}

export interface GitConfigApplyPipeline {
  definitionId: number
  name: string
  stage: string
  purpose: 'configmap' | 'workloads'
  needsApproval: boolean
}

export interface GitConfigResponse {
  ok: boolean
  pipeline: string
  env: string
  /** "git" when this pipeline keeps its settings in a repository, "pipeline" when they live in the
   * release definition and the ordinary Variables tabs apply. */
  mode: 'git' | 'pipeline'
  message?: string
  repo?: { project: string; name: string; branch: string; commitId: string | null }
  configMapName?: string
  namespace?: string
  cluster?: string
  files?: GitConfigFile[]
  keys?: GitConfigKey[]
  /** A service asks for a setting the file does not contain. Usually means a rename landed in one
   * file and not the other. */
  orphanRefs?: { service: string; name: string; key: string }[]
  applyPipelines?: GitConfigApplyPipeline[]
  sharedWithStages?: string[]
  optionalIsHouseStyle?: boolean
  revealed?: string
  canEdit?: boolean
  writeMode?: string
}

export interface GitConfigChangedFile {
  path: string
  role: 'configmap' | 'deployment'
  service: string | null
  added: number
  line: string
}

export interface GitConfigPreview {
  ok: boolean
  problems: string[]
  /** Halves of the change that are already in place. Not errors -- the settings file and the
   * deployment files drift apart routinely, and fixing that means adding only what is missing. */
  already: string[]
  files: GitConfigChangedFile[]
  willAutoMerge: boolean
  canDeploy: boolean
  sharedWithStages: string[]
  applyPipelines: GitConfigApplyPipeline[]
}

export interface GitConfigApplied {
  ok: boolean
  problems?: string[]
  name: string
  env: string
  services: string[]
  branch: string
  pullRequestId: number
  merged: boolean
  url: string
  mergeNote: string
  canDeploy: boolean
  applyPipelines: GitConfigApplyPipeline[]
}

export interface GitConfigDeployStarted {
  ok: boolean
  message?: string
  releaseId?: number
  name?: string
  pinned?: string
  url?: string
  step?: GitConfigApplyPipeline
}

export type ProdCheckStatus = 'ok' | 'warn' | 'block'

export interface ProdCheck {
  id: string
  title: string
  status: ProdCheckStatus
  detail: string
  evidence?: Record<string, unknown> | null
  action?: string | null
}

export interface ProdApp {
  appKey: string
  tier: string
  displayName: string
  cluster: string
  namespaces: string[]
  imageRepo: string | null
  runningTag: string | null
  tagMutable: boolean
  driverFile: string | null
  version: string | null
  deployFlag: string | null
  stepCount: number
  knownProblems: string[]
  /** Live problems found by reading the settings file just now, as opposed to knownProblems,
   * which are standing defects in the pipelines themselves. */
  problems: string[]
  confidence: Record<string, string>
}

export interface ProdStep {
  stepId: string
  order: number
  kind: 'edit' | 'tag' | 'config' | 'deploy' | 'external' | 'manual'
  title: string
  plain: string
  definitionId: number | null
  definitionName: string | null
  stage: string | null
  approval: { manual: boolean; timeoutMinutes: number | null; approver?: string } | null
  pins: Array<{ alias: string; type: string; choose: string; branch?: string }> | null
  writes: Record<string, string[]> | null
  portalMayStart: boolean
  blockedReason: string | null
  adoUrl: string | null
  checks: ProdCheck[]
  worst: ProdCheckStatus
  canPrepare: boolean
}

export interface ProdAppDetail {
  ok: boolean
  recipe: Omit<ProdApp, 'version' | 'deployFlag' | 'stepCount' | 'problems'> & Record<string, unknown>
  driver: { file: string | null; entry: Record<string, string> | null; allEntries: Array<Record<string, string>>; error: string | null }
  steps: ProdStep[]
}

export interface ProdNotRun {
  ok: boolean
  items: Array<{
    appKey: string; tier: string; displayName: string
    stepId: string; title: string; kind: string
    reason: string; action: string | null
  }>
  never: string[]
}

export interface ProdStepProgress {
  state: 'pending' | 'prepared' | 'started' | 'verified' | 'acknowledged' | 'failed'
  releaseId?: number
  releaseName?: string
  url?: string
  preparedAt?: string
  preparedBy?: string
  startedAt?: string
  startedBy?: string
  verifiedAt?: string
  stageStatus?: string
  evidence?: string[]
  proved?: boolean | null
  note?: string
  acknowledgedBy?: string
  acknowledgedAt?: string
}

export interface ProdPlanStep extends ProdStep {
  progress: ProdStepProgress
  /** Only issued for a prepared step that currently passes every check. Its absence is why the
   * Start button is not offered, and it expires after ten minutes. */
  startToken?: string
}

export interface ProdPlan {
  planId: string
  appKey: string
  tier: string
  displayName: string
  createdBy: string
  createdAt: string
  reason: string
}

export interface ProdPlanDetail {
  ok: boolean
  plan: ProdPlan
  steps: ProdPlanStep[]
  recipe: Record<string, unknown>
}

export interface ProdBuild {
  id: number
  buildNumber: string
  branch: string
  commit: string
  result: string
  finishTime: string
  requestedFor: string
}

export interface ProdWatchItem {
  project: string
  approvalId: number
  stage: string
  releaseId: number
  releaseName: string
  definitionId: number
  definitionName: string
  approver: string
  createdOn: string
  url: string
  /** true when the stage queued itself on ReleaseStarted rather than being chosen by anyone. */
  autoQueued: boolean | null
  why: string
}

/** Logging Dashboard. One LogSource is one tile: a single Azure Function's telemetry in one
 * environment. `appId` is deliberately absent -- the backend strips it, so the browser can never
 * address Application Insights directly. */
export interface LogSource {
  key: string
  title: string
  subtitle: string
  env: string
  roleName: string
  operation: string
  description: string
  /** Deep link to the same blade in the Azure portal, for anyone who does have an Azure login. */
  portalUrl: string
}

export interface LogSourcesResponse {
  ok: boolean
  /** False when the Azure Monitor credentials are not set on the pod -- the page says so rather
   * than showing every tile failing to load. */
  configured: boolean
  sources: LogSource[]
}

export interface LogLine {
  id?: string
  timestamp: string
  /** Application Insights severityLevel: 0 verbose, 1 information, 2 warning, 3 error, 4 critical. */
  severity: number
  invocationId?: string
  message: string
}

export interface LogStreamResponse {
  ok: boolean
  lines: LogLine[]
}

export interface LogInvocation {
  invocationId: string
  timestamp: string
  success: boolean
  resultCode: string
  durationMs: number
  instance?: string
}

export interface LogInvocationsResponse {
  ok: boolean
  invocations: LogInvocation[]
}

export interface LogInvocationDetail {
  ok: boolean
  invocationId: string
  summary: {
    timestamp?: string
    success?: boolean | null
    resultCode?: string
    durationMs?: number
    instance?: string
  }
  lines: LogLine[]
  exceptions: { timestamp: string; type: string; message: string }[]
}

/** One brand's row in the Live Monitoring Insights funnel. Saleor deletes a checkout when its
 *  order is created, so every surviving checkout is an abandonment -- which is what makes the
 *  two "didn't finish" columns meaningful rather than guesses. */
export interface InsightsFunnelRow {
  brand: string
  label: string
  ordersPlaced: number
  checkoutNoPayment: number
  paymentNotCompleted: number
  checkoutsStarted: number
  conversionPct: number | null
  channels: string[]
}

export interface InsightsFunnelResponse {
  ok: boolean
  /** false when INSIGHTS_DB_DSN is unset -- the panel then explains rather than erroring. */
  configured: boolean
  minutes: number
  generatedAt?: string
  cached?: boolean
  rows: InsightsFunnelRow[]
  error?: string
  detail?: string
}

/* ---------------------------------------------------------------------------------------------
 * Key Rotation (MLC-2635). Azure Key Vault holds every CI/CD credential; each pipeline holds its
 * own copy. These shapes describe where every credential stands, what a sync would change, and
 * what a rollback would put back.
 *
 * NO CREDENTIAL VALUE EVER CROSSES THIS API. A value is represented only by a 10-character
 * SHA-256 prefix (`hash` / `currentHash` / `vaultHash`), a character count (`length`) and a Key
 * Vault version id. There is no masked form and no partial form -- any field here that could
 * carry a value is a defect, not something to render.
 * --------------------------------------------------------------------------------------------- */

/** Which vault and plan file a call addresses: kv-cicd-uat-uaenorth / uat_plan.json, or
 * kv-cicd-prod-uaenorth / prod_plan.json. Lowercase, and required on every route. */
export type KeyVaultEnv = 'uat' | 'prod'

/** How one pipeline destination compares with the vault right now.
 *
 * The distinction that matters is `behind` versus `unknown`, and it cannot be guessed from the
 * value on screen: the backend compares the destination's hash against every version the vault
 * has ever held. A pipeline holding a value the vault USED to hold is behind, so a sync is safe.
 * A pipeline holding a value the vault has never held is a mapping error -- that credential
 * belongs to something else, and a sync would hand the service the wrong one, so it refuses. */
export type DestinationState =
  | 'match'
  | 'behind'
  | 'unknown'
  | 'padlocked'
  | 'empty'
  | 'reference'
  | 'absent'

/** Where the credential physically lives, which decides how it is written.
 *
 * A stage variable (placement A/B) is set through the release-definition variables API. A build
 * argument (placement C/D) is a literal inside a Docker task's `buildArguments` input -- no
 * "set pipeline variable" call can reach it, it has to be rewritten as a task input. */
export type DestinationKind = 'stage-variable' | 'build-argument'

export interface Destination {
  project: string
  defId: number
  defName: string
  /** The real ADO stage name ("UAT", "PROD_TAG", "BETA_TAG"), not a normalized bucket. */
  stage: string
  variable: string
  kind: DestinationKind
  /** The internal placement class from the plan file: "A"/"B" are stage variables (B padlocked),
   * "C"/"D" are build arguments. `kind` is derived from this; it is carried through so the UI can
   * explain a padlocked or hardcoded destination in the plan's own terms. */
  placement: string
  state: DestinationState
  /** 10-char SHA-256 prefix of what this destination currently holds. Null whenever there is
   * nothing readable to hash -- a padlocked variable, a $(MACRO) reference, an absent one. */
  currentHash: string | null
  length: number | null
}

/** Destination states rolled up. `other` is everything that is not match/behind/unknown --
 * padlocked, empty, reference, absent -- which are states a sync cannot act on either way. */
export interface KeyVaultStateCounts {
  match: number
  behind: number
  unknown: number
  other: number
}

export interface SecretRow {
  name: string
  service: string
  /** Every pipeline variable name this one credential feeds. The same secret legitimately lands
   * under different names on different definitions. */
  variables: string[]
  /** 'placeholder' means the vault still holds the sentinel, so nothing real has been loaded for
   * this credential yet and a sync would push the sentinel out to the pipelines. */
  vaultState: 'set' | 'placeholder'
  vaultHash: string | null
  vaultLength: number | null
  versionCount: number
  /** 10-char prefix of the most recent DIFFERENT version -- what a rollback goes back to. Null
   * when every version holds the same value, or there is only one. */
  previousHash: string | null
  /** False when there is no earlier distinct version. Rollback reports such a secret as skipped
   * rather than failing the run. */
  canRollback: boolean
  destinations: Destination[]
  counts: KeyVaultStateCounts
}

export interface ServiceRow {
  service: string
  secrets: number
  destinations: number
  counts: KeyVaultStateCounts
  /** True when at least ONE of this service's secrets has an earlier distinct version. */
  canRollback: boolean
  /** True when any of this service's destinations is 'unknown'. A blocked service must not be
   * synced: one of its pipelines holds a value this vault has never held. */
  blocked: boolean
}

export interface KeyVaultTotals extends KeyVaultStateCounts {
  secrets: number
  filled: number
  placeholders: number
  destinations: number
}

/** GET /api/keyvault/status.
 *
 * Two shapes in one, the way GitConfigResponse is. On a normal read `ok` is true and every field
 * below is present. When the pod has no usable Key Vault credential the route still answers 200
 * with `{ok: false, connected: false, message}` and nothing else -- exactly how the Logging
 * Dashboard behaves without its service principal -- so the payload fields are optional, and the
 * page must say "not connected" rather than render an empty table as health. */
export interface KeyVaultStatusResponse {
  ok: boolean
  /** Only ever present, and false, when Key Vault could not be reached. Absent means connected. */
  connected?: boolean
  message?: string
  env?: KeyVaultEnv
  /** The vault actually read, e.g. "kv-cicd-prod-uaenorth". */
  vault?: string
  generatedAt?: string
  totals?: KeyVaultTotals
  /** True when ANY destination is 'unknown'. Sync must be disabled while this is true. */
  blocked?: boolean
  services?: ServiceRow[]
  secrets?: SecretRow[]
}

/** POST /api/keyvault/sync. `services` omitted or null means every service. */
export interface KeyVaultSyncRequest {
  env: KeyVaultEnv
  services?: string[] | null
  /** Does every read and every check, writes nothing, and answers in the identical shape. */
  dryRun?: boolean
}

/** POST /api/keyvault/rollback. `secrets` takes precedence over `services`; both null means every
 * secret that can roll back. */
export interface KeyVaultRollbackRequest {
  env: KeyVaultEnv
  services?: string[] | null
  secrets?: string[] | null
  dryRun?: boolean
}

/** What happened at one destination. 'refused' is a destination in state 'unknown' -- deliberately
 * not written. 'skipped' only occurs on a rollback, for a secret with no earlier distinct version,
 * and is not an error. */
export type KeyVaultResultAction = 'written' | 'unchanged' | 'refused' | 'failed' | 'skipped'

/** One row per DESTINATION, not per secret -- a single credential can land in several definitions,
 * and each one is written, refused or failed on its own. */
export interface KeyVaultSyncResult {
  secret: string
  service: string
  project: string
  defId: number
  defName: string
  stage: string
  variable: string
  kind: DestinationKind
  action: KeyVaultResultAction
  hashBefore: string | null
  hashAfter: string | null
  /** The release definition's revision either side of the write. Null on a dry run, and on a
   * destination nothing was written to. */
  revisionBefore: number | null
  revisionAfter: number | null
  message: string
}

/** A rollback result row is the sync row plus which vault version the secret was put back to. The
 * three vault fields repeat on every destination row belonging to that secret. */
export interface KeyVaultRollbackResult extends KeyVaultSyncResult {
  vaultHashFrom?: string | null
  vaultHashTo?: string | null
  vaultVersionRestored?: string | null
}

export interface KeyVaultWriteTotals {
  written: number
  unchanged: number
  refused: number
  failed: number
  /** Rollback only: secrets with no earlier distinct version to go back to. */
  skipped?: number
}

export interface KeyVaultSyncResponse {
  ok: boolean
  /** "<iso-with-dashes>_sync_uat" -- also the id the run history is addressed by. */
  runId: string
  dryRun: boolean
  message: string
  totals: KeyVaultWriteTotals
  /** Destinations in state 'unknown'. Not failures: deliberately not written, because the pipeline
   * holds a value this vault has never held and a sync would overwrite the wrong credential. */
  refused: Destination[]
  results: KeyVaultSyncResult[]
}

/** One secret whose vault version actually moved. Absent from this array means the vault was left
 * alone -- either the secret was out of scope, or it had no earlier distinct version. */
export interface KeyVaultRolledBackSecret {
  secret: string
  service: string
  vaultHashFrom: string | null
  vaultHashTo: string | null
  vaultVersionRestored: string | null
}

export interface KeyVaultRollbackResponse extends Omit<KeyVaultSyncResponse, 'results'> {
  results: KeyVaultRollbackResult[]
  rolledBack: KeyVaultRolledBackSecret[]
}

/** GET /api/keyvault/versions. Newest first, `current: true` on exactly one. */
export interface KeyVaultVersion {
  versionId: string
  created: string
  enabled: boolean
  current: boolean
  /** 10-char SHA-256 prefix. Null for a version whose value cannot be read back (disabled), which
   * is why a version can appear in the list with nothing to compare against. */
  hash: string | null
  length: number | null
}

export interface KeyVaultVersionsResponse {
  ok: boolean
  secret: string
  versions: KeyVaultVersion[]
  message?: string
}

/** One persisted run, as written to KEYVAULT_RUNS_DIR -- the response a sync or rollback returned,
 * plus who ran it and when. Same audit discipline as _record_env_change: names, hashes, revisions
 * and version ids only, never a value. */
export interface KeyVaultRunRecord {
  runId: string
  by: string
  at: string
  env: KeyVaultEnv
  action: 'sync' | 'rollback'
  dryRun: boolean
  ok?: boolean
  message?: string
  totals?: KeyVaultWriteTotals
  refused?: Destination[]
  results: KeyVaultRollbackResult[]
  /** Rollback runs only. */
  rolledBack?: KeyVaultRolledBackSecret[]
}

/** GET /api/keyvault/runs. Newest first. The array is `items`, following /api/env-vars/history --
 * the existing route over the same kind of audit directory. fetchKeyVaultRuns normalizes a `runs`
 * key onto it, so the page has one field to read whichever the backend emits. */
export interface KeyVaultRunsResponse {
  ok: boolean
  items: KeyVaultRunRecord[]
  message?: string
}
