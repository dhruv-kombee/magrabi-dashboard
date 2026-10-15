# Key Rotation section — API contract

Single source of truth for the Key Rotation feature. Backend and frontend are built against this
document. Written 2026-10-09 for MLC-2635.

## What the feature does

Azure Key Vault holds every CI/CD credential. The pipelines each hold their own copy. This section
lets an admin:

1. **See** where every credential stands — vault value versus what each pipeline holds.
2. **Sync** — push the vault values out to the pipelines, into whichever place each pipeline reads
   that credential from (a release-stage variable, or a Docker build argument inside a task input).
3. **Roll back** — put the vault back to its previous version and push again. All services at once,
   or only the services selected.

Every response says exactly **what was updated where**: project, definition id and name, stage,
variable name, the kind of destination, and the definition revision before and after.

## Hard rules

- **No credential value ever crosses this API.** Values are represented only as a 10-character
  SHA-256 prefix, a character length, and a Key Vault version id. Never a value, never a prefix or
  suffix of one, not even masked. Any field that could carry one is a defect.
- Every route is `@require_role("admin")`. A viewer must not reach any of them, read or write.
- Nothing here may touch a cluster or create a release. It writes Azure DevOps **definitions** and
  Key Vault **secret versions**, nothing else. The rotation only reaches a running service when
  somebody later creates a release, which is outside this feature.
- Every write route takes `dryRun`. `dryRun: true` must perform every read and every check and
  return the identical response shape, having written nothing.
- Writes are per-destination best-effort with per-destination results, in the style of
  `/api/env-vars/bulk-update`. One failing definition must not abort the others.

## Environments

`env` is `"uat"` or `"prod"`, lowercase, and is required on every route. These map to vaults
`kv-cicd-uat-uaenorth` and `kv-cicd-prod-uaenorth` and to plan files `uat_plan.json` and
`prod_plan.json`.

## Shared shapes

```ts
type DestinationState =
  | 'match'      // holds the current vault value - nothing to do
  | 'behind'     // holds a value the vault USED to hold - a sync brings it up to date
  | 'foreign'    // holds a value the vault has NEVER held - a sync OVERWRITES it, and says so
  | 'padlocked'  // secret-marked pipeline variable, cannot be read, cannot be compared
  | 'empty'      // present but blank
  | 'reference'  // holds a $(VARIABLE) macro, so it resolves elsewhere
  | 'absent'     // the variable is not there at all

type DestinationKind = 'stage-variable' | 'build-argument'

interface Destination {
  project: string          // "ECom" | "Macula"
  defId: number
  defName: string          // "CD-Magrabi-Storefront"
  stage: string            // "UAT" | "PROD_TAG" | "BETA_TAG" | ...
  variable: string         // the pipeline variable name
  kind: DestinationKind
  placement: string        // "A" | "B" | "C" | "D", the internal placement class
  state: DestinationState
  currentHash: string | null
  length: number | null
}

interface SecretRow {
  name: string             // "prod-drm-storefront-sendgrid-api-key"
  service: string          // "drm-storefront"
  variables: string[]      // every pipeline variable name this credential feeds
  vaultState: 'set' | 'placeholder'
  vaultHash: string | null
  vaultLength: number | null
  versionCount: number
  previousHash: string | null   // the most recent DIFFERENT version - what a rollback goes to
  canRollback: boolean          // false when there is no earlier distinct version
  destinations: Destination[]
  counts: { match: number; behind: number; unknown: number; other: number }
}

interface ServiceRow {
  service: string
  secrets: number
  destinations: number
  counts: { match: number; behind: number; unknown: number; other: number }
  canRollback: boolean     // true when at least one of its secrets can roll back
  blocked: boolean         // true when any of its destinations is 'unknown'
}
```

## Routes

### `GET /api/keyvault/status?env=uat|prod`

The whole picture. Cached server-side for 60 seconds; `?refresh=1` forces a re-read.

