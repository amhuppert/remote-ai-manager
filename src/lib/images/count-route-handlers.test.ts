import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createImageCountRouteHandlers,
  type ImageCountRouteDeps,
} from "./count-route-handlers";

const testSession = {
  sessionName: "test-session",
  worktreePath: "/projects/my-project/.worktrees/test-session",
  branchName: "csm/test-session",
  createdAt: "2024-01-01T00:00:00Z",
  lastActivityAt: "2024-01-01T00:00:00Z",
  archived: false,
  finished: false,
  conversations: [],
};

function makeRequest(): Request {
  return new Request("http://localhost/image-count");
}

function makeParams(
  name = "my-project",
  session = "test-session",
  conversationId = "conv-1",
) {
  return { params: Promise.resolve({ name, session, conversationId }) };
}

function createTestDeps(
  overrides: Partial<ImageCountRouteDeps> = {},
): ImageCountRouteDeps {
  return {
    resolveProjectPath: vi.fn().mockResolvedValue("/projects/my-project"),
    getSession: vi.fn().mockResolvedValue(testSession),
    getNextImageIndex: vi.fn().mockResolvedValue(1),
    ...overrides,
  };
}

let deps: ImageCountRouteDeps;
let handlers: ReturnType<typeof createImageCountRouteHandlers>;

beforeEach(() => {
  vi.clearAllMocks();
  deps = createTestDeps();
  handlers = createImageCountRouteHandlers(deps);
});

describe("GET /api/.../conversations/[conversationId]/image-count", () => {
  it("returns count = getNextImageIndex - 1 (zero when no images)", async () => {
    const response = await handlers.GET(makeRequest(), makeParams());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ count: 0 });
    expect(deps.getNextImageIndex).toHaveBeenCalledWith("conv-1");
  });

  it("returns count = getNextImageIndex - 1 (positive when images exist)", async () => {
    deps = createTestDeps({
      getNextImageIndex: vi.fn().mockResolvedValue(5),
    });
    handlers = createImageCountRouteHandlers(deps);

    const response = await handlers.GET(makeRequest(), makeParams());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ count: 4 });
  });

  it("returns 404 when project is not found", async () => {
    deps = createTestDeps({
      resolveProjectPath: vi.fn().mockResolvedValue(null),
    });
    handlers = createImageCountRouteHandlers(deps);

    const response = await handlers.GET(makeRequest(), makeParams("unknown"));

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("Project not found");
  });

  it("returns 404 when session is not found", async () => {
    deps = createTestDeps({
      getSession: vi.fn().mockResolvedValue(null),
    });
    handlers = createImageCountRouteHandlers(deps);

    const response = await handlers.GET(makeRequest(), makeParams());

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("Session not found");
  });

  it("decodes URL-encoded session name", async () => {
    const response = await handlers.GET(
      makeRequest(),
      makeParams("my-project", "feature%2Fmy-branch", "conv-1"),
    );

    expect(response.status).toBe(200);
    expect(deps.getSession).toHaveBeenCalledWith(
      "/projects/my-project",
      "feature/my-branch",
    );
  });
});
