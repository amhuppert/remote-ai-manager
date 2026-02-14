# Research & Design Decisions

## Summary

- **Feature**: `transcript-viewer`
- **Discovery Scope**: Extension (existing system — fully implemented with tests)
- **Key Findings**:
  - Transcript parsing is fully implemented in `src/lib/transcript.ts` with comprehensive test coverage in `transcript.test.ts`
  - Conversation rendering is implemented in `SessionDetailPage.tsx` with message navigation and auto-scroll
  - Zod schemas for transcript entries are defined in `src/lib/schemas.ts`

## Research Log

### Existing Architecture Analysis

- **Context**: Transcript viewer is already implemented; mapping implementation against requirements.
- **Sources Consulted**: `src/lib/transcript.ts`, `src/lib/transcript.test.ts`, `src/app/projects/[name]/[session]/page.tsx`, `SessionDetailPage.tsx`
- **Findings**:
  - `readTranscript()` reads JSONL file, parses each line with `safeParse`, filters for user/assistant messages, extracts text content, and returns `TranscriptMessage[]`
  - `extractContent()` handles both string and array-of-blocks content formats
  - Content blocks are filtered to only `type: "text"` blocks, joined with newlines
  - 7 test cases cover: non-existent file, string content, content blocks, non-message filtering, malformed JSON, empty content, missing timestamps, empty files
  - `SessionDetailPage.tsx` renders messages with navigation controls (prev/next), message counter, and auto-scroll to latest message
  - Transcript path is set via hooks (see hook-integration feature)
- **Implications**: Feature is complete with good test coverage. No new components needed.

### Claude Code Transcript Format

- **Context**: Understanding the JSONL transcript format.
- **Findings**:
  - Each line is a JSON event object
  - Message events have `type: "user"` or `type: "assistant"` (or `message.role` as fallback)
  - Content can be a plain string or an array of content blocks (`{ type: "text", text: "..." }`)
  - Non-message events include `tool_use`, `permission`, system events — these are skipped
  - Timestamps are optional ISO 8601 strings
- **Implications**: Defensive parsing is essential — `safeParse` handles unexpected formats gracefully.

## Design Decisions

### Decision: Zod safeParse for Each Line

- **Context**: How to handle potentially malformed transcript data
- **Selected Approach**: `safeParse` each line individually, skip failures
- **Rationale**: Transcripts may contain incomplete writes or unexpected event types. Line-by-line validation prevents one bad entry from losing all data.

### Decision: Server-Side Rendering for Transcript

- **Context**: Where to load and process transcript data
- **Selected Approach**: Server Component reads transcript in `page.tsx`, passes as props to client component
- **Rationale**: Transcript files can be large; server-side reading avoids sending JSONL data to the client. Matches existing SSR pattern.

## Risks & Mitigations

- **Large transcript files** — No streaming or pagination; entire file read into memory. Acceptable for local tool; could be addressed in future.
- **Stale transcript data** — Page must be refreshed to see new messages. Real-time updates are a non-goal.

## References

- Claude Code transcript JSONL format — line-per-event with type discrimination
- Zod `safeParse` — non-throwing validation for external data
