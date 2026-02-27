# Research & Design Decisions

## Summary
- **Feature**: `image-attachments`
- **Discovery Scope**: Extension
- **Key Findings**:
  - Claude Agent SDK `query()` supports `prompt: string | AsyncIterable<SDKUserMessage>` — the async iterable form allows structured content blocks including images
  - Anthropic API image format: `{ type: "image", source: { type: "base64", media_type, data } }` — matches the four accepted MIME types (image/jpeg, image/png, image/gif, image/webp)
  - Next.js App Router API routes use the Web Request API (`request.json()`) without a built-in body size limit — no special configuration needed for larger payloads

## Research Log

### Claude Agent SDK Prompt Format
- **Context**: Need to send images alongside text to the SDK's `query()` function
- **Sources Consulted**: [Agent SDK TypeScript Reference](https://platform.claude.com/docs/en/agent-sdk/typescript)
- **Findings**:
  - `query()` accepts `prompt: string | AsyncIterable<SDKUserMessage>`
  - `SDKUserMessage` wraps `APIUserMessage` from `@anthropic-ai/sdk`, which supports `content: ContentBlock[]`
  - Image content blocks follow: `{ type: "image", source: { type: "base64", media_type: "image/png", data: "<base64>" } }`
  - The async iterable form is designed for streaming input mode (multi-turn), but yielding a single message and completing the iterable works for single-shot prompts
- **Implications**: The server-side `executePromptStream()` must construct an `AsyncIterable<SDKUserMessage>` when images are present instead of passing a plain string

### Next.js App Router Body Size Limits
- **Context**: Base64-encoded images can make JSON payloads large (5 MB image → ~6.7 MB base64; 5 images → ~33 MB)
- **Sources Consulted**: [Next.js GitHub Issue #57501](https://github.com/vercel/next.js/issues/57501), [Next.js Docs](https://nextjs.org/docs/app/api-reference/config/next-config-js)
- **Findings**:
  - App Router API routes use the standard Web Request API (`request.json()`), which does not impose a body size limit at the framework level
  - The Pages Router `bodyParser.sizeLimit` config does not apply to App Router routes
  - Practical limits come from the Node.js runtime and reverse proxy (if any)
  - For the CC local-first use case (no reverse proxy), payloads up to ~50 MB are handled by Node.js without issue
- **Implications**: No framework-level configuration change needed. The existing `request.json()` calls in the API routes handle larger payloads transparently.

### Browser Clipboard API for Images
- **Context**: Need to capture pasted images from the system clipboard
- **Sources Consulted**: MDN Web Docs (ClipboardEvent, DataTransferItem)
- **Findings**:
  - The `paste` event on a DOM element provides `event.clipboardData.items` (a `DataTransferItemList`)
  - Items with `type.startsWith("image/")` can be converted to `Blob` via `item.getAsFile()`
  - The Blob can then be read as base64 using `FileReader.readAsDataURL()` or converted via `URL.createObjectURL()`
  - Text paste items have `kind === "string"` and should pass through to the textarea unchanged
  - Clipboard read is synchronous within the paste event handler; the base64 conversion is async
- **Implications**: The paste handler on the textarea must check for image items first, fall through to default behavior for text

### Transcript Storage Strategy
- **Context**: Deciding whether to store full base64 image data in JSONL transcripts
- **Findings**:
  - Storing full base64 keeps transcripts self-contained and enables full history replay
  - A single 5 MB image adds ~6.7 MB to the JSONL file; five images per prompt could add ~33 MB per prompt turn
  - CC is a local-first developer tool — disk space is not typically constrained
  - Alternative (disk file storage) adds file lifecycle management complexity that exceeds the value for this use case
- **Implications**: Store full base64 in transcript for simplicity. This matches the existing pattern where all content is self-contained in JSONL entries.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Extend existing (inline base64) | Widen existing types, send base64 in JSON body, store in transcript | Minimal new code, single request, self-contained transcripts | Large payloads, transcript growth | Recommended — fits CC's local-first model |
| Separate upload endpoint | Upload images to disk, reference by ID in prompt | Small payloads, small transcripts | Two-phase flow, file lifecycle management, more failure modes | Over-engineered for local tool |

## Design Decisions

### Decision: Use AsyncIterable for SDK Prompt
- **Context**: Need to send multi-modal content (text + images) to `query()`
- **Alternatives Considered**:
  1. Use string prompt and prepend image descriptions — loses visual data
  2. Use `AsyncIterable<SDKUserMessage>` yielding a single message with content blocks — preserves full image data
- **Selected Approach**: `AsyncIterable<SDKUserMessage>` with a single yielded message containing text and image content blocks
- **Rationale**: This is the SDK's native mechanism for structured prompts; it requires minimal code (an async generator function yielding one message)
- **Trade-offs**: Slightly more complex than a string prompt, but the only way to send images
- **Follow-up**: Verify that `resume` (session continuation) works correctly with the async iterable form

### Decision: Store Full Base64 in Transcripts
- **Context**: Whether to store full image data or references in JSONL transcript entries
- **Alternatives Considered**:
  1. Store full base64 in JSONL (simple, self-contained, large files)
  2. Save images to disk, store path reference in JSONL (smaller files, complex lifecycle)
  3. Omit images from transcript, show placeholder in history (lossy)
- **Selected Approach**: Store full base64 in JSONL
- **Rationale**: CC is local-first; disk space is not a constraint. Self-contained transcripts are simpler and enable full history replay. Adding file management for images adds complexity disproportionate to the benefit.
- **Trade-offs**: Transcript files grow significantly with image-heavy sessions
- **Follow-up**: None — acceptable for v1

### Decision: Client-Side Validation Only
- **Context**: Where to enforce image constraints (format, size, count)
- **Selected Approach**: Validate entirely on the client before submission
- **Rationale**: The user attaches images locally via clipboard/file picker. Validating at attachment time provides instant feedback. Server-side validation would duplicate the effort with no additional safety benefit (CC is a local-first single-user tool).
- **Trade-offs**: Trusts client-side code; acceptable for a local tool

## Risks & Mitigations
- **Large payload memory pressure**: Base64 encoding multiple 5 MB images could create ~33 MB JSON strings. Mitigated by the 5-image limit and the fact that CC is a local tool with ample resources.
- **Transcript file size growth**: Frequent image prompts could create large JSONL files. Acceptable for v1; can add transcript compaction later if needed.
- **SDK async iterable compatibility with resume**: Untested combination. Mitigated by testing early; the SDK documentation does not indicate restrictions.

## References
- [Agent SDK TypeScript Reference](https://platform.claude.com/docs/en/agent-sdk/typescript) — `query()` type signature and `SDKUserMessage` type
- [Anthropic API Messages](https://docs.anthropic.com/en/docs/build-with-claude/vision) — Image content block format
- [MDN ClipboardEvent](https://developer.mozilla.org/en-US/docs/Web/API/ClipboardEvent) — Browser clipboard image handling
- [Next.js GitHub Issue #57501](https://github.com/vercel/next.js/issues/57501) — App Router body size discussion