```json
{
  "ok": true,
  "env": "prod",
  "vault": "kv-cicd-prod-uaenorth",
  "generatedAt": "2026-10-09T12:00:00Z",
  "totals": { "secrets": 65, "filled": 63, "placeholders": 2,
              "destinations": 149, "match": 149, "behind": 0, "unknown": 0, "other": 0 },
  "blocked": false,
  "services": [ /* ServiceRow[] */ ],
  "secrets":  [ /* SecretRow[]  */ ]
}
```

`blocked` is always `false` and is retained only so an older client does not break. **The vault is
authoritative and a sync never refuses on account of what a destination currently holds.** Keep the
field; do not gate anything on it.

### `POST /api/keyvault/sync`

```json
{ "env": "uat", "services": ["drm-storefront"], "dryRun": false }
```

`services` omitted or `null` means every service. Response:

```json
{
  "ok": true,
  "runId": "2026-10-09T12-00-00_sync_uat",
  "dryRun": false,
  "message": "updated 21 destination(s) across 6 definition(s) on UAT.",
  "totals": { "written": 21, "unchanged": 167, "refused": 0, "failed": 0 },
  "refused": [ /* Destination[] with state 'unknown' */ ],
  "results": [
    {
      "secret": "uat-shared-sentry-auth-token",
      "service": "shared",
      "project": "ECom", "defId": 41, "defName": "CD-Magrabi-Storefront",
      "stage": "UAT", "variable": "SENTRY_AUTH_TOKEN",
      "kind": "build-argument",
      "action": "written",
      "hashBefore": "aaaaaaaaaa", "hashAfter": "bbbbbbbbbb",
      "revisionBefore": 427, "revisionAfter": 428,
      "message": ""
    }
  ]
}
```

`action` is `written` | `unchanged` | `refused` | `failed`.

### `GET /api/keyvault/versions?env=uat&secret=<name>`

```json
{
  "ok": true, "secret": "uat-shared-sentry-auth-token",
  "versions": [
    { "versionId": "6102529ce499...", "created": "2026-10-09T08:53:34Z",
      "enabled": true, "current": true, "hash": "aaaaaaaaaa", "length": 191 }
  ]
}
```

Newest first. `current: true` on exactly one.

### `POST /api/keyvault/rollback`

```json
{ "env": "prod", "services": ["drm-storefront"], "secrets": null, "dryRun": false }
```

- `services: null` and `secrets: null` → every secret that can roll back.
- `services: [...]` → only those services.
- `secrets: [...]` → only those exact secret names. Takes precedence over `services`.

For each in-scope secret it sets the vault back to its most recent **different** version, then
pushes that value to the secret's destinations. Response is the sync shape plus, per secret:

```json
{ "vaultHashFrom": "bbbbbbbbbb", "vaultHashTo": "aaaaaaaaaa",
  "vaultVersionRestored": "64d74ccc6291..." }
```

and a `rolledBack` array naming each secret whose vault version changed. A secret with no earlier
distinct version is reported as `skipped`, not an error.

### `GET /api/keyvault/runs` and `GET /api/keyvault/runs/<runId>`

Run history, newest first, the same shape a sync or rollback returned, so the UI can show what a
past run did. Persist to `KEYVAULT_RUNS_DIR`, defaulting to `RUNS_DIR.parent / "keyvault_runs"`,
following how `_record_env_change` and `ENV_CHANGES_DIR` already work. Each record carries `by`
(the username), `at`, `env`, `action` (`sync` | `rollback`), `dryRun` and the full results array.

## How the backend reaches Key Vault

The pod authenticates with **AKS workload identity** - no secret in the image, no Azure CLI.

- `azure-identity` and `azure-keyvault-secrets` are added to `backend/requirements.txt`.
- `WorkloadIdentityCredential` is picked up automatically by `DefaultAzureCredential` once the pod
  carries the `azure.workload.identity/use: "true"` label and the service account is annotated with
  the managed identity's client id.
