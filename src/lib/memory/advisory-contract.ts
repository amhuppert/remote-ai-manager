/**
 * The static advisory contract (spec R5.4, D4): the one piece of memory
 * content that lives in the CC-owned governing instruction layer. It is
 * delivered once, through each backend's privileged instruction channel as it
 * exists — Claude's system-prompt append, the governing-instructions block
 * Codex and Cursor prepend on their first turn — and it never changes between
 * turns. The changing `<memory-index>` and `<memory-index-delta>` blocks are
 * composed per turn at the live-context seam and must never be folded into this
 * text: Codex and Cursor see their instructions only on turn one, so anything
 * dynamic here would be stale for them and fresh for Claude.
 *
 * The 300-word cap is a budget, not a style note — this text is paid for by
 * every conversation on every backend, so worked examples live on the
 * on-demand surfaces instead (the memory group's help and the cc-cli skill).
 */
export const MEMORY_ADVISORY_CONTRACT = [
  "<memory-contract>",
  "Command Center shares one memory across every agent and backend. Your first turn carries a full <memory-index> block of one-line hooks; later turns carry only a <memory-index-delta> of what changed. The CLI is everything else: `cctl memory get <slug>` reads one note, `cctl memory recall '<query>'` is the one bounded search, `cctl memory create` captures, `cctl memory link` binds a note to an artifact. Notes are addressed by slug.",
  "Memory is ADVISORY and POINT-IN-TIME: a note says what its author believed when they wrote it. Steering, AGENTS instructions, tests, tickets, specs, and workflow state own the truth. Verify every mutable claim against the live artifact — the ticket, the branch, the code — not the note.",
  "The block is budgeted, so hooks are omitted. If this turn touches something the block does not list, recall before you conclude.",
  "Writing a note: the hook is the whole index entry, so state a fact that stands alone rather than a topic. Put in the body only the mechanism or the exact command; a reader pays to open it.",
  "Index mode: `auto` competes for the block; `always` reserves a slot for a trap that bites regardless of the task; `search-only` holds reference material that should never compete, reachable by recall.",
  "Link a note to the ticket, spec, or workflow it is about (`cctl memory link <slug> --artifact ticket:<number>`) and it leads the index of every conversation working that artifact.",
  "Capture only knowledge that is durable, non-obvious, and not derivable from the repository or its instructions — or leased session-scoped working state in your own session scope. A perishable caveat goes in the statusNote, never in the hook. A fact a live artifact answers — ticket, merge, or spec status — is not recorded at all.",
  "</memory-contract>",
].join("\n");
