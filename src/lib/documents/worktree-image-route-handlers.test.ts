import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createWorktreeImageRouteHandlers,
  type WorktreeImageRouteDeps,
} from "./worktree-image-route-handlers";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";

const PROJECT_PATH = "/proj";
const PROJECT_NAME = "proj";
const WORKTREE = `${PROJECT_PATH}/.worktrees/sess`;
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

function enoent(): NodeJS.ErrnoException {
  const err = new Error("ENOENT") as NodeJS.ErrnoException;
  err.code = "ENOENT";
  return err;
}

function depsFromFixture(
  fx: PersistenceFixture,
  files: Record<string, Uint8Array>,
): { deps: WorktreeImageRouteDeps; readPaths: string[] } {
  const readPaths: string[] = [];
  const deps: WorktreeImageRouteDeps = {
    resolveProjectPath: async (name) =>
      name === PROJECT_NAME ? PROJECT_PATH : null,
    getSession: fx.store.getSession,
    readFile: async (absPath) => {
      readPaths.push(absPath);
      const bytes = files[absPath];
      if (bytes === undefined) throw enoent();
      return bytes;
    },
  };
  return { deps, readPaths };
}

function get(path: string | null): Request {
  const base = `http://localhost/api/projects/${PROJECT_NAME}/sessions/sess/worktree-images`;
  const url = path === null ? base : `${base}?path=${encodeURIComponent(path)}`;
  return new Request(url);
}

function params(session = "sess") {
  return { params: Promise.resolve({ name: PROJECT_NAME, session }) };
}

describe("worktree image route handler", () => {
  let fx: PersistenceFixture;

  beforeEach(() => {
    fx = createPersistenceFixture();
    fx.seedProject(PROJECT_PATH);
    fx.seedSession(PROJECT_PATH, "sess");
  });

  afterEach(() => {
    fx.close();
  });

  it("serves an image inside the worktree with its media type", async () => {
    const { deps, readPaths } = depsFromFixture(fx, {
      [`${WORKTREE}/.cc/temp/shot.png`]: PNG_BYTES,
    });
    const handlers = createWorktreeImageRouteHandlers(deps);

    const res = await handlers.GET(get(".cc/temp/shot.png"), params());

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG_BYTES);
    expect(readPaths).toEqual([`${WORKTREE}/.cc/temp/shot.png`]);
  });

  it("accepts an absolute path inside the worktree", async () => {
    const { deps, readPaths } = depsFromFixture(fx, {
      [`${WORKTREE}/shots/home.webp`]: PNG_BYTES,
    });
    const handlers = createWorktreeImageRouteHandlers(deps);

    const res = await handlers.GET(
      get(`${WORKTREE}/shots/home.webp`),
      params(),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(readPaths).toEqual([`${WORKTREE}/shots/home.webp`]);
  });

  it("stops a served SVG from running script when opened directly", async () => {
    const { deps } = depsFromFixture(fx, {
      [`${WORKTREE}/diagram.svg`]: new TextEncoder().encode("<svg/>"),
    });
    const handlers = createWorktreeImageRouteHandlers(deps);

    const res = await handlers.GET(get("diagram.svg"), params());

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
  });

  it("refuses paths outside the worktree without reading them", async () => {
    const { deps, readPaths } = depsFromFixture(fx, {
      "/etc/shot.png": PNG_BYTES,
      [`${PROJECT_PATH}/shot.png`]: PNG_BYTES,
    });
    const handlers = createWorktreeImageRouteHandlers(deps);

    for (const path of ["/etc/shot.png", "../../shot.png", "a/../../x.png"]) {
      const res = await handlers.GET(get(path), params());
      expect(res.status).toBe(404);
    }
    expect(readPaths).toEqual([]);
  });

  it("refuses a non-image path without reading it", async () => {
    const { deps, readPaths } = depsFromFixture(fx, {});
    const handlers = createWorktreeImageRouteHandlers(deps);

    const res = await handlers.GET(get(".env"), params());

    expect(res.status).toBe(400);
    expect(readPaths).toEqual([]);
  });

  it("requires a path", async () => {
    const { deps } = depsFromFixture(fx, {});
    const handlers = createWorktreeImageRouteHandlers(deps);

    const res = await handlers.GET(get(null), params());

    expect(res.status).toBe(400);
  });

  it("returns 404 for a missing image or an unknown session", async () => {
    const { deps } = depsFromFixture(fx, {});
    const handlers = createWorktreeImageRouteHandlers(deps);

    expect((await handlers.GET(get("missing.png"), params())).status).toBe(404);
    expect(
      (await handlers.GET(get("missing.png"), params("nope"))).status,
    ).toBe(404);
  });
});

describe("project image route handler", () => {
  let fx: PersistenceFixture;

  beforeEach(() => {
    fx = createPersistenceFixture();
    fx.seedProject(PROJECT_PATH);
  });

  afterEach(() => {
    fx.close();
  });

  function projectGet(path: string): Request {
    return new Request(
      `http://localhost/api/projects/${PROJECT_NAME}/worktree-images?path=${encodeURIComponent(path)}`,
    );
  }

  function projectParams(name = PROJECT_NAME) {
    return { params: Promise.resolve({ name }) };
  }

  it("serves an image from the project root", async () => {
    const { deps, readPaths } = depsFromFixture(fx, {
      [`${PROJECT_PATH}/.cc/temp/shot.png`]: PNG_BYTES,
    });
    const handlers = createWorktreeImageRouteHandlers(deps);

    const res = await handlers.projectGET(
      projectGet(".cc/temp/shot.png"),
      projectParams(),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG_BYTES);
    expect(readPaths).toEqual([`${PROJECT_PATH}/.cc/temp/shot.png`]);
  });

  it("refuses paths outside the project root without reading them", async () => {
    const { deps, readPaths } = depsFromFixture(fx, {
      "/etc/shot.png": PNG_BYTES,
    });
    const handlers = createWorktreeImageRouteHandlers(deps);

    for (const path of ["/etc/shot.png", "../shot.png"]) {
      const res = await handlers.projectGET(projectGet(path), projectParams());
      expect(res.status).toBe(404);
    }
    expect(readPaths).toEqual([]);
  });

  it("returns 404 for an unknown project", async () => {
    const { deps } = depsFromFixture(fx, {});
    const handlers = createWorktreeImageRouteHandlers(deps);

    const res = await handlers.projectGET(
      projectGet("shot.png"),
      projectParams("nope"),
    );

    expect(res.status).toBe(404);
  });
});
