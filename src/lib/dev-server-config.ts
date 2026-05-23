import { z } from "zod";
import { createLogger } from "./logging";
import {
  devServerConfigSchema,
  type DevServerPortStrategy,
  type DevServerReadinessType,
} from "./schemas";

export type DevServerConfigInput = z.input<typeof devServerConfigSchema>;

const logger = createLogger("dev-server-config");

const DEFAULT_PORT_RANGE = 100;
const DEFAULT_TCP_READINESS_TIMEOUT_MS = 60_000;
const DEFAULT_STDOUT_READINESS_TIMEOUT_MS = 60_000;

interface NormalizedDevServerPort {
  strategy: DevServerPortStrategy;
  base: number | null;
  range: number;
  envAlias: string | null;
}

interface NormalizedDevServerReadiness {
  type: DevServerReadinessType;
  timeoutMs: number;
}

export interface NormalizedDevServerConfig {
  name: string;
  command: string;
  cwd: string | null;
  port: NormalizedDevServerPort;
  readiness: NormalizedDevServerReadiness;
}

export function normalizeDevServerConfig(
  raw: DevServerConfigInput,
): NormalizedDevServerConfig {
  const parsed = devServerConfigSchema.parse(raw);

  const portRaw = parsed.port;
  const hasPortBlock = portRaw !== undefined;

  let strategy: DevServerPortStrategy;
  let base: number | null;
  let range: number;
  let envAlias: string | null;

  if (!hasPortBlock) {
    strategy = "stdout-cc-port";
    base = null;
    range = DEFAULT_PORT_RANGE;
    envAlias = null;
  } else {
    strategy = portRaw.strategy;
    base = portRaw.base ?? null;
    range = portRaw.range;
    envAlias = portRaw.env ?? null;
  }

  const readinessRaw = parsed.readiness;
  let readinessType: DevServerReadinessType;
  let readinessTimeoutMs: number;

  if (readinessRaw) {
    readinessType = readinessRaw.type;
    readinessTimeoutMs =
      readinessRaw.timeoutMs ??
      (readinessType === "tcp"
        ? DEFAULT_TCP_READINESS_TIMEOUT_MS
        : DEFAULT_STDOUT_READINESS_TIMEOUT_MS);
  } else if (strategy === "cc-assigned") {
    readinessType = "tcp";
    readinessTimeoutMs = DEFAULT_TCP_READINESS_TIMEOUT_MS;
  } else {
    readinessType = "stdout-cc-port";
    readinessTimeoutMs = DEFAULT_STDOUT_READINESS_TIMEOUT_MS;
  }

  const normalized: NormalizedDevServerConfig = {
    name: parsed.name,
    command: parsed.command,
    cwd: parsed.cwd ?? null,
    port: {
      strategy,
      base,
      range,
      envAlias,
    },
    readiness: {
      type: readinessType,
      timeoutMs: readinessTimeoutMs,
    },
  };

  logger.debug("dev-server.config.normalized", {
    name: normalized.name,
    strategy: normalized.port.strategy,
    base: normalized.port.base,
    range: normalized.port.range,
    envAlias: normalized.port.envAlias,
    cwd: normalized.cwd,
    readinessType: normalized.readiness.type,
    readinessTimeoutMs: normalized.readiness.timeoutMs,
  });

  return normalized;
}
