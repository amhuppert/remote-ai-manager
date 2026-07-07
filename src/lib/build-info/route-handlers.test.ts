import { describe, expect, it } from "vitest";

import {
  createVersionRouteHandlers,
  type VersionRouteDeps,
} from "./route-handlers";

function createTestDeps(): VersionRouteDeps {
  return {
    getBuildInfo: () => ({
      sha: "abc1234",
      buildTime: "2026-07-02T10:00:00.000Z",
    }),
  };
}

describe("GET /api/version", () => {
  it("returns 200 with the build's commit SHA, build time, and stamp", async () => {
    const handlers = createVersionRouteHandlers(createTestDeps());

    const response = await handlers.GET();
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toEqual({
      sha: "abc1234",
      buildTime: "2026-07-02T10:00:00.000Z",
      stamp: "abc1234-2026-07-02T10:00:00.000Z",
    });
  });

  it("serializes as application/json", async () => {
    const handlers = createVersionRouteHandlers(createTestDeps());

    const response = await handlers.GET();
    expect(response.headers.get("content-type")).toMatch(/application\/json/);
  });
});
