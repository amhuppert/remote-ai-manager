/**
 * fetch-fixture.ts — THE sanctioned client-test seam (engineering-principles
 * DI table; plan D20).
 *
 * Component/hook tests MUST NOT `vi.mock` internal query/mutation/store
 * modules. Instead, run the real hooks — real React Query, real
 * `src/lib/api/fetcher.ts` validation, real Zod schemas — against this
 * fixture, which fakes the one boundary that is genuinely external: the
 * network, at `globalThis.fetch`. `tracedFetch` wraps global fetch, so both
 * `apiFetch` and `mutationFetch` flow through it.
 *
 * Usage:
 *
 *   let api: FetchFixture;
 *   beforeEach(() => {
 *     api = installFetchFixture();
 *     api.json("GET", "/api/config", { config, raw });
 *     api.pending("GET", "/api/config/mcp");   // stays loading forever
 *   });
 *   afterEach(() => api.restore());
 *
 *   // Render with the injectable query client:
 *   renderWithQuery(<ConfigPage />);           // @/test/component-mocks
 *   await screen.findByRole("heading", { name: /General settings/i });
 *
 *   // Assert mutations by observing the wire, not a mocked hook:
 *   expect(api.requestsTo("PUT", "/api/config")[0]?.jsonBody).toEqual(...);
 *
 * Queries resolve asynchronously, so first assertions after render use
 * `findBy*` / `waitFor` rather than synchronous `getBy*`.
 *
 * Unmatched requests reject loudly (and are recorded in `fixture.unmatched`)
 * so a missing route surfaces as a visible query error instead of a silent
 * hang.
 *
 * Migration status (the `internal-vi-mocks` seam, `scripts/seam-adoption.ts`):
 * the client-test population that this fixture retires is the set of `vi.mock`
 * calls on internal QUERY / MUTATION / Zustand-STORE modules in the client test
 * corpus (`.test.tsx`). Not every residual internal `vi.mock` is in scope: tests
 * that substitute a CHILD COMPONENT or a browser-only integration hook
 * (`useVoiceRecorder`, `useAppHotkey`) to shallow-render a layout are a
 * different boundary (component/hook injection), and event-sink store mocks
 * that assert on setter calls are best migrated to real-store state reads — the
 * fetch fixture does not cover those. The ratchet counts all internal
 * `vi.mock`s together; this seam's DELETION CONDITION is narrower: it is retired
 * once no client test mocks an internal query/mutation/store module, at which
 * point the remaining ratchet population is the component/hook-injection set,
 * which a separate seam (or a sanctioned component-double helper) should track.
 */

export interface RecordedRequest {
  method: string;
  url: string;
  pathname: string;
  searchParams: URLSearchParams;
  /** Parsed JSON request body; null when absent or not valid JSON. */
  jsonBody: unknown;
}

export interface RouteReply {
  /** @default 200 */
  status?: number;
  json: unknown;
}

export type Responder =
  | RouteReply
  | ((req: RecordedRequest) => RouteReply | Promise<RouteReply>);

/** String patterns match the pathname exactly (query string ignored);
 * RegExp patterns test against `pathname + search`. */
export type PathPattern = string | RegExp;

export interface FetchFixture {
  /** Register a 200 JSON reply. */
  json(method: string, path: PathPattern, body: unknown): void;
  /** Register a full responder (status control / per-request logic). */
  reply(method: string, path: PathPattern, responder: Responder): void;
  /** Register a route whose response never resolves (perpetual loading). */
  pending(method: string, path: PathPattern): void;
  /** Every request the fixture saw, in arrival order. */
  readonly requests: readonly RecordedRequest[];
  /** Requests that matched no route (each also rejected loudly). */
  readonly unmatched: readonly RecordedRequest[];
  requestsTo(method: string, path: PathPattern): RecordedRequest[];
  /** Reinstate the fetch that was global when the fixture was installed. */
  restore(): void;
}

interface Route {
  method: string;
  path: PathPattern;
  responder: Responder | typeof PENDING;
}

const PENDING = Symbol("fetch-fixture-pending");

function matchesPath(path: PathPattern, req: RecordedRequest): boolean {
  if (typeof path === "string") return req.pathname === path;
  return path.test(
    req.pathname + (req.searchParams.size > 0 ? `?${req.searchParams}` : ""),
  );
}

function toRecordedRequest(
  input: RequestInfo | URL,
  init?: RequestInit,
): RecordedRequest {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const parsed = new URL(url, "http://fixture.test");
  const method = (
    init?.method ??
    (typeof input === "object" && "method" in input ? input.method : "GET")
  ).toUpperCase();
  let jsonBody: unknown = null;
  if (typeof init?.body === "string") {
    try {
      jsonBody = JSON.parse(init.body);
    } catch {
      jsonBody = null;
    }
  }
  return {
    method,
    url,
    pathname: parsed.pathname,
    searchParams: parsed.searchParams,
    jsonBody,
  };
}

export function installFetchFixture(): FetchFixture {
  const previousFetch = globalThis.fetch;
  const routes: Route[] = [];
  const requests: RecordedRequest[] = [];
  const unmatched: RecordedRequest[] = [];

  const fixtureFetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const req = toRecordedRequest(input, init);
    requests.push(req);

    // Last registration wins so tests can swap a route's data mid-test.
    const route = [...routes]
      .reverse()
      .find((r) => r.method === req.method && matchesPath(r.path, req));

    if (!route) {
      unmatched.push(req);
      const known = routes.map((r) => `${r.method} ${String(r.path)}`);
      throw new Error(
        `fetch-fixture: no fixture route for ${req.method} ${req.pathname} — ` +
          (known.length > 0
            ? `registered routes: ${known.join(", ")}`
            : "no routes registered"),
      );
    }

    if (route.responder === PENDING) {
      return new Promise<Response>(() => {});
    }

    const reply =
      typeof route.responder === "function"
        ? await route.responder(req)
        : route.responder;

    return new Response(JSON.stringify(reply.json), {
      status: reply.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  globalThis.fetch = fixtureFetch as typeof fetch;

  return {
    json(method, path, body) {
      routes.push({
        method: method.toUpperCase(),
        path,
        responder: { json: body },
      });
    },
    reply(method, path, responder) {
      routes.push({ method: method.toUpperCase(), path, responder });
    },
    pending(method, path) {
      routes.push({ method: method.toUpperCase(), path, responder: PENDING });
    },
    requests,
    unmatched,
    requestsTo(method, path) {
      const m = method.toUpperCase();
      return requests.filter((r) => r.method === m && matchesPath(path, r));
    },
    restore() {
      globalThis.fetch = previousFetch;
    },
  };
}
