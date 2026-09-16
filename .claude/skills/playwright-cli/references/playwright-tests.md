# Running and debugging Playwright tests

Use the project's registered validation command for ordinary test runs: discover it with `cctl validate list` and pass the supported selection flags through `cctl validate run <name> --json`. Require a match when claiming a focused test passed.

For a failure that requires an interactive paused page, inspect the installed Playwright help for debug support. If the registered runner cannot express that diagnostic, state the narrow reason before invoking the single affected test directly under the root instruction's diagnostic exception:

```bash
PLAYWRIGHT_HTML_OPEN=never npx playwright test <affected-file>:<line> --debug=cli
```

Use tracked background execution while the test is paused. Wait for the actual debugging instructions/session name, then attach with `playwright-cli attach <returned-name>`. The `--debug=cli`/attach interface is version-sensitive; if unavailable, use the installed debugger or browser diagnostics instead of upgrading the toolchain for this check.

Inspect the failing state and determine whether the test's mechanics are stale or the application violates its intended behavior. Preserve valid regression assertions. Stop the task-owned debug run when finished, then rerun the affected registered validation.
