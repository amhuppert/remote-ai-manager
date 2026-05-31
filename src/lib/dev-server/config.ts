import { z } from "zod";
import { createLogger } from "../logging";
import { devServerConfigSchema } from "./schemas";

export type DevServerConfigInput = z.input<typeof devServerConfigSchema>;

const logger = createLogger("dev-server-config");

const READINESS_TIMEOUT_MS = 60_000;

interface NormalizedDevServerPort {
  base: number;
  range: number;
  envAlias: string | null;
}

export interface NormalizedDevServerConfig {
  name: string;
  command: string;
  cwd: string | null;
  port: NormalizedDevServerPort;
  readinessTimeoutMs: number;
}

export function normalizeDevServerConfig(
  raw: DevServerConfigInput,
): NormalizedDevServerConfig {
  const parsed = devServerConfigSchema.parse(raw);

  const normalized: NormalizedDevServerConfig = {
    name: parsed.name,
    command: parsed.command,
    cwd: parsed.cwd ?? null,
    port: {
      base: parsed.port.base,
      range: parsed.port.range,
      envAlias: parsed.port.env ?? null,
    },
    readinessTimeoutMs: READINESS_TIMEOUT_MS,
  };

  logger.debug("dev-server.config.normalized", {
    name: normalized.name,
    base: normalized.port.base,
    range: normalized.port.range,
    envAlias: normalized.port.envAlias,
    cwd: normalized.cwd,
    readinessTimeoutMs: normalized.readinessTimeoutMs,
  });

  return normalized;
}
