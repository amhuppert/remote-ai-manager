import { z } from "zod";

export const findingEvidenceSchema = z.object({
  label: z.string(),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  unit: z.enum(["ms", "count", "percent", "bytes"]).optional(),
});

export const logAnalysisFindingSchema = z.object({
  id: z.string(),
  severity: z.enum(["critical", "high", "medium", "low", "info"]),
  confidence: z.number().min(0).max(1),
  category: z.enum([
    "slow-request",
    "operation-hotspot",
    "duplicate-work",
    "state-store",
    "external-command",
    "sse",
    "client-timing",
    "error-correlation",
    "instrumentation-gap",
    "regression",
  ]),
  title: z.string(),
  explanation: z.string(),
  evidence: z.array(findingEvidenceSchema),
  traceIds: z.array(z.string()),
  recommendedNextActions: z.array(z.string()),
});

const unknownObjectSchema = z.record(z.string(), z.unknown());

export const agentLogAnalysisReportSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string(),
  command: z.literal("report"),
  input: unknownObjectSchema,
  summary: z.object({
    recordsRead: z.number().int().nonnegative(),
    recordsAnalyzed: z.number().int().nonnegative(),
    malformedLineCount: z.number().int().nonnegative(),
    invalidTimestampCount: z.number().int().nonnegative(),
    invalidShapeCount: z.number().int().nonnegative(),
    timedEventCount: z.number().int().nonnegative(),
    requestCount: z.number().int().nonnegative(),
    warnCount: z.number().int().nonnegative(),
    errorCount: z.number().int().nonnegative(),
  }),
  findings: z.array(logAnalysisFindingSchema),
  slowRequests: z.array(unknownObjectSchema),
  operationHotspots: z.array(unknownObjectSchema),
  duplicateWork: z.array(unknownObjectSchema),
  stateStore: unknownObjectSchema,
  externalCommands: z.array(unknownObjectSchema),
  sse: z.array(unknownObjectSchema),
  clientTiming: unknownObjectSchema,
  errorCorrelation: unknownObjectSchema,
  instrumentationGaps: z.array(logAnalysisFindingSchema),
  artifacts: z.array(unknownObjectSchema),
});

export const agentTraceAnalysisReportSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string(),
  command: z.literal("trace"),
  traceId: z.string(),
  request: z.unknown(),
  summary: unknownObjectSchema,
  timeline: z.array(unknownObjectSchema),
  inclusiveSpans: z.array(unknownObjectSchema),
  exclusiveSpans: z.array(unknownObjectSchema),
  duplicateWork: z.array(unknownObjectSchema),
  warningsAndErrors: z.array(unknownObjectSchema),
  unexplainedTime: unknownObjectSchema,
  findings: z.array(logAnalysisFindingSchema),
  artifacts: z.array(unknownObjectSchema),
});

export const agentLogComparisonReportSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string(),
  command: z.literal("compare"),
  before: unknownObjectSchema,
  after: unknownObjectSchema,
  summaryDelta: unknownObjectSchema,
  endpointDeltas: z.array(unknownObjectSchema),
  operationDeltas: z.array(unknownObjectSchema),
  duplicateWorkDeltas: z.array(unknownObjectSchema),
  newWarningsAndErrors: z.array(unknownObjectSchema),
  findings: z.array(logAnalysisFindingSchema),
});

export type AgentLogAnalysisReport = z.infer<
  typeof agentLogAnalysisReportSchema
>;
export type AgentTraceAnalysisReport = z.infer<
  typeof agentTraceAnalysisReportSchema
>;
export type AgentLogComparisonReport = z.infer<
  typeof agentLogComparisonReportSchema
>;
