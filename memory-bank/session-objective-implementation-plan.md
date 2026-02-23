# Session Objective Implementation Plan

## Overview

Replace the session name input in the create session modal with an **objective textarea** (with voice input). The objective is used to:
1. Auto-generate the session name via Claude Haiku
2. Persist to `memory-bank/focus.md` in the session worktree
3. Inject into every Claude CLI invocation via `--append-system-prompt`

## Architecture

```
CreateSessionModal (objective textarea + voice)
  → POST /api/projects/[name]/sessions { objective }
    → generateSessionName(objective)  [Claude Haiku CLI]
    → createSession(projectPath, objective, generatedName)
      → git worktree add ...
      → write memory-bank/focus.md in worktree
      → persist objective in SessionState
    → return SessionState (includes generated sessionName)

executePromptStream()
  → reads session.objective from state
  → if non-null: adds --append-system-prompt "<objective>" to CLI args
```

## File Changes Summary

| File | Change |
|------|--------|
| `src/lib/schemas.ts` | Add `objective` to `sessionStateSchema`, change `createSessionRequestSchema` |
| `src/lib/sessions.ts` | Add `generateSessionName()`, modify `createSession()` to accept objective, write focus.md |
| `src/lib/prompt.ts` | Add `--append-system-prompt` when session has objective |
| `src/app/api/projects/[name]/sessions/route.ts` | Update POST handler for new request shape |
| `src/lib/mutations.ts` | Change `useCreateSessionMutation` to send `{ objective }` |
| `src/app/projects/[name]/CreateSessionModal.tsx` | Replace name input with objective textarea + voice |

## 1. Schema Changes (`src/lib/schemas.ts`)

### sessionStateSchema — add `objective` field

After line 80 (`source: sessionSourceSchema.default("csm"),`), add:

```typescript
objective: z.string().nullable().default(null),
```

This keeps backward compatibility — existing/imported sessions have `null`.

### createSessionRequestSchema — change to objective

Replace the existing schema:

```typescript
export const createSessionRequestSchema = z.object({
  objective: z.string().trim().min(1).max(500),
});
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;
```

## 2. Name Generation (`src/lib/sessions.ts`)

### New function: `generateSessionName`

Add an async function that calls Claude CLI with Haiku to generate a short name from the objective.

**Behavior:**
1. Spawn `claude` with args: `--model haiku -p "<prompt>" --output-format text --max-turns 1 --dangerously-skip-permissions`
2. CWD: any directory (use project path)
3. Env: strip `CLAUDE*` vars (same pattern as `executePromptStream`)
4. Timeout: 15 seconds
5. Parse output: trim whitespace, take first line only
6. Validate: run through `sanitizeBranchName()`, check non-empty
7. On any failure: fall back to heuristic

**Prompt template:**
```
Generate a short kebab-case name (2-4 words, lowercase, hyphens between words) for a coding session with this objective. Output ONLY the name, nothing else.

Objective: {objective}
```

**Fallback heuristic** (used when Haiku call fails or times out):
1. Take the objective text
2. Lowercase, split on whitespace
3. Remove common filler words: "a", "an", "the", "and", "or", "to", "for", "in", "on", "of", "with", "that", "this", "is", "it"
4. Take first 4 remaining words
5. Join with hyphens
6. Run through `sanitizeBranchName()`
7. If empty, use `"session"` as fallback

**Uniqueness:** After getting the name (from Haiku or fallback), use `ensureUniqueName()` from `worktrees.ts` to ensure no collision with existing session names in the project.

### Imports to add in sessions.ts

```typescript
import { mkdir, writeFile } from "node:fs/promises";
import { ensureUniqueName } from "./worktrees";
```

## 3. Session Creation Changes (`src/lib/sessions.ts`)

### Modified `createSession` signature

```typescript
export async function createSession(
  projectPath: string,
  objective: string,
): Promise<SessionState>
```

The function no longer receives a session name — it generates one internally.

### Changes inside `createSession`:

1. **Generate name**: Call `generateSessionName(objective)` to get the base name
2. **Ensure uniqueness**: Build `existingNames` set from `project?.sessions`, call `ensureUniqueName(baseName, existingNames)`
3. **Validate**: The generated name should pass `validateSessionName()`. If it doesn't (unlikely but possible), use the fallback heuristic directly
4. **Sanitize/branch/worktree**: Same as current code
5. **Write focus.md**: After worktree creation, before init script:
   ```typescript
   const memoryBankDir = path.join(worktreePath, "memory-bank");
   await mkdir(memoryBankDir, { recursive: true });
   await writeFile(
     path.join(memoryBankDir, "focus.md"),
     `# Session Focus\n\n## Objective\n\n${objective}\n`,
     "utf-8",
   );
   ```
6. **Store objective in state**: Add `objective` field to the `SessionState` object literal:
   ```typescript
   const session: SessionState = {
     sessionName,
     worktreePath,
     branchName,
     createdAt: now,
     lastActivityAt: now,
     archived: false,
     finished: false,
     conversations: [initialConversation],
     source: "csm",
     objective,
   };
   ```

### Rollback

The existing rollback logic (remove worktree, delete branch) handles failure. The focus.md is inside the worktree, so it gets cleaned up automatically with the worktree.

## 4. Prompt Execution Changes (`src/lib/prompt.ts`)

### Add `--append-system-prompt` to CLI args

In `executePromptStream`, after building the `args` array (around line 89, after `"--max-turns", "50"`), add:

```typescript
if (session.objective) {
  args.push("--append-system-prompt", `[Session Objective]\n${session.objective}`);
}
```

This injects the objective into every prompt execution for this session. The `session` parameter already contains the full `SessionState` including the new `objective` field.

No changes needed to the function signature — `session: SessionState` already includes all session fields.

## 5. API Route Changes (`src/app/api/projects/[name]/sessions/route.ts`)

### POST handler

Update the request parsing and session creation call:

```typescript
let body: { objective: string };
try {
  body = createSessionRequestSchema.parse(await request.json());
} catch {
  return NextResponse.json(
    { error: "objective is required (max 500 characters)" } satisfies ApiError,
    { status: 400 },
  );
}

