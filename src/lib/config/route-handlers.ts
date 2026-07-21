/**
 * Config route handler logic — extracted for dependency injection.
 *
 * Route files delegate to these handlers, passing production deps.
 * Tests create handlers with mock deps via `createConfigRouteHandlers(deps)`.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import {
  readConfig as defaultReadConfig,
  readRawConfig as defaultReadRawConfig,
  materializeGlobalConfig,
  writeRawConfig as defaultWriteRawConfig,
} from "@/lib/config/loader";
import { intersectKeys } from "@/lib/config/cascade";
import { rawGlobalConfigSchema } from "@/lib/config/schemas";
import type { GlobalConfig, RawGlobalConfig } from "@/lib/config/schemas";
import { createLogger, withTracing } from "@/lib/logging";

const log = createLogger("config");

function formatValidationIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");
}

// ---------------------------------------------------------------------------
// Deps interface
// ---------------------------------------------------------------------------

export interface ConfigRouteDeps {
  readConfig(): Promise<GlobalConfig>;
  readRawConfig(): Promise<RawGlobalConfig>;
  writeRawConfig(config: RawGlobalConfig): Promise<void>;
}

const defaultDeps: ConfigRouteDeps = {
  readConfig: defaultReadConfig,
  readRawConfig: defaultReadRawConfig,
  writeRawConfig: defaultWriteRawConfig,
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createConfigRouteHandlers(deps: ConfigRouteDeps = defaultDeps) {
  async function GET(): Promise<Response> {
    try {
      const [config, raw] = await Promise.all([
        deps.readConfig(),
        deps.readRawConfig(),
      ]);
      return NextResponse.json({ config, raw });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to read config";
      log.error("config.read_error", { error: message });
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  async function PUT(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const validation = rawGlobalConfigSchema.safeParse(body);
    if (!validation.success) {
      const detail = formatValidationIssues(validation.error);
      log.warn("config.update_validation_error", { error: detail });
      return NextResponse.json(
        { error: `Invalid config: ${detail}` },
        { status: 400 },
      );
    }

    // Strip Zod-injected defaults so only user-submitted keys are persisted.
    const stripped = intersectKeys(body, validation.data) as RawGlobalConfig;
    try {
      materializeGlobalConfig(stripped);
    } catch (err) {
      const detail =
        err instanceof z.ZodError
          ? formatValidationIssues(err)
          : err instanceof Error
            ? err.message
            : "Invalid effective config";
      log.warn("config.update_effective_validation_error", { error: detail });
      return NextResponse.json(
        { error: `Invalid config: ${detail}` },
        { status: 400 },
      );
    }

    try {
      await deps.writeRawConfig(stripped);
      log.info("config.updated", {
        fieldCount: Object.keys(stripped).length,
      });

      const [config, raw] = await Promise.all([
        deps.readConfig(),
        deps.readRawConfig(),
      ]);
      return NextResponse.json({ config, raw });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to write config";
      log.error("config.write_error", { error: message });
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  return { GET, PUT };
}

const defaultHandlers = createConfigRouteHandlers();

/** GET /api/config — returns full merged config + raw explicit values */
export const GET = withTracing(defaultHandlers.GET);

/** PUT /api/config — update explicit config values */
export const PUT = withTracing(defaultHandlers.PUT);
