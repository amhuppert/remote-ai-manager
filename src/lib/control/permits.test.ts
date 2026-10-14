import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createControlPermitsRepo } from "@/lib/state-store/control-permits-repo";
import { createControlPermits, type ControlPermits } from "./permits";

const now = "2026-10-03T10:00:00.000Z";
let fixture: PersistenceFixture;
let permits: ControlPermits;

beforeEach(() => {
  fixture = createPersistenceFixture();
  permits = createControlPermits(createControlPermitsRepo(fixture.db));
});
afterEach(() => fixture.close());

describe("control permits", () => {
  it("admits an uncontrolled request", () => {
    expect(permits.admits(null)).toBe(true);
  });

  it("admits the current generation of an open permit and nothing unknown", () => {
    const permit = permits.issue({ controllerId: "run:1", parent: null, now });

    expect(permit).toEqual({ controllerId: "run:1", generation: 1 });
    expect(permits.admits(permit)).toBe(true);
    expect(permits.admits({ controllerId: "run:missing", generation: 1 })).toBe(
      false,
    );
  });

  it("stops admitting on close and admits only the new generation after reopen", () => {
    const first = permits.issue({ controllerId: "ctx:1", parent: null, now });

    permits.close("ctx:1", now);
    expect(permits.admits(first)).toBe(false);

    const second = permits.reopen("ctx:1", now);
    expect(second).toEqual({ controllerId: "ctx:1", generation: 2 });
    expect(permits.admits(second)).toBe(true);
    expect(permits.admits(first)).toBe(false);
  });

  it("never reopens a revoked permit", () => {
    const permit = permits.issue({ controllerId: "ctx:2", parent: null, now });

    permits.revoke("ctx:2", now);

    expect(permits.admits(permit)).toBe(false);
    expect(() => permits.reopen("ctx:2", now)).toThrow(/revoked/);
  });

  it("closes children with their parent without changing their generation", () => {
    permits.issue({ controllerId: "run:3", parent: null, now });
    const child = permits.issue({
      controllerId: "ctx:3",
      parent: "run:3",
      now,
    });

    permits.close("run:3", now);
    expect(permits.admits(child)).toBe(false);

    permits.reopen("run:3", now);
    expect(permits.admits(child)).toBe(true);
    expect(permits.current("ctx:3")).toEqual(child);
  });

  it("returns the existing permit when the same controller is issued again", () => {
    const first = permits.issue({ controllerId: "run:4", parent: null, now });
    permits.close("run:4", now);
    permits.reopen("run:4", now);

    expect(permits.issue({ controllerId: "run:4", parent: null, now })).toEqual(
      { controllerId: "run:4", generation: 2 },
    );
    expect(first.generation).toBe(1);
  });

  it("refuses to issue a child under an unknown parent", () => {
    expect(() =>
      permits.issue({ controllerId: "ctx:5", parent: "run:missing", now }),
    ).toThrow(/parent/);
  });
});
