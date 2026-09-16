import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodexInstructionState,
  createCodexInstructionStore,
} from "./instruction-state";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function fixture(conversationId = "conversation") {
  const dir = await mkdtemp(path.join(tmpdir(), "cc-instructions-"));
  dirs.push(dir);
  return { dir, store: createCodexInstructionStore(conversationId, dir) };
}
describe("Codex governing instruction state", () => {
  it("permits a later admitted attempt after a transient archive failure", async () => {
    const { store } = await fixture();
    let fail = true;
    const state = new CodexInstructionState({
      readLatest: store.readLatest,
      async write(record) {
        if (fail) {
          fail = false;
          throw new Error("temporary");
        }
        await store.write(record);
      },
    });
    await expect(
      state.establish("thread", "A", false, async () => {}),
    ).rejects.toThrow("temporary");
    const deliver = vi.fn(async () => {});
    await state.establish("thread", "A", false, deliver);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(await store.readLatest("thread")).toMatchObject({
      unresolved: false,
    });
  });
  it.each(["session-conversation", "project-conversation"])(
    "persists acknowledged state across %s restarts and skips only latest resolved hash",
    async (id) => {
      const { dir, store } = await fixture(id);
      const deliver = vi.fn(async () => {});
      await new CodexInstructionState(store).establish(
        "thread",
        "A",
        true,
        deliver,
      );
      const saved = await createCodexInstructionStore(id, dir).readLatest(
        "thread",
      );
      expect(saved).toMatchObject({
        threadRef: "thread",
        unresolved: false,
        version: 1,
      });
      await new CodexInstructionState(store).establish(
        "thread",
        "A",
        false,
        deliver,
      );
      expect(deliver).not.toHaveBeenCalled();
      for (const text of ["B", "A"])
        await new CodexInstructionState(store).establish(
          "thread",
          text,
          false,
          deliver,
        );
      expect(deliver.mock.calls).toHaveLength(2);
      expect((await store.readLatest("thread"))?.hash).toBe(saved?.hash);
    },
  );
  it("records unresolved before injection, then permits exactly one later reapplication after a lost acknowledgement", async () => {
    const { store } = await fixture();
    const state = new CodexInstructionState(store);
    await expect(
      state.establish("thread", "A", false, async () => {
        expect(await store.readLatest("thread")).toMatchObject({
          unresolved: true,
        });
        throw new Error("lost acknowledgement");
      }),
    ).rejects.toThrow("lost acknowledgement");
    const deliver = vi.fn(async () => {});
    await new CodexInstructionState(store).establish(
      "thread",
      "A",
      false,
      deliver,
    );
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(await store.readLatest("thread")).toMatchObject({
      unresolved: false,
    });
  });
  it("does not revive resolved A after unresolved B", async () => {
    const { store } = await fixture();
    await new CodexInstructionState(store).establish(
      "thread",
      "A",
      true,
      async () => {},
    );
    await expect(
      new CodexInstructionState(store).establish(
        "thread",
        "B",
        false,
        async () => {
          throw new Error("lost");
        },
      ),
    ).rejects.toThrow("lost");
    const deliver = vi.fn(async () => {});
    await new CodexInstructionState(store).establish(
      "thread",
      "A",
      false,
      deliver,
    );
    expect(deliver).toHaveBeenCalledTimes(1);
  });
  it("retains invalidation that races with injection acknowledgement", async () => {
    const { store } = await fixture();
    const state = new CodexInstructionState(store);
    await expect(
      state.establish("thread", "A", false, async () => {
        await state.invalidate();
      }),
    ).rejects.toThrow(/invalidat/i);
    expect(await store.readLatest("thread")).toMatchObject({
      unresolved: true,
    });
  });
  it("fails dispatch when required instruction persistence cannot be confirmed", async () => {
    const deliver = vi.fn(async () => {});
    const state = new CodexInstructionState({
      async readLatest() {
        return null;
      },
      async write() {
        throw new Error("archive unavailable");
      },
    });
    await expect(
      state.establish("thread", "A", false, deliver),
    ).rejects.toThrow("archive unavailable");
    expect(deliver).not.toHaveBeenCalled();
  });
});
