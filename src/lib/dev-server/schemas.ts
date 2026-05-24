import { z } from "zod";

const devServerPortStrategySchema = z.enum(["stdout-cc-port", "cc-assigned"]);
export type DevServerPortStrategy = z.infer<typeof devServerPortStrategySchema>;

const devServerPortConfigSchema = z
  .object({
    strategy: devServerPortStrategySchema.default("cc-assigned"),
    base: z.number().int().min(1).max(65535).optional(),
    range: z.number().int().min(1).max(10000).default(100),
    env: z.string().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.strategy === "cc-assigned" && value.base === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["base"],
        message: "port.base is required when strategy is 'cc-assigned'",
      });
    }
    if (value.base !== undefined && value.base + value.range - 1 > 65535) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["range"],
        message:
          "port.base + port.range would exceed the maximum TCP port (65535)",
      });
    }
  });

const devServerReadinessTypeSchema = z.enum(["stdout-cc-port", "tcp"]);
export type DevServerReadinessType = z.infer<
  typeof devServerReadinessTypeSchema
>;

const devServerReadinessConfigSchema = z.object({
  type: devServerReadinessTypeSchema,
  timeoutMs: z.number().int().min(100).max(600_000).optional(),
});
export const devServerConfigSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  cwd: z.string().min(1).optional(),
  port: devServerPortConfigSchema.optional(),
  readiness: devServerReadinessConfigSchema.optional(),
});
export type DevServerConfig = z.infer<typeof devServerConfigSchema>;

const devServerStatusSchema = z.enum([
  "starting",
  "running",
  "stopped",
  "error",
]);
export type DevServerStatus = z.infer<typeof devServerStatusSchema>;

const devServerSourceSchema = z.enum(["cc-started", "external-adopted"]);
export type DevServerSource = z.infer<typeof devServerSourceSchema>;

export const devServerStatusEventSchema = z.object({
  type: z.literal("dev-server-status"),
  projectName: z.string(),
  sessionName: z.string(),
  serverName: z.string(),
  status: devServerStatusSchema,
  port: z.number().nullable(),
  remoteUrl: z.string().nullable(),
  errorMessage: z.string().nullable(),
  source: devServerSourceSchema.nullable().default(null),
  ownedByThisSession: z.boolean().default(false),
  worktreePath: z.string().nullable().default(null),
  ownerPid: z.number().int().nullable().default(null),
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
  source: devServerSourceSchema.nullable().default(null),
  ownedByThisSession: z.boolean().default(false),
  worktreePath: z.string().nullable().default(null),
  ownerPid: z.number().int().nullable().default(null),
});
export type DevServerRuntimeState = z.infer<typeof devServerRuntimeStateSchema>;

export const devServersStatusResponseSchema = z.object({
  servers: z.array(devServerRuntimeStateSchema),
});
export type DevServersStatusResponse = z.infer<
  typeof devServersStatusResponseSchema
>;
