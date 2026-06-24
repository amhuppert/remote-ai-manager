# AGENTS.md

`CLAUDE.md` is the canonical engineering guide for AI agents in this repository — read it for project context, structure, type-safety rules, the no-internal-`vi.mock()` rule, logging conventions, and the Kiro spec-driven workflow. The conventions there apply to every agent working in this repo, including this one.

## Testing: persistence-dependent tests

- **Use the real-store fixture, not a JS-object fake.** When a test's correctness depends on a value surviving the repository ↔ SQLite serialization round-trip (e.g. mutate a conversation, then read it back), inject `createPersistenceFixture()` from `src/lib/shared/testing/persistence-fixture.ts` (real repos over a fresh `:memory:` DB) and assert on the **reloaded** state. A hand-rolled in-memory `mutateConversation`/`getConversation` fake never serializes, so it cannot catch a dropped or default-masked field. Stub-only tests that only feed a crafted input (no read-back) may stay on lightweight fakes.
- **Every state-store repo has a schema-driven durability backstop.** Each `*.contract.test.ts` round-trips a maximal fixture through the real repo via `assertRoundTripDurability` (`src/lib/shared/testing/round-trip-durability.ts`). When you add a persisted field or a new repo/table, extend or add that contract — and declare any intentionally non-persisted or derived-on-write field in its policy map — so a serialization drop fails the suite instead of escaping to live verification.

## Worktree & git safety

Sessions run in isolated git worktrees that share one `.git` common directory (see CLAUDE.md → "Worktree Isolation" for the full set of rules).

- **Never `git stash pop` or `git stash apply` — and avoid `git stash` entirely.** The stash stack is shared repo-wide across *every* worktree, so the entry you pop may belong to another session: it dumps a stranger's changes into your tree as conflicts and can lose their work. `git stash push -- <paths>` also silently aborts if any listed path is invalid (e.g. an untracked file), so a later `pop` lands a foreign stash you never pushed. To compare against a clean baseline, inspect read-only (`git show HEAD:<path>`, `git diff`) or restore specific files you own with `git checkout HEAD -- <path>`; if you need an isolated baseline tree, `git worktree add` a throwaway — never stash.
