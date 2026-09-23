# Seeded documents

Use `definition.seededDocuments[]` for reference material that should reach every
lane worktree with the plan. Each entry carries `relativePath` under
`.cc/graph-workflow-docs/`, `contents`, `description` and `readWhen`. Cite its path
in `sourcesOfTruth` and scope the source with `appliesTo` when only some contexts
need it: a document that is a scoped source is listed only to those contexts'
agents, and the worktree's `charter.md` omits it. The file itself is still on
disk in every worktree, so scoping hides a document from other contexts' prompts
rather than making it unreadable. Limits are 256 KB of UTF-8 contents per document and 1 MB across the
plan; both the CLI and server check them. These paths resolve at launch, so they
do not need to exist in the committed tree during planning.

