# Next.js 16 Upgrade & MCP Tooling Implementation Plan

## Overview

Upgrade the project from Next.js 15.5.12 to Next.js 16, migrate ESLint from legacy `.eslintrc.json` to flat config, and configure both the Next.js DevTools MCP server and Chrome DevTools MCP server for AI-assisted development.

The codebase is already well-prepared: async `params` patterns are already in use, there is no middleware, no parallel routes, no custom webpack config, no legacy APIs, and no deprecated features. The upgrade is low-risk.

## Pre-Upgrade State

| Item | Current |
|---|---|
| Next.js | ^15.1.0 (installed: 15.5.12) |
| React / React DOM | ^19.0.0 |
| Node.js | v22.14.0 |
| TypeScript | ^5.7.0 (installed: 5.9.3) |
| ESLint | ^9.16.0 with `.eslintrc.json` (legacy format) |
| Middleware | None |
| Custom webpack | None |
| Parallel routes | None |

## Implementation Steps

### Step 1: Upgrade Next.js, React, and related packages

```bash
npm install next@latest react@latest react-dom@latest
npm install -D @types/react@latest @types/react-dom@latest eslint-config-next@latest
```

After install, verify the installed Next.js version is 16.x:

```bash
npx next --version
```

### Step 2: Remove `reactStrictMode` from `next.config.ts`

React 19+ enables strict mode by default in development. The explicit `reactStrictMode: true` is redundant. Simplify `next.config.ts` to:

```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {};

export default nextConfig;
```

### Step 3: Migrate ESLint to flat config

#### 3a: Delete `.eslintrc.json`

Remove the legacy config file.

#### 3b: Install `eslint-config-prettier`

The project uses Prettier. To prevent ESLint/Prettier conflicts in flat config:

```bash
npm install -D eslint-config-prettier
```

#### 3c: Create `eslint.config.mjs`

```js
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import prettier from "eslint-config-prettier/flat";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  prettier,
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"]),
]);

export default eslintConfig;
```

This replaces the legacy `"extends": "next/core-web-vitals"` with the equivalent flat config, adds TypeScript rules, and disables formatting rules that conflict with Prettier.

#### 3d: Update the `lint` script in `package.json`

`next lint` is removed in v16. Change:

```json
"lint": "npx eslint ."
```

### Step 4: Verify the build

Run these commands sequentially and fix any issues before moving on:

```bash
npm run typecheck
npm run build
npm run lint
npm run test:run
```

**Expected**: All pass cleanly. The codebase already uses async params and has no deprecated APIs.

**If `get_errors` or build errors appear**: The most likely issue is any lingering synchronous access to request APIs. Search for `cookies()`, `headers()`, `draftMode()`, `params`, or `searchParams` patterns that aren't awaited. The codemod `npx @next/codemod@canary migrate-to-async-dynamic-apis .` can fix these automatically if needed.

### Step 5: Configure Next.js DevTools MCP

#### 5a: Create `.mcp.json` at project root

This file is editor-agnostic and will be picked up by Claude Code, Cursor, VS Code Copilot, etc.

```json
{
  "mcpServers": {
    "next-devtools": {
      "command": "npx",
      "args": ["-y", "next-devtools-mcp@latest"]
    }
  }
}
```

#### 5b: Add to Claude Code directly

For immediate availability in Claude Code without restarting:

```bash
claude mcp add next-devtools --scope project npx next-devtools-mcp@latest
```

### Step 6: Configure Chrome DevTools MCP

Add Chrome DevTools MCP to the same `.mcp.json`:

```json
{
  "mcpServers": {
    "next-devtools": {
      "command": "npx",
      "args": ["-y", "next-devtools-mcp@latest"]
    },
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest"]
    }
  }
}
```

And register with Claude Code:

```bash
claude mcp add chrome-devtools --scope project npx chrome-devtools-mcp@latest
```

### Step 7: Verify MCP integration

1. Start the dev server: `npm run dev`
2. In Claude Code, use the `init` tool from next-devtools to establish context
3. Use `nextjs_index` (or `discover_servers`) to confirm it discovers the running dev server at `/_next/mcp`
4. Use `get_errors` to verify it can retrieve diagnostics
5. Use `take_screenshot` from chrome-devtools to verify browser integration

## File Changes Summary

| File | Action |
|---|---|
| `package.json` | Update `next`, `react`, `react-dom`, `@types/react`, `@types/react-dom`, `eslint-config-next` versions; change `lint` script |
| `next.config.ts` | Remove `reactStrictMode: true` (now default) |
| `.eslintrc.json` | Delete |
| `eslint.config.mjs` | Create (flat config with core-web-vitals + typescript + prettier) |
| `.mcp.json` | Create (next-devtools + chrome-devtools servers) |

## MCP Usage Strategy

### Next.js DevTools MCP (Application Layer)

Use during development for:
- **`get_errors`**: After code changes, check for build/runtime/type errors without switching to browser
- **`get_logs`**: Access server and browser console output
- **`get_page_metadata`**: Understand route structure, components, rendering info for a page
- **`get_project_metadata`**: Project config and structure overview
- **`get_server_action_by_id`**: Trace server actions back to source
- **`nextjs_docs`**: Query official Next.js documentation in-session

### Chrome DevTools MCP (Browser Layer)

Use for visual verification and debugging:
- **`take_screenshot`**: Visual verification of UI after changes
- **`navigate_page` / `click` / `fill`**: Automated interaction testing
- **`list_network_requests` / `get_network_request`**: Inspect API calls
- **`list_console_messages`**: Check for client-side errors
- **`evaluate_script`**: Run JS in page context for debugging
- **`performance_start_trace` / `performance_stop_trace`**: Profile page performance

### Combined Workflow

1. Edit code in Claude Code
2. `get_errors` from Next.js MCP for instant server-side feedback
3. `take_screenshot` from Chrome MCP for visual verification
4. `list_network_requests` + `list_console_messages` from Chrome MCP for runtime debugging
5. `nextjs_docs` from Next.js MCP for documentation lookups during implementation

## Risk Assessment

| Risk | Likelihood | Mitigation |
|---|---|---|
| Async API breakage | Very Low | Codebase already uses async params. Run codemod if issues surface. |
| Turbopack incompatibility | Very Low | No custom webpack config. Clean Turbopack transition. |
| ESLint flat config issues | Low | Well-documented migration. If issues arise, the codemod `npx @next/codemod@canary next-lint-to-eslint-cli .` can help. |
| MCP server connectivity | Low | Requires dev server running. Restart dev server and Claude Code if connection fails. |
