# CC MCP Configuration — Manual Test Cases

1. [x] Open global config page; verify existing `.mcp.json` servers render with status, name, and tool counts.
2. [ ] Add a new MCP server via global config; confirm it persists to `.mcp.json` and appears after page reload.
3. [ ] Edit a global MCP server's command/args; verify changes persist and the server reconnects.
4. [ ] Delete a global MCP server; confirm it's removed from `.mcp.json` and disappears from all scopes.
5. [ ] Open a project's MCP modal; verify all global servers appear with "inherited" badges by default.
6. [ ] Disable a server at project scope; confirm an override is recorded and inheritance badge changes.
7. [ ] Click "reset to inherited" on a project-overridden server; verify it reverts to global state.
8. [ ] Open a session's MCP modal; verify it inherits from project and shows correct cascade indicators.
9. [ ] Disable a server at session scope; confirm only that session is affected, project/global unchanged.
10. [ ] Open the conversation MCP popover from the prompt input; verify it shows session-inherited config.
11. [ ] Override a server at conversation scope; send a prompt and confirm the override applies for that turn only.
12. [ ] Toggle an individual tool off (e.g., disable one tool of a multi-tool server); verify only that tool is excluded.
13. [ ] Reset an individually overridden tool; confirm it returns to inherited state with badge updated.
14. [ ] Click "refresh tools" on a server; verify the tool list re-discovers and updates without page reload.
15. [ ] Send a prompt to Claude with a server enabled; confirm the SDK invocation includes that server's tools (check transcript/logs).
16. [ ] Send a prompt with a server disabled at the active scope; confirm Claude has no access to those tools.
17. [ ] Stop and restart the dev server; verify all MCP overrides at every scope persist correctly across restart.
18. [ ] Configure a deliberately broken MCP server (bad command); verify error status surfaces in UI without crashing the page.
19. [ ] Open MCP modals concurrently in two browser tabs and edit; verify SSE/refetch keeps both views consistent.
20. [ ] Verify cascade resolution: set conflicting overrides at all 4 levels and confirm conversation > session > project > global precedence.
