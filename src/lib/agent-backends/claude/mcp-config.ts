import type { PortableMcpConfig } from "../portable-mcp";

/** Exact SDK tool names are creation options and remove definitions from context. */
export function claudeMcpToolExclusions(config: PortableMcpConfig): string[] {
  return [
    ...new Set(
      config.servers
        .filter((server) => server.enabled !== false)
        .flatMap((server) =>
          (server.disabledTools ?? []).map(
            (tool) => `mcp__${server.id}__${tool}`,
          ),
        ),
    ),
  ].sort();
}
