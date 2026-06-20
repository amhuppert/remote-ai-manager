# Stage B-2 retry — before/after parity captures (page components)

ProjectsIndexPage and SessionDiffViewer captured from the running dev app
(desktop 1440×900, mobile 390×844) via Playwright with animations frozen.
Before via revert to `55e69144` + dev HMR; after at HEAD.

**Result: 4 pairs — 4/4 byte-IDENTICAL** (projectsindex + sessiondiff, both
breakpoints). The primitive migrations (Tabs/Button/EmptyState/StatusDot/
SectionHeader) are byte-for-byte visually inert vs the legacy recipes.