- Vault names come from env vars `KEYVAULT_UAT` and `KEYVAULT_PROD`, defaulting to
  `kv-cicd-uat-uaenorth` and `kv-cicd-prod-uaenorth`.
- When the credential is unavailable the status route must return `200` with
  `{"ok": false, "message": "...", "connected": false}` and the UI must say the section is not
  connected - exactly how the Logging Dashboard behaves without its service principal. The pod must
  still start.

The plan files (`uat_plan.json`, `prod_plan.json`) are the routing table: which secret goes to which
project, definition, stage, variable and placement. They are copied into the image at build time to
`/app/keyvault/` and read from `KEYVAULT_PLAN_DIR`, defaulting to that path.

## File ownership while this is built in parallel

Nobody edits a file another worker owns.

| Files | Owner |
|---|---|
| `devops-tools/kvsync/kvsync.py` (rollback command) | A |
| `magrabi-deploy-portal/backend/app.py`, `backend/requirements.txt` | B |
| `frontend/src/routes/KeyRotationPage.tsx` + `.module.css`, `frontend/src/components/KeyRotation*.tsx` + css | C |
| `frontend/src/api/client.ts`, `api/hooks.ts`, `api/types.ts`, `App.tsx`, `components/NavHeader.tsx` | D |

C codes against the hooks D is writing, both following this document. The route path is
`/key-rotation` and the nav label is `Key Rotation`, admin only.

---

## Amendment 1 — the vault always wins (2026-10-09, Sanskar)

This replaces the refusal behaviour described above. Two rules, and only two:

**1. If the vault entry holds a real value, it is pushed — whatever the destination currently holds.**
There is no case in which a sync refuses because of the pipeline's existing value. A destination
holding something the vault has never held is state `foreign`: it is overwritten, and the result row
records `replacedForeignValue: true` so it is visible afterwards that a value which did not come
from the vault was replaced.

**2. If the vault entry has no value — missing, or still the `__SET_ME__` placeholder — that
destination is skipped and named.** `action: "skipped"`, with `reason: "vault entry not configured"`.
Never a failure, and never a guess.

So the actions reduce to: `written`, `unchanged`, `skipped`, `failed`. `refused` no longer occurs;
keep it in the type for older clients but never emit it.

**Why this is safe now, and was not before.** On 08 Oct the mapping was wrong — one vault entry fed
services that genuinely used different credentials, so an unconditional overwrite would have given
Doctor M Magrabi's SendGrid key across 43 production destinations. That root cause is fixed: those
entries were split into 24 per-service entries on 09 Oct, and both environments now measure **zero**
`foreign` destinations. With the mapping correct, "the vault wins" is simply what the tool is for.

**What `foreign` still buys us.** It is no longer a gate, but it stays a loud signal. A destination
turning `foreign` in future means something changed outside the vault — a developer pointing a new
service at an existing variable name, or a value edited directly in Azure DevOps. The status screen
must surface a `foreign` count prominently, and the result table must mark those rows, so the
overwrite is noticed rather than silent.

## Amendment 2 — sync is scoped exactly like rollback (2026-10-09, Sanskar)

Sync is **not** only an all-at-once button. It takes the same scoping as rollback, with the same UI:

- a service list with checkboxes, each row showing the service, its secret count and its counts of
  match / behind / foreign;
- **Select all** and **Clear**, so "everything" and "one service" are both one click;
- multi-select, so any subset works;
- the selection drives both buttons, and the confirmation names the selected services.

`POST /api/keyvault/sync` already accepts `services: string[] | null`; `null` still means every
service. Add `secrets: string[] | null` to sync as well, matching rollback, so a single credential
can be pushed on its own.

The page therefore has **one** service selector near the top, and both Sync and Roll back act on
whatever is selected. Preview (`dryRun: true`) applies to both and must show the identical table.
