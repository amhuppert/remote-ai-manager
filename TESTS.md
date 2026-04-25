# CC MCP Configuration — Manual Test Cases

1. [x] Open global config page; verify existing `.mcp.json` servers render with status, name, and tool counts.
2. [x] Add a new MCP server via global config; confirm it persists to `.mcp.json` and appears after page reload.
3. [x] Edit a global MCP server's command/args; verify changes persist and the server reconnects.
4. [x] Delete a global MCP server; confirm it's removed from `.mcp.json` and disappears from all scopes.
5. [x] Open a project's MCP modal; verify all global servers appear with "inherited" badges by default.
6. [x] Disable a server at project scope; confirm an override is recorded and inheritance badge changes.
7. [x] Click "reset to inherited" on a project-overridden server; verify it reverts to global state.
8. [x] Open a session's MCP modal; verify it inherits from project and shows correct cascade indicators.
9. [x] Disable a server at session scope; confirm only that session is affected, project/global unchanged.
10. [x] Open the conversation MCP popover from the prompt input; verify it shows session-inherited config.
11. [x] Override a server at conversation scope; send a prompt and confirm the override applies for that turn only.
12. [ ] Toggle an individual tool off (e.g., disable one tool of a multi-tool server); verify only that tool is excluded.
13. [ ] Reset an individually overridden tool; confirm it returns to inherited state with badge updated.
14. [x] Click "refresh tools" on a server; verify the tool list re-discovers and updates without page reload.
15. [x] Send a prompt to Claude with a server enabled; confirm the SDK invocation includes that server's tools (check transcript/logs).
16. [x] Send a prompt with a server disabled at the active scope; confirm Claude has no access to those tools.
17. [x] Stop and restart the dev server; verify all MCP overrides at every scope persist correctly across restart.
18. [x] Configure a deliberately broken MCP server (bad command); verify error status surfaces in UI without crashing the page.
19. [x] Open MCP modals concurrently in two browser tabs and edit; verify SSE/refetch keeps both views consistent.
20. [x] Verify cascade resolution: set conflicting overrides at all 4 levels and confirm conversation > session > project > global precedence.
