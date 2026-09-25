import { z } from "zod";

const devServerPortConfigSchema = z
  .object({
    base: z.number().int().min(1).max(65535),
    range: z.number().int().min(1).max(10000).default(100),
    env: z.string().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.base + value.range - 1 > 65535) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["range"],
        message:
          "port.base + port.range would exceed the maximum TCP port (65535)",
      });
    }
  });

export const devServerConfigSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  cwd: z.string().min(1).optional(),
  port: devServerPortConfigSchema,
});
export type DevServerConfig = z.infer<typeof devServerConfigSchema>;

export const devServerTargetRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("session") }).strict(),
  z
    .object({
      kind: z.literal("workflow-context"),
      executionId: z.string().trim().min(1),
      contextId: z.string().trim().min(1),
    })
    .strict(),
]);
export type DevServerTargetRef = z.infer<typeof devServerTargetRefSchema>;

const devServerStatusSchema = z.enum([
  "starting",
  "running",
  "stopped",
  "error",
]);
export type DevServerStatus = z.infer<typeof devServerStatusSchema>;

const devServerStatusEventFields = {
  type: z.literal("dev-server-status"),
  projectName: z.string(),
  serverName: z.string(),
  status: devServerStatusSchema,
  port: z.number().nullable(),
  remoteUrl: z.string().nullable(),
  errorMessage: z.string().nullable(),
  ownedByThisSession: z.boolean().default(false),
  worktreePath: z.string().nullable().default(null),
  ownerPid: z.number().int().nullable().default(null),
  logFilePath: z.string().nullable().default(null),
};

/**
 * `scope` names the list the change invalidates: a session's servers, or the
 * servers that run in the project root. The project variant carries no
 * `sessionName` at all.
 */
export const devServerStatusEventSchema = z.discriminatedUnion("scope", [
  z.object({
    ...devServerStatusEventFields,
    scope: z.literal("session"),
    sessionName: z.string(),
  }),
  z.object({ ...devServerStatusEventFields, scope: z.literal("project") }),
]);
export type DevServerStatusEvent = z.infer<typeof devServerStatusEventSchema>;

export const devServerRuntimeStateSchema = z.object({
  serverName: z.string(),
  command: z.string(),
  status: devServerStatusSchema,
  port: z.number().nullable(),
  remoteUrl: z.string().nullable(),
  startedAt: z.string().nullable(),
  errorMessage: z.string().nullable(),
  recentOutput: z.array(z.string()),
  ownedByThisSession: z.boolean().default(false),
  worktreePath: z.string().nullable().default(null),
  ownerPid: z.number().int().nullable().default(null),
  logFilePath: z.string().nullable().default(null),
});
export type DevServerRuntimeState = z.infer<typeof devServerRuntimeStateSchema>;

export const devServersStatusResponseSchema = z.object({
  servers: z.array(devServerRuntimeStateSchema),
});
export type DevServersStatusResponse = z.infer<
  typeof devServersStatusResponseSchema
>;

/**
 * Who a dev server instance runs for. `project` servers run in the project's
 * own checkout; `session` servers in the session worktree; `workflow-lane`
 * servers in a graph-workflow lane worktree of that session.
 */
export const devServerOwnerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("project") }).strict(),
  z.object({ kind: z.literal("session"), sessionName: z.string() }).strict(),
  z
    .object({
      kind: z.literal("workflow-lane"),
      sessionName: z.string(),
      worktreeName: z.string(),
    })
    .strict(),
]);
export type DevServerOwner = z.infer<typeof devServerOwnerSchema>;

export const devServerInstanceSchema = z.object({
  owner: devServerOwnerSchema,
  serverName: z.string(),
  status: devServerStatusSchema,
  port: z.number().nullable(),
  localUrl: z.string().nullable(),
  remoteUrl: z.string().nullable(),
  startedAt: z.string().nullable(),
  errorMessage: z.string().nullable(),
  /** Worktree the instance runs in — the project root for `project` owners. */
  worktreePath: z.string(),
});
export type DevServerInstance = z.infer<typeof devServerInstanceSchema>;

export const devServerOverviewProjectSchema = z.object({
  projectName: z.string(),
  projectPath: z.string(),
  /** Set when the project's CommandCenter.json could not be read. */
  configError: z.string().nullable(),
  /**
   * Every configured project-root server (any status), then the starting or
   * running session and lane servers.
   */
  servers: z.array(devServerInstanceSchema),
});
export type DevServerOverviewProject = z.infer<
  typeof devServerOverviewProjectSchema
>;

export const devServerOverviewResponseSchema = z.object({
  projects: z.array(devServerOverviewProjectSchema),
});
export type DevServerOverviewResponse = z.infer<
  typeof devServerOverviewResponseSchema
>;

export const stopDevServerInstanceRequestSchema = z
  .object({
    projectName: z.string().min(1),
    /** Null addresses the project-root owner. */
    sessionName: z.string().min(1).nullable(),
    worktreePath: z.string().min(1),
    serverName: z.string().min(1),
  })
  .strict();
export type StopDevServerInstanceRequest = z.infer<
  typeof stopDevServerInstanceRequestSchema
>;
