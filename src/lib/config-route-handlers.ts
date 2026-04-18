/**
 * Config route handler logic — extracted for dependency injection.
 *
 * Route files delegate to these handlers, passing production deps.
 * Tests create handlers with mock deps via `createConfigRouteHandlers(deps)`.
 */

import { NextResponse } from "next/server";
import {
  readConfig as defaultReadConfig,
  readRawConfig as defaultReadRawConfig,
  writeRawConfig as defaultWriteRawConfig,
  intersectKeys,
} from "@/lib/config";
import { rawGlobalConfigSchema } from "@/lib/schemas";
import type { GlobalConfig } from "@/types";
import { createLogger } from "@/lib/logging";

const log = createLogger("config");

// ---------------------------------------------------------------------------
// Deps interface
// ---------------------------------------------------------------------------

export interface ConfigRouteDeps {
  readConfig(): Promise<GlobalConfig>;
  readRawConfig(): Promise<Partial<GlobalConfig>>;
  writeRawConfig(config: Partial<GlobalConfig>): Promise<void>;
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
      const detail = validation.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      log.warn("config.update_validation_error", { error: detail });
      return NextResponse.json(
        { error: `Invalid config: ${detail}` },
        { status: 400 },
      );
    }

    try {
      // Strip Zod-injected defaults so only user-submitted keys are persisted
      const stripped = intersectKeys(
        body,
        validation.data,
      ) as Partial<GlobalConfig>;
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
