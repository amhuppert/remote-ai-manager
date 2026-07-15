# Logging and Debugging

The canonical logging architecture, event conventions, trace propagation, file layout, transcript format, and performance-analysis workflow live in [`.kiro/steering/logs.md`](../.kiro/steering/logs.md). Update that steering document when logging behavior changes; this page is only the operator entry point.

## Locations

Persistent logs live under the active Command Center config directory:

```text
logs/global.log
logs/sessions/<project>__<session>/session.log
logs/sessions/<project>__<session>/conversations/<conversation>.log
workflow-logs/<executionId>/
transcripts/<conversationId>.jsonl
```

`logs/global.log` is the cross-session NDJSON timeline. Session and conversation files contain scoped detail. Conversation transcripts are content records, not debug logs.

## Analysis

```bash
bun run logs:analyze -- --help
bun run logs:analyze -- --in <path-to-ndjson>
bun run logs:duckdb
```

Use `traceId` to correlate request, lifecycle, backend, persistence, and publication events. Pass scoped files or rotated backups explicitly with `--in` when the global log lacks the required detail.

## Implementation contract

- Use `createLogger` from `@/lib/logging` and stable `domain.action` event names.
- Log structured identifiers and timing fields, not formatted prose or full payloads.
- Never log credentials, tokens, authorization headers, full prompt contents, or image data.
- Background entry points establish trace context with `runAsTrace`; nested operations use `timed()`.
- Server events publish through `src/lib/events/publication.ts`; logging does not bypass the typed publication seam.
