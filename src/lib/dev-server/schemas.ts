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

export const devServerStatusEventSchema = z.object({
  type: z.literal("dev-server-status"),
  projectName: z.string(),
  sessionName: z.string(),
  serverName: z.string(),
  status: devServerStatusSchema,
  port: z.number().nullable(),
  remoteUrl: z.string().nullable(),
  errorMessage: z.string().nullable(),
  ownedByThisSession: z.boolean().default(false),
  worktreePath: z.string().nullable().default(null),
  ownerPid: z.number().int().nullable().default(null),
  logFilePath: z.string().nullable().default(null),
});
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
