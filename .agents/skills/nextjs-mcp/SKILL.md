---
name: nextjs-mcp
description: Diagnose the running Command Center app with Next.js and Chrome
  DevTools MCP; use for runtime errors, route or server-action inspection,
  visual verification, browser debugging, and performance traces.
---

# Next.js and browser diagnostics

Before browser or runtime tooling, run `cctl dev ensure` for the relevant server and use the returned session-scoped URL. `cctl dev list` shows current status. Parallel sessions use different ports: discovery alone does not establish that a server belongs to this worktree.

The configured tool names can differ between backends (`.mcp.json` and `.codex/config.toml`). Discover the available tools and follow their current input schemas rather than assuming a cached command signature.

## Application diagnostics

If Next.js MCP is unavailable, use the session server logs, the registered checks, and available browser diagnostics; do not treat tool absence as a reason to stop independent work. When the tools are available:

1. Use `nextjs_index` with the port from this session's URL. It returns the running Next.js server's available runtime tools and schemas.
2. Execute the relevant runtime tool through `nextjs_call`, supplying that port, the discovered `toolName`, and arguments in the callable schema's format. Tools such as `get_errors`, `get_logs`, route metadata, and server-action lookup belong to this runtime surface; they are not necessarily top-level MCP tools.
3. Fix diagnosed errors within the requested scope and recheck the affected route. A clean runtime error report does not replace the project's typecheck or prove that an interaction works.

For a Next.js documentation question, use `nextjs_docs` for the installed project's version and read the relevant local documentation it identifies. Its current interface locates version-matched docs; use the returned instructions if the installed tool differs.

## Browser diagnostics

Open or select a page at the session URL. Retain its returned page ID and include it in calls whose schema requires `pageId`.

- **Interactions:** take an accessibility snapshot and use its element `uid` for Chrome click/fill/hover tools. These tools do not accept an arbitrary CSS selector in place of a UID. Refresh the snapshot after changes that invalidate element handles.
- **Waiting:** Chrome `wait_for` waits for text; use its current `text`/timeout schema. With Playwright, wait for a specific locator or state. Persistent SSE makes `networkidle` unsuitable for CC.
- **Visual checks:** capture and open screenshots at states and viewport sizes affected by the change. Exercise keyboard/pointer behavior separately; screenshots establish appearance only.
- **Client failures:** inspect console messages and network requests; drill into specific request IDs to confirm payloads, status, and responses. Use `evaluate_script` with a JavaScript function for a bounded state probe.
- **Performance:** start a trace, perform the target interaction, stop the trace, and inspect the relevant insight. Compare equivalent conditions when judging a change.

## Recovery and completion

If discovery fails, retry with the port already returned by `cctl dev ensure`, then inspect that server's status/logs. Ask for a UI-started server only if CC reports `NO_DEV_SERVERS_CONFIGURED` or an unrecoverable start failure. Do not upgrade Next.js or restart another session's server to repair discovery.

Finish when the requested behavior has been exercised and relevant diagnostics are resolved. Report what was inspected, the evidence, and any material verification limit; avoid implying that a clean console proves durable backend behavior.
