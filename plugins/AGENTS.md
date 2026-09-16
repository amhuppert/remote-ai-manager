# Plugin authoring

Skills in this directory are consumed by agents launched through Command Center but working on non-Command Center projects. Write for agents with access to their target project, the provided plugin bundle, and the `cctl` CLI. They must not need access to the Command Center codebase or its development history.

- Keep shared skills in the plugin source; managed delivery makes them available to consuming projects.
- Do not assume the target project has the same repository layout, configuration, registered commands, or development tooling as Command Center.
- Package required references with the plugin or point to available CLI help. Do not require Command Center source files, internal reports, tickets, or commit history.
- State guidance directly. Keep notes about incidents that earned a rule in repository design or report documents outside the shipped skills. Use examples only when they clarify the instruction and are useful across projects, without historical identifiers.

When changing the shipped Command Center plugin, bump `plugins/command-center/command-center/.claude-plugin/plugin.json` once for the change set. Plugin installation and global cache updates are separate from editing its source.

The CLI command catalog and exit table are generated: after changing their registry or layout, run `bun scripts/cc-cli-skill-reference.ts`, then its `--check` mode. The generator owns the marked blocks in the `cc-cli` skill and its `references/command-reference.md`.
