import { z } from "zod";

export const commitLogEntrySchema = z.object({
  hash: z.string(),
  fullHash: z.string(),
  message: z.string(),
  date: z.string(),
  filesChanged: z.number(),
});
export type CommitLogEntry = z.infer<typeof commitLogEntrySchema>;

export const commitRequestSchema = z.object({
  message: z.string().trim().min(1),
});

const diffLineSchema = z.object({
  type: z.enum(["context", "add", "remove", "hunk-header"]),
  content: z.string(),
});
export type DiffLine = z.infer<typeof diffLineSchema>;

const diffHunkSchema = z.object({
  header: z.string(),
  lines: z.array(diffLineSchema),
});
export type DiffHunk = z.infer<typeof diffHunkSchema>;

const fileDiffSchema = z.object({
  filePath: z.string(),
  additions: z.number(),
  deletions: z.number(),
  hunks: z.array(diffHunkSchema),
});
export type FileDiff = z.infer<typeof fileDiffSchema>;

export const sessionDiffSchema = z.object({
  files: z.array(fileDiffSchema),
  totalAdditions: z.number(),
  totalDeletions: z.number(),
});
export type SessionDiff = z.infer<typeof sessionDiffSchema>;

export const commitsResponseSchema = z.object({
  commits: z.array(commitLogEntrySchema),
});

/** Conflict analysis result stored in memory */
export interface ConflictAnalysis {
  jobId: string;
  projectName: string;
  sessionName: string;
  conflicts: import("@/lib/jobs/schemas").ConflictEntry[];
  resolvedAt?: string;
}
