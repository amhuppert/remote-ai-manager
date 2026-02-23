# Gap Analysis: Image Attachments

## 1. Current State Investigation

### Key Files & Modules

| File | Role | Relevance |
|------|------|-----------|
| `src/app/projects/[name]/[session]/SessionDetailPage.tsx` | Main session UI — prompt textarea, actions bar, message list | **Primary UI modification target** — needs clipboard handler, file picker, attachment preview |
| `src/hooks/use-send-prompt.ts` | Client-side prompt submission hook — builds JSON body, reads SSE stream | **Must transmit image data** — currently sends `{ prompt: string, modelId? }` |
| `src/lib/schemas.ts` | Zod schemas for all data entities | **Must extend** `runPromptRequestSchema` and `messageContentBlockSchema` |
| `src/lib/prompt.ts` | Server-side SDK integration — calls `query()`, processes messages, writes transcript | **Must convert images** to SDK format and record in transcript |
| `src/app/api/.../prompt/route.ts` (×2) | API routes for session-level and conversation-level prompts | **Must parse** new request format with images |
| `src/lib/transcript.ts` | JSONL transcript read/write | **Must handle** image content blocks in entries |
| `src/components/MessageContent.tsx` | Renders message content blocks | **Must render** image blocks |
| `src/types/index.ts` | Type re-exports | **Must re-export** new image-related types |

### Existing Conventions

- **Schema-first**: All entities defined as Zod schemas; types derived via `z.infer`
- **Discriminated unions**: `messageContentBlockSchema` uses `z.discriminatedUnion("type", [...])`
- **JSON transport**: Client sends `application/json`; server responds with SSE text stream
- **JSONL transcript**: Each entry serialized via `JSON.stringify`, one per line
- **Colocated components**: Page-specific components live beside their page

### Integration Surfaces

- **Claude Agent SDK `query()`**: Accepts `prompt: string | AsyncIterable<SDKUserMessage>`. The `SDKUserMessage` wraps an `APIUserMessage` from the Anthropic SDK, which supports content block arrays including `{ type: "image", source: { type: "base64", media_type, data } }` image blocks.
- **Clipboard API**: `navigator.clipboard` and `paste` event with `clipboardData.items` provide `Blob` access to copied images.
- **File input API**: Standard `<input type="file" accept="image/*">` for file selection.

---

## 2. Requirements Feasibility Analysis

### Technical Needs by Requirement

| Req | Need | Status |
|-----|------|--------|
| R1: Clipboard Paste | `paste` event handler on textarea, `clipboardData.items` → `Blob` → base64 | **Missing** — no clipboard handling exists |
| R2: File Picker | `<input type="file">` + button, `FileReader` → base64 | **Missing** — no file input exists |
| R3: Attachment Management | Client-side state (array of image objects), preview thumbnails, remove controls | **Missing** — no attachment state exists |
| R4: Image Transmission | Extend request schema with images array, convert to SDK `query()` format | **Missing** — schema only accepts `{ prompt: string }` |
| R5: History Display | Add `image` variant to `messageContentBlockSchema`, render `<img>` in `MessageContent.tsx` | **Missing** — no image block type exists |
| R6: Validation | Client-side checks (format, size, count) before attachment | **Missing** — no image validation exists |

### SDK Prompt Format — Key Finding

The SDK `query()` accepts two forms:
1. `prompt: string` — current usage (text only)
2. `prompt: AsyncIterable<SDKUserMessage>` — streaming input mode with structured content

For single-shot prompts with images, the simplest approach is to yield a single `SDKUserMessage` from an async iterable with `message.content` as an array of text + image content blocks. This avoids changing the fundamental SDK integration pattern.

### Gaps & Constraints

- **Missing: Image content block type** — `messageContentBlockSchema` has no `image` variant
- **Missing: Image in request payload** — `runPromptRequestSchema` only takes `prompt: string`
- **Missing: Client-side image state** — No mechanism to hold pending attachments
- **Missing: Image rendering** — `MessageContent.tsx` has no image handling
- **Constraint: JSON payload size** — Base64 encoding inflates images ~33%; 5 MB image → ~6.7 MB JSON. Five images could reach ~33 MB per request.
- **Constraint: Transcript size** — Storing base64 images in JSONL transcripts significantly increases file sizes. Consider storing a truncated reference or thumbnail instead.
- **Research Needed**: Whether to store full base64 in transcripts vs. save images to disk and reference by path. Disk storage is cleaner but adds file management complexity.

