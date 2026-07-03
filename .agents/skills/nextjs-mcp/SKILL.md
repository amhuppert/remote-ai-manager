---
name: nextjs-mcp
description: This skill should be used when diagnosing application errors via
  the dev server, checking runtime or build errors, inspecting page routes,
  querying server actions, accessing dev server logs, verifying UI visually,
  debugging browser-side behavior, or profiling page performance. Relevant
  trigger phrases include "check for errors", "get page info", "inspect this
  route", "take a screenshot", "debug the page", "check console logs", "check
  network requests", "what's wrong with my app", "profile performance", "use
  next-devtools", "use chrome devtools", or "search next.js docs".
---

# Next.js MCP Development Tools

This project has two MCP servers configured in `.mcp.json` that provide real-time development diagnostics without leaving the editor.

## Prerequisites

The Next.js dev server must be running for runtime tools to function — run `cctl dev ensure` to start it (or confirm it's up) and obtain the session-scoped URL for your worktree; never assume a default port like 3000. The `/_next/mcp` endpoint is built into Next.js 16+ and is served under that URL.

## Available MCP Servers

### Next.js DevTools MCP (Application Layer)

Provides server-side diagnostics and project introspection.

| Tool | Parameters | Purpose |
|---|---|---|
| `init` | — | Establish context and documentation requirements at session start |
| `get_errors` | — | Retrieve current build errors, runtime errors, and type errors |
| `get_logs` | — | Get path to dev log file with browser console and server output |
| `get_page_metadata` | route path | Query routes, components, and rendering info for a specific page |
| `get_project_metadata` | — | Retrieve project structure, config, and dev server URL |
| `get_server_action_by_id` | action ID | Look up server actions by ID to find source file and function |
| `nextjs_docs` | search keywords | Search official Next.js documentation (two-step: search then fetch) |
| `nextjs_index` | — | Discover running Next.js 16+ dev servers and list available tools |
| `nextjs_call` | tool name, args | Execute specific runtime tools on the dev server MCP endpoint |

### Chrome DevTools MCP (Browser Layer)

Provides browser control, visual verification, and client-side debugging via Puppeteer and Chrome DevTools Protocol.

| Category | Tool | Parameters | Purpose |
|---|---|---|---|
| Navigation | `navigate_page` | url | Open a URL in the browser |
| Navigation | `list_pages` | — | List all open browser tabs |
| Navigation | `select_page` | page index | Switch to a specific tab |
| Navigation | `new_page` | url | Open a new tab |
| Navigation | `close_page` | — | Close the current tab |
| Navigation | `wait_for` | selector or timeout | Wait for element or duration |
| Input | `click` | selector | Click an element |
| Input | `fill` | selector, value | Fill a form field |
| Input | `fill_form` | form data | Fill multiple form fields at once |
| Input | `hover` | selector | Hover over an element |
| Input | `press_key` | key | Press a keyboard key |
| Input | `drag` | from, to | Drag an element |
| Input | `handle_dialog` | accept/dismiss | Handle browser dialogs |
| Input | `upload_file` | selector, path | Upload a file to an input |
| Debugging | `take_screenshot` | — | Capture current page as image |
| Debugging | `take_snapshot` | — | Capture DOM snapshot |
| Debugging | `evaluate_script` | JavaScript code | Execute JS in page context |
| Debugging | `list_console_messages` | — | List browser console output |
| Debugging | `get_console_message` | message index | Get details of a console entry |
| Network | `list_network_requests` | — | List all network requests |
| Network | `get_network_request` | request ID | Get request/response details |
| Performance | `performance_start_trace` | — | Begin performance recording |
| Performance | `performance_stop_trace` | — | Stop recording and get trace |
| Performance | `performance_analyze_insight` | — | Analyze recorded trace data |
| Emulation | `emulate` | device preset | Emulate a device (mobile, tablet) |
| Emulation | `resize_page` | width, height | Resize the browser viewport |

## Diagnostic Workflow

### After Code Changes

1. Call `get_errors` to check for build, runtime, and type errors immediately
2. If errors found, read the affected source files and fix
3. Call `get_errors` again to confirm resolution

If `get_errors` returns clean but the page behaves incorrectly, proceed to Runtime Debugging to inspect console messages and network requests.

### Visual Verification

1. Call `navigate_page` to open the target URL in Chrome
2. Call `take_screenshot` to capture current page state
3. Inspect the screenshot for layout issues or visual regressions

### Runtime Debugging

1. Call `list_console_messages` to check for client-side errors or warnings
2. Call `list_network_requests` to inspect API calls and responses
3. Call `get_network_request` with a specific request ID for detailed inspection
4. Call `evaluate_script` to run JavaScript in page context for state inspection

### Page Introspection

1. Call `get_page_metadata` with a route path to understand component structure
2. Call `get_project_metadata` for overall project configuration
3. Call `get_server_action_by_id` to trace server action calls to source code

### Performance Profiling

1. Call `performance_start_trace` before the interaction
2. Perform the user action (navigate, click, etc.)
3. Call `performance_stop_trace` to capture the trace
4. Call `performance_analyze_insight` for automated analysis

### Documentation Lookup

1. Call `nextjs_docs` with search keywords to find relevant documentation
2. Fetch the returned content URL for detailed guidance

## Session Initialization

At the start of a development session where MCP tools will be used, call `init` from the Next.js DevTools server to establish proper context. Then call `nextjs_index` to verify the dev server is discovered.

## Troubleshooting

If tools return connection errors:
- Verify the dev server is running: `cctl dev ensure` (starts it if needed and prints the session-scoped URL)
- Confirm the server is accessible at `<localUrl>/_next/mcp` — use the `localUrl` from `cctl dev ensure` / `cctl dev list`, not an assumed port like 3000
- Restart the dev server if it was started before MCP configuration
- Restart the MCP client (Claude Code) to reload `.mcp.json`

If Chrome DevTools tools fail:
- Ensure Chrome is installed and accessible
- Check that no other process is using the Chrome debugging port
