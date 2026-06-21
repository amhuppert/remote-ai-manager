// Minimal --entry for /design-sync. The real component surface ships via
// cfg.extraEntries (.design-sync/ds-entry.tsx), whose relative re-exports the
// converter's export scanner can read. This empty main keeps the __dsMainNs
// merge a no-op (no icon-sibling collisions to resolve). See ds-entry.tsx.
export {};
