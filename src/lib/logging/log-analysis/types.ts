export type LogAnalysisSeverity =
  | "critical"
  | "high"
  | "medium"
  | "low"
  | "info";

type LogAnalysisCategory =
  | "slow-request"
  | "operation-hotspot"
  | "duplicate-work"
  | "state-store"
  | "external-command"
  | "sse"
  | "client-timing"
  | "error-correlation"
  | "instrumentation-gap"
  | "convention-violation"
  | "regression";

export interface ParsedServerLogRecord {
  lineNumber: number;
  timestamp: string;
  timestampMs: number;
  level: string;
  module: string;
  message: string;
  raw: Record<string, unknown>;
  traceId?: string;
  action?: string;
  projectName?: string;
  sessionName?: string;
  conversationId?: string;
  durationMs?: number;
  method?: string;
  path?: string;
  status?: number;
}

export interface ServerLogParseResult {
  records: ParsedServerLogRecord[];
  malformedLineCount: number;
  invalidTimestampCount: number;
  invalidShapeCount: number;
}

export interface ParsedClientTimingRecord {
  event: string;
  raw: Record<string, unknown>;
  traceId?: string;
  action?: string;
  method?: string;
  url?: string;
  status?: number;
  totalMs?: number;
  serverMs?: number | null;
  networkMs?: number | null;
  eventType?: string;
  transportMs?: number | null;
  handlerMs?: number;
}

export interface LogAnalysisFilters {
  sinceMs?: number;
  untilMs?: number;
  projectName?: string;
  sessionName?: string;
  conversationId?: string;
  path?: string;
  action?: string;
  includeSelf: boolean;
}

export interface LogAnalysisThresholds {
  slowMs: number;
  hotspotMs: number;
  top: number;
}

interface FindingEvidence {
  label: string;
  value: string | number | boolean | null;
  unit?: "ms" | "count" | "percent" | "bytes";
}

export interface LogAnalysisFinding {
  id: string;
  severity: LogAnalysisSeverity;
  confidence: number;
  category: LogAnalysisCategory;
  title: string;
  explanation: string;
  evidence: FindingEvidence[];
  traceIds: string[];
  recommendedNextActions: string[];
}
