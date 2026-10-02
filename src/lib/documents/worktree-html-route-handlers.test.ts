import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createWorktreeHtmlRouteHandlers } from "./worktree-html-route-handlers";

const HTML =
  '<!doctype html><title>Report</title><h1>Résumé</h1><script>document.title="Interactive"</script>';

describe("worktree HTML serving", () => {
  let fx: PersistenceFixture;
  let directory: string;
  let projectRoot: string;
  let worktree: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "cc-html-"));
    projectRoot = join(directory, "project");
    worktree = join(projectRoot, ".worktrees", "sess");
    await mkdir(worktree, { recursive: true });
    fx = createPersistenceFixture();
    fx.seedProject(projectRoot);
    fx.seedSession(projectRoot, "sess", { worktreePath: worktree });
  });

  afterEach(async () => {
    fx.close();
    await rm(directory, { recursive: true, force: true });
  });

  function handlers() {
    return createWorktreeHtmlRouteHandlers({
      resolveProjectPath: async (name) =>
        name === "proj" ? projectRoot : null,
      getSession: fx.store.getSession,
    });
  }

  function request(path: string | null): Request {
    const url = new URL(
      "http://localhost/api/projects/proj/sessions/sess/worktree-html",
    );
    if (path !== null) url.searchParams.set("path", path);
    return new Request(url);
  }

  function params(name = "proj", session = "sess") {
    return { params: Promise.resolve({ name, session }) };
  }

  it("serves relative and absolute HTML files inline with isolated interactive scripts", async () => {
    await writeFile(join(worktree, "my report.HTML"), HTML);
    for (const path of ["my report.HTML", join(worktree, "my report.HTML")]) {
      const res = await handlers().GET(request(path), params());
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(HTML);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(res.headers.get("content-disposition")).toBe("inline");
      expect(res.headers.get("cache-control")).toBe("private, no-cache");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      const policy = res.headers.get("content-security-policy");
      expect(policy).toContain("sandbox allow-scripts");
      expect(policy).not.toContain("allow-same-origin");
      expect(policy).toContain("connect-src 'none'");
      expect(policy).toContain("form-action 'none'");
    }
  });

  it("serves htm reports from the project root for project conversations", async () => {
    await writeFile(join(projectRoot, "report.htm"), HTML);
    const res = await handlers().projectGET(request("report.htm"), params());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(HTML);
  });

  it("rejects missing paths and non-HTML files", async () => {
    for (const path of [null, "", ".env", "report.md", "report.html/secret"]) {
      expect((await handlers().GET(request(path), params())).status).toBe(400);
    }
  });

  it("returns 404 for missing files, directories, projects, and sessions", async () => {
    await mkdir(join(worktree, "directory.html"));
    for (const path of ["missing.html", "directory.html"]) {
      expect((await handlers().GET(request(path), params())).status).toBe(404);
    }
    expect(
      (await handlers().GET(request("report.html"), params("proj", "missing")))
        .status,
    ).toBe(404);
    expect(
      (await handlers().projectGET(request("report.html"), params("missing")))
        .status,
    ).toBe(404);
  });

  it("refuses traversal and symlink escapes from either owning root", async () => {
    const outside = join(directory, "outside.html");
    await writeFile(outside, "private");
    await symlink(outside, join(worktree, "escape.html"));
    await symlink(directory, join(worktree, "escape-dir"));
    for (const path of [
      outside,
      "../../../outside.html",
      "escape.html",
      "escape-dir/outside.html",
    ]) {
      expect((await handlers().GET(request(path), params())).status).toBe(404);
    }
    for (const path of [
      outside,
      "../outside.html",
      ".worktrees/sess/escape.html",
    ]) {
      expect(
        (await handlers().projectGET(request(path), params())).status,
      ).toBe(404);
    }
  });

  it("allows symlinks that resolve to HTML files within the owning root", async () => {
    await writeFile(join(worktree, "report.html"), HTML);
    await symlink(join(worktree, "report.html"), join(worktree, "linked.html"));
    const res = await handlers().GET(request("linked.html"), params());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(HTML);
  });
});
