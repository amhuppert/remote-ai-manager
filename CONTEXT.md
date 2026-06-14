# Domain & architecture context

Vocabulary for Command Center's modules and seams. Architecture terms follow the
"deep modules" language (module / interface / seam / adapter / depth / leverage /
locality); domain terms name the concepts the code is about.

## Architecture terms

- **Route resolution** — the shared seam that turns a route handler's opening
  cross-section (unwrap dynamic params → resolve the addressed entities with a
  404 → validate the request body with a 400) into one `RouteResolution<T>`
  value. Handlers thread it with `if (!r.ok) return r.response;`, keeping only
  their own service call and response shape. Lives in
  `src/lib/shared/route-resolution.ts`.

- **RouteResolution<T>** — the contract every resolution step returns:
  `{ ok: true; value: T } | { ok: false; response: Response }`. The failure
  variant is independent of `T`, so a failure from one step returns directly
  from a resolver producing a different `T`.

- **Route resolver (adapter)** — a domain function that produces a
  `RouteResolution` for one addressing shape. Two adapters exist:
  `resolveSessionRoute` / `resolveSessionConversationRoute` (session-scoped,
  `src/lib/conversations/route-resolution.ts`) and
  `resolveProjectConversationRoute` (project-scoped,
  `src/lib/project-conversations/route-resolution.ts`). Both compose
  `resolveProjectOr404`.

- **broadcastEvent** — the best-effort SSE emit seam for route handlers: builds
  an event and broadcasts it inside one failure guard, swallowing any throw with
  a structured warn so a post-mutation broadcast can never fail the request.
  Lives in `src/lib/events/broadcast-event.ts`.

## Domain terms

- **Session conversation** — a conversation owned by a session worktree;
  addressed by `project → session → conversation`.
- **Project conversation** — a session-less, project-scoped conversation;
  addressed by `project → conversation`.
