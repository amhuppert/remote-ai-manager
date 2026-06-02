# Phase 7: Configuration Simplification

## Objective

Make dev server setup easier for all projects by moving port assignment and
readiness logic into Command Center where possible, while keeping the existing
`CC_PORT` stdout protocol for compatibility.

## Current Risk

- Current custom server setup requires project scripts to choose ports, detect
  ownership, and print `CC_PORT`.
- Presets help Next.js and Storybook, but arbitrary projects still need too much
  custom logic.
- External-server reconciliation for custom projects is impossible without port
  hints.

## Files To Update

- `src/lib/dev-server/schemas.ts`
- `src/lib/config/schemas.ts`
- `src/lib/dev-server-presets.ts`
- `src/lib/dev-server-presets.test.ts`
- `src/lib/dev-server/reconciliation.ts`
- `src/lib/dev-server/port-selection.ts`
- `docs/project-configuration.md`
- `plugins/command-center/command-center/skills/setup/SKILL.md`
- `plugins/command-center/command-center/skills/setup/references/dev-servers.md`
- `.cc/dev-servers/*` if presets are regenerated

## Backward Compatibility

Keep this existing shape valid:

```json
{
  "devServers": [
    { "name": "nextjs", "command": ".cc/dev-servers/nextjs.sh" }
  ]
}
```

Add optional fields. Do not require migration.

## Proposed Config Shape

```json
{
  "devServers": [
    {
      "name": "web",
      "command": "bun run dev -- --port $CC_ASSIGNED_PORT",
      "cwd": ".",
      "port": {
        "strategy": "cc-assigned",
        "base": 3000,
        "range": 100,
        "env": "CC_ASSIGNED_PORT"
      },
      "readiness": {
        "type": "tcp",
        "timeoutMs": 60000
      }
    }
  ]
}
```

Supported strategies:

- `stdout-cc-port`: existing behavior, command must print `CC_PORT=<port>`.
- `cc-assigned`: CC chooses a port and injects environment variables.

## Red Tests First

1. Existing config still parses.

2. New config parses with `cc-assigned` strategy.

3. Invalid port range fails validation.

4. `cc-assigned` command receives env vars:
   - `CC_ASSIGNED_PORT`
   - configured env alias, if any
   - `PORT`, if configured or defaulted

5. Reconciliation uses explicit port range for custom servers.

6. Preset generation can emit simplified config/scripts.

## Implementation Steps

1. Extend `devServerConfigSchema` with optional fields:
   - `cwd`
   - `port`
   - `readiness`

2. Add a config normalization function:

   ```ts
   normalizeDevServerConfig(config): NormalizedDevServerConfig
   ```

   It should fill defaults and preserve legacy behavior.

3. Update start flow:
   - For `stdout-cc-port`, keep existing stdout scanner.
   - For `cc-assigned`, select or adopt a port before spawn.
   - Inject env vars into the child process.
   - Mark running only after readiness passes.

4. Update reconciliation:
   - Use explicit `port.base` and `port.range` for custom servers.
   - Continue known preset fallback for legacy configs.

5. Update preset installer:
   - Generate simpler configs where possible.
   - Keep generated scripts minimal.
   - Preserve old generated scripts for existing projects unless the user
     explicitly reinstalls or upgrades a preset.

6. Update docs and setup skill references.

## Logging Requirements

Add structured events:

- `dev-server.config.normalized`
- `dev-server.start.cc_assigned_port`
- `dev-server.start.stdout_protocol`
- `dev-server.readiness.wait`
- `dev-server.readiness.ready`
- `dev-server.readiness.timeout`

## Acceptance Criteria

- Existing projects continue to work without config changes.
- New projects can configure a dev server without writing ownership-detection
  shell logic.
- Custom projects can participate in on-demand status reconciliation by
  declaring a port range.
- Agents get the same MCP experience for legacy and new config styles.

## Residual Risk

Some frameworks ignore `PORT` or require framework-specific CLI flags. Those
projects can still use command interpolation with `$CC_ASSIGNED_PORT` or the
legacy `CC_PORT` stdout protocol.
