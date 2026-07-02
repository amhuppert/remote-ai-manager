import { z } from "zod";
import { registerTrustedSchema } from "@/lib/shared/parse-trusted";

export const jobTypeSchema = z.enum(["commit", "merge", "resolve-conflicts"]);
export type JobType = z.infer<typeof jobTypeSchema>;

export const jobStatusSchema = z.enum([
  "running",
  "completed",
  "failed",
  "conflicts",
  "ready-to-land",
  "discarded",
]);
export type JobStatus = z.infer<typeof jobStatusSchema>;

// Documented phase strings (held as z.string() for forward compatibility):
//   "committing-uncommitted" | "merging-main" | "analyzing-conflicts" |
//   "resolving-conflicts" | "validating" | "fixing-validation" |
//   "re-validating" | "preparing" | "publishing" | "awaiting-land"
// Phase-clearing rule: phase is cleared on terminal transitions to completed,
// failed, conflicts, or discarded; phase "awaiting-land" is retained on
// ready-to-land terminal entry.
export const backgroundJobSchema = registerTrustedSchema(
  z.object({
    jobId: z.string(),
    jobType: jobTypeSchema,
    status: jobStatusSchema,
    projectName: z.string(),
    sessionName: z.string(),
    branchName: z.string(),
    targetBranch: z.string().optional(),
    startedAt: z.string(),
    completedAt: z.string().optional(),
    mergeHash: z.string().optional(),
    commitHash: z.string().optional(),
    conflictCount: z.number().optional(),
    conflictFiles: z.array(z.string()).optional(),
    errorMessage: z.string().optional(),
    phase: z.string().optional(),
    parkedRef: z.string().optional(),
    preparedSha: z.string().optional(),
    expectedTargetSha: z.string().optional(),
    refreshWarning: z.string().optional(),
  }),
  "backgroundJobSchema",
);
export type BackgroundJob = z.infer<typeof backgroundJobSchema>;

export const jobRecordSchema = registerTrustedSchema(
  backgroundJobSchema
    .pick({
      jobId: true,
      jobType: true,
      status: true,
      projectName: true,
      sessionName: true,
      branchName: true,
      startedAt: true,
      completedAt: true,
      mergeHash: true,
      commitHash: true,
      conflictCount: true,
      conflictFiles: true,
      errorMessage: true,
    })
    .strict(),
  "jobRecordSchema",
);
export type JobRecord = z.infer<typeof jobRecordSchema>;

export const jobStatusEventSchema = z.object({
  type: z.literal("job-status"),
  jobType: jobTypeSchema,
  status: jobStatusSchema,
  projectName: z.string(),
  sessionName: z.string(),
  jobId: z.string(),
  branchName: z.string(),
  mergeHash: z.string().optional(),
  commitHash: z.string().optional(),
  conflictCount: z.number().optional(),
  conflictFiles: z.array(z.string()).optional(),
  errorMessage: z.string().optional(),
  phase: z.string().optional(),
  parkedRef: z.string().optional(),
  preparedSha: z.string().optional(),
  expectedTargetSha: z.string().optional(),
  refreshWarning: z.string().optional(),
});
export type JobStatusEvent = z.infer<typeof jobStatusEventSchema>;

export const jobDispatchResponseSchema = z.object({
  jobId: z.string(),
  jobType: jobTypeSchema,
  branchName: z.string(),
  startedAt: z.string(),
});

export const smartMergeRequestSchema = z.object({
  autoResolve: z.boolean(),
});

export const conflictEntrySchema = z.object({
  file: z.string(),
  description: z.string(),
  resolution: z.string(),
  rationale: z.string(),
});
export type ConflictEntry = z.infer<typeof conflictEntrySchema>;

export const conflictDecisionInputSchema = z.object({
  file: z.string(),
  decision: z.enum(["approved", "rejected", "pending"]),
  feedback: z.string().optional(),
});
export type ConflictDecisionInput = z.infer<typeof conflictDecisionInputSchema>;

export const resolveConflictsRequestSchema = z.object({
  decisions: z.array(conflictDecisionInputSchema).optional(),
});

export const jobsResponseSchema = z.object({
  jobs: z.array(backgroundJobSchema),
});
export type JobsResponse = z.infer<typeof jobsResponseSchema>;