---

## 3. Implementation Approach Options

### Option A: Extend Existing Components (Recommended)

Extend the current prompt flow by widening the existing types and adding image handling inline:

- **Schema**: Add `image` variant to `messageContentBlockSchema`; extend `runPromptRequestSchema` with optional `images` array
- **API routes**: Minimal change — pass images alongside prompt text to `executePromptStream()`
- **`prompt.ts`**: Accept images parameter, construct `SDKUserMessage` with content block array, yield as async iterable to `query()`
- **`SessionDetailPage.tsx`**: Add `useState<ImageAttachment[]>` for pending images, paste handler on textarea, file input button, preview strip
- **`use-send-prompt.ts`**: Include images in the JSON body
- **`MessageContent.tsx`**: Add `image` block rendering
- **`transcript.ts`**: Store image content blocks as-is (base64 in JSONL)

**Trade-offs**:
- ✅ Minimal new files — extends natural data flow
- ✅ Leverages existing SSE/JSON transport
- ✅ Single source of truth for content blocks (schema drives everything)
- ❌ JSON payload can be large with multiple images
- ❌ Transcripts grow significantly with embedded base64

### Option B: Separate Image Upload Endpoint

Create a dedicated `/api/upload` endpoint that stores images on disk, returns references, and prompt submission uses references:

- Client uploads images separately → gets back file IDs/paths
- Prompt payload includes references, not raw data
- Server reads images from disk when constructing SDK messages

**Trade-offs**:
- ✅ Smaller JSON payloads
- ✅ Transcripts stay small (store references)
- ❌ Two-phase upload adds complexity and failure modes
- ❌ Requires file lifecycle management (cleanup, orphaned uploads)
- ❌ More API surface, more code

### Option C: Hybrid — Inline with Transcript Optimization

Use Option A for transport (base64 in JSON body) but optimize transcript storage:

- Transport: Send base64 in the prompt request body (simple, single request)
- Transcript: Store only metadata (media type, size, truncated hash) in JSONL — omit full base64
- History display: User messages with images show a placeholder (e.g., "[Image attached]") when loaded from transcript
- This sacrifices transcript-based image replay but keeps the system simple

**Trade-offs**:
- ✅ Simple transport (same as Option A)
- ✅ Small transcript files
- ❌ Images not visible when reloading conversation history from transcript
- ❌ Inconsistent — user sees images during live session but not in history

---

## 4. Implementation Complexity & Risk

**Effort: M (3–7 days)**
- Extends established patterns across well-understood layers (schema → API → SDK → UI)
- Image handling is well-documented in both browser APIs and the Anthropic SDK
- Most complexity is UI work (paste handler, file picker, preview strip, remove controls)

**Risk: Low–Medium**
- **Low**: Browser clipboard/file APIs are mature and well-documented
- **Low**: SDK image format is standard Anthropic API (base64 + media_type)
- **Medium**: Payload size limits could cause issues with Next.js defaults (body size limit is typically 1 MB); may need `bodyParser` config adjustment
- **Medium**: Storing base64 in transcripts affects disk usage over time

---

## 5. Recommendations for Design Phase

### Preferred Approach
**Option A (Extend Existing)** — straightforward, minimal new abstractions, fits the existing architecture.

### Key Decisions for Design
1. **Transcript storage strategy**: Store full base64 in JSONL (simple, but large) vs. save to disk (clean, but complex) vs. omit from transcript (lossy)?
2. **Next.js body size limit**: Must increase the default API body parser limit (e.g., `bodyParser: { sizeLimit: '20mb' }`) for routes accepting images.
3. **SDK prompt format**: Use `AsyncIterable<SDKUserMessage>` to yield a single user message with mixed text + image content blocks.

### Research Items
- Confirm `AsyncIterable<SDKUserMessage>` works for single-shot multi-modal prompts (vs. only for multi-turn streaming mode)
- Verify Next.js 15 App Router body size configuration mechanism
- Check if the `resume` option on `query()` works correctly with the async iterable prompt form
