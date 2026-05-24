import { z } from "zod";

export const jobTypeSchema = z.enum(["commit", "merge", "resolve-conflicts"]);
export type JobType = z.infer<typeof jobTypeSchema>;

export const jobStatusSchema = z.enum([
  "running",
  "completed",
  "failed",
  "conflicts",
]);
export type JobStatus = z.infer<typeof jobStatusSchema>;

export const backgroundJobSchema = z.object({
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
});
export type BackgroundJob = z.infer<typeof backgroundJobSchema>;

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

const conflictDecisionInputSchema = z.object({
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
