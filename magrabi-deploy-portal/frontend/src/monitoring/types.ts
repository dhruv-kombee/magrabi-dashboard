export interface TraceNode {
  id: string
  namespace: string
  service: string
  span_count: number
  error_span_count: number
  observed_window_ms: number
  max_span_duration_ms: number
  span_duration_sum_ms: number
}
export interface TraceEdge {
  source: string
  target: string
  evidence: 'observed_cross_service_parent_child'
  span_relationship_count: number
  child_error_span_count: number
}
export interface TraceSpan {
  span_id: string
  parent_span_id: string | null
  service_id: string
  service: string
  namespace: string
  kind: string
  error_observed: boolean
  duration_ms: number
  start_offset_ms: number
}
export interface TraceSummary {
  schema_version: 1
  trace_id: string
  environment: 'sit'
  observed_duration_ms: number
  span_count: number
  nodes: TraceNode[]
  edges: TraceEdge[]
  spans: TraceSpan[]
  root_span_ids: string[]
  known_partial: boolean
  missing_parents: { span_id: string; missing_parent_span_id: string }[]
  error_span_ids: string[]
  complete_end_to_end: 'not_established'
  log_correlation?: { status: string; logs_verified: boolean; trace_and_logs_url?: string }
}