try {
  const session = await createSession(projectPath, body.objective);
  return NextResponse.json(session, { status: 201 });
} catch (err) {
  // ... same error handling as current
}
```

The response shape doesn't change — it still returns `SessionState`, which now includes `objective` and the auto-generated `sessionName`.

## 6. Frontend Mutation Changes (`src/lib/mutations.ts`)

### `useCreateSessionMutation`

Change the `mutationFn` parameter from `sessionName: string` to `objective: string`:

```typescript
export function useCreateSessionMutation(projectName: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (objective: string) =>
      mutationFetch<SessionState>(
        `/api/projects/${encodeURIComponent(projectName)}/sessions`,
        "create-session",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ objective }),
        },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.list(projectName),
      });
    },
  });
}
```

## 7. Frontend Modal Changes (`src/app/projects/[name]/CreateSessionModal.tsx`)

### Full redesign of the modal

**New imports:**
```typescript
import { useVoiceRecorder } from "@/hooks/useVoiceRecorder";
import VoiceRecordButton from "@/components/VoiceRecordButton";
```

**State changes:**
- Replace `name` state with `objective` state: `const [objective, setObjective] = useState("")`
- Remove `sanitizedBranch` derived value
- Change `inputRef` from `HTMLInputElement` to `HTMLTextAreaElement`

**Voice integration:**
```typescript
const {
  isRecording,
  isProcessing,
  elapsedTime,
  isAvailable: voiceAvailable,
  toggleRecording,
} = useVoiceRecorder({
  projectName,
  onResult: (text) => {
    setObjective((prev) => (prev ? prev + "\n" + text : text));
  },
  onError: (error) => setError(error),
});
```

**Form submission:**
- `handleSubmit` calls `createMutation.mutate(objective.trim(), { ... })`
- Disable submit when `!objective.trim()` or `createMutation.isPending` or `isRecording`

**UI structure:**
- Modal title: "New Session"
- Label: "What do you want to work on?"
- `<textarea>` replacing `<input>`, with:
  - `rows={3}`
  - `placeholder="e.g. Add user authentication with JWT tokens"`
  - `maxLength={500}`
  - Same keyboard handling but Enter only submits when not Shift+Enter (allow multiline)
- Character count: `<div className="form-hint">{objective.length}/500</div>`
- Voice button: `<VoiceRecordButton>` rendered next to the textarea (or below it)
- Info text: `<div className="form-hint">Session name and branch will be auto-generated</div>`
- Remove the branch preview (`sanitizedBranch` display)
- Submit button text: `createMutation.isPending ? "Creating..." : "Create Session"`

**Keyboard handling for textarea:**
- Shift+Enter: newline (default textarea behavior)
- Enter (no shift): submit (prevent default)
- Enter while recording: stop recording (prevent submit)
- Escape: close modal

## 8. Type Updates (`src/types/index.ts`)

The `SessionState` type is derived via `z.infer` from the schema, so it will automatically include the new `objective: string | null` field after the schema change. No manual type changes needed.

## Implementation Order

1. **Schema** (`schemas.ts`) — add `objective` field and update request schema
2. **Sessions** (`sessions.ts`) — add `generateSessionName()`, update `createSession()`
3. **Prompt** (`prompt.ts`) — add `--append-system-prompt` logic
4. **API Route** (`route.ts`) — update POST handler
5. **Mutation** (`mutations.ts`) — update `useCreateSessionMutation`
6. **Modal** (`CreateSessionModal.tsx`) — redesign UI with textarea + voice

Steps 1-4 are backend (can be tested independently). Steps 5-6 are frontend (depend on backend changes).

## Error Handling

| Scenario | Handling |
|----------|----------|
| Haiku CLI fails/times out | Fall back to word-extraction heuristic |
| Generated name fails validation | Use fallback heuristic |
| Name collision | `ensureUniqueName()` appends `-2`, `-3`, etc. |
| Empty objective submitted | Zod validation rejects at API layer (min 1 char) |
| Objective > 500 chars | Zod validation rejects at API layer; textarea has `maxLength` |
| focus.md write fails | Part of worktree creation try/catch; triggers full rollback |
| Voice transcription fails | Error shown in modal via `onError`; user can type manually |

## Testing

### Unit tests (`src/lib/sessions.test.ts`)

- `generateSessionName` — mock `execFile` to return a name; verify sanitization
- `generateSessionName` fallback — mock `execFile` to reject; verify heuristic produces valid name
- `createSession` with objective — verify `memory-bank/focus.md` is created in worktree
- `createSession` uniqueness — verify `ensureUniqueName` is used when name conflicts exist

### Existing tests

- Verify existing session tests still pass (schema is backward-compatible with `.default(null)`)
- Verify `validateSessionName` still works for generated names
