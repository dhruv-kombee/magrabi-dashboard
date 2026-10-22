# Commerce Assist — Implementation Plan

Last updated: 2026-10-22

## Objective

Add a natural-language assistant to the Commerce Intelligence Platform that answers questions from approved platform data, can use configured read-only environment connectors, stays inside the Magrabi commerce boundary, and exports answers as polished PDF, Excel, and Word documents.

## Delivery plan

### Phase 1 — Repository and data-boundary discovery (complete)

- Map the React/Vite frontend, Node API router, filters, existing reports, and connector services.
- Preserve the repository-wide read-only external-platform invariant.
- Confirm that credentials remain server-side and are never returned in API payloads.

### Phase 2 — Grounded assistant API (complete)

- Add `POST /api/commerce/assistant/query`.
- Validate and allowlist brand, country, timezone, and date-window inputs.
- Query relevant read-only connectors for each answer, with a 30-second scoped snapshot cache.
- Project only verified summary fields into model context and exports; never include raw gateway responses.
- Use Gemini 3.1 Flash-Lite through the server-side Google AI Studio API key, with no web-search tool.
- Fall back to a built-in platform answer engine when an API key/model is unavailable.
- Reject empty, invalid, and oversized request bodies.

### Phase 3 — Conversational web experience (complete)

- Add a fixed, responsive assistant panel that fits the existing dashboard without changing navigation.
- Carry the active brand, country, date, and timezone filters into every request.
- Provide starter questions, multi-turn history, loading animation, errors, source badges, minimize/reopen behavior, and keyboard submission.
- Respect reduced-motion preferences and provide accessible labels/live regions.
- Open as a compact launcher; minimize on outside click or Escape; support copy, new conversation, and download feedback.
- Save multiple browser-local conversations with search, rename, delete, and resume actions.
- Show per-answer source evidence: connector, fields used, feed status, and snapshot time.
- Present verified facts as key-figure cards and an accessible metric/value/source table, including for previously saved answers.

### Phase 4 — High-quality exports (complete)

- PDF: branded header, question, answer, formatted metric/value/source table, selected scope, source evidence, timestamps, and page numbering.
- Excel: styled answer sheet with key figures, a filterable data-table sheet, and a flattened grounding-data sheet.
- Word: structured headings, formatted metric/value/source table, answer body, scope table, sources, and generation metadata.
- Generate exports in the browser so no report content is persisted on the server.

### Phase 5 — Security and configuration hardening (complete)

- Remove hard-coded Grafana password fallbacks from source.
- Add optional `GEMINI_API_KEY`, `GEMINI_MODEL`, and `ASSISTANT_MAX_HISTORY` settings.
- Surface assistant readiness in the existing connector-health response.
- Document credential rotation for any previously embedded credentials.

### Phase 6 — Verification (complete within available local tooling)

- Production TypeScript/Vite build.
- Local page and health checks.
- Assistant success, validation, filter-boundary, and fallback-path tests.
- Dependency/security review and credential-pattern scan.
- Focused tests for scope, follow-ups, unavailable metrics, and OMS count wording.
- Tests for Gemini request structure, out-of-topic refusal, and conversation history persistence.
- Browser visual QA is verified for the answer-first layout on desktop and 390px mobile; all three export formats passed local smoke checks.

### Phase 7 — Answer-first enterprise response (implemented 2026-10-22)

- Parse multi-part requests into the requested metric, prior-window comparison, and requested term definitions; use validated Gemini planning hints with deterministic wording as a reliable fallback.
- State rolling-period assumptions explicitly. “Last month” follows the platform's rolling 30-day window, not the prior calendar month.
- Show the answer before compact key figures; collapse the full supporting table and source details until opened.
- Limit query evidence and export audit fields to relevant metrics. Include country breakdown only when asked.
- Preserve PDF/XLSX/DOCX quality and browser history; verify the screenshot question in the live API and desktop/mobile browser.
- Continue to refuse unsupported data and to ask a follow-up when the required metric or scope cannot be determined.

## Explicit boundaries

- No external writes, mutations, refunds, captures, alerts, configuration changes, or deployments.
- No general internet search or out-of-platform answering from the assistant.
- No credential values in frontend bundles, responses, exports, logs, or chat history.
- No Git commit or push until the repository owner explicitly requests it.

## Future production hardening

- Add application authentication/authorization before public exposure.
- Add per-user rate limits and organization audit events.
- Add server-sent streaming if progressive token rendering is required.
- Add contract tests with mocked connectors and an end-to-end browser suite.
