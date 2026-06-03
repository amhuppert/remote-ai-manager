# Coordination: scope=project SSE → projectConversationKeys invalidation

**Owner of the registration:** the **notifications** extension (it holds the
global `/api/events` `NotificationListener`). The project-conversation-cockpit
spec does **not** fork that listener.

## What the cockpit exposes

`projectConversationKeys` — `src/lib/project-conversations-client/query-keys.ts`:

```ts
projectConversationKeys.list(projectName)       // open-PLC list + derived open-count
projectConversationKeys.openCount(projectName)  // (kept for symmetry)
projectConversationKeys.messages(projectName, conversationId)
```

## What the notifications extension must register

When the global conversation-event handler receives a **`scope: "project"`**
conversation event, it must invalidate the cockpit's keys:

| Event (`scope: "project"`) | Invalidate |
|---|---|
| `conversation-created` | `list(projectName)`, `openCount(projectName)` |
| `conversation-open` (close/reopen) | `list(projectName)`, `openCount(projectName)` — **required**: the first-run↔cockpit transition (Req 2.5 / 12.3) depends on this propagating promptly |
| `conversation-archived` | `list(projectName)`, `openCount(projectName)` |
| `conversation-renamed` | `list(projectName)` |
| `conversation-status` / `message-appended` / `message-updated` | `messages(projectName, conversationId)`, `list(projectName)` |

`projectName` comes off the event's project-variant identity payload
(`@/lib/conversations/schemas` — the project SSE event variants omit `sessionName`).

## Until that lands (current fallback)

The cockpit ships `useRefetchProjectConversationsOnFocus(projectName)`
(`src/lib/project-conversations-client/queries.ts`), which invalidates
`list`/`openCount` on window focus so the page stays correct (slightly less
live). Req 12.1's full near-real-time guarantee is **co-delivered** with the
notifications extension; remove or keep the focus fallback as a backstop once
the SSE registration lands.
