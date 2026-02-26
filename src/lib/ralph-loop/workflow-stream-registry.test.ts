import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  addClient,
  emit,
  closeAll,
  hasClients,
  _resetForTesting,
  type WorkflowStreamFrame,
} from "./workflow-stream-registry";

const PROJECT = "/home/user/my-project";
const SESSION = "feature-auth";

/** Create a mock ReadableStreamDefaultController */
function mockController(): ReadableStreamDefaultController & {
  enqueued: Uint8Array[];
  closed: boolean;
} {
  const ctrl = {
    enqueued: [] as Uint8Array[],
    closed: false,
    desiredSize: 1,
    enqueue: vi.fn((chunk: Uint8Array) => {
      ctrl.enqueued.push(chunk);
    }),
    close: vi.fn(() => {
      ctrl.closed = true;
    }),
    error: vi.fn(),
  };
  return ctrl as unknown as ReadableStreamDefaultController & {
    enqueued: Uint8Array[];
    closed: boolean;
  };
}

function decode(chunks: Uint8Array[]): WorkflowStreamFrame[] {
  const decoder = new TextDecoder();
  return chunks.map((chunk) => {
    const line = decoder.decode(chunk).trim();
    return JSON.parse(line) as WorkflowStreamFrame;
  });
}

describe("WorkflowStreamRegistry", () => {
  beforeEach(() => {
    _resetForTesting();
  });

  describe("hasClients", () => {
    it("returns false when no clients registered", () => {
      expect(hasClients(PROJECT, SESSION)).toBe(false);
    });

    it("returns true after a client is registered", () => {
      addClient(PROJECT, SESSION, mockController());
      expect(hasClients(PROJECT, SESSION)).toBe(true);
    });

    it("returns false after cleanup function is called", () => {
      const cleanup = addClient(PROJECT, SESSION, mockController());
      cleanup();
      expect(hasClients(PROJECT, SESSION)).toBe(false);
    });
  });

  describe("addClient / emit", () => {
    it("emits NDJSON frames to connected clients", () => {
      const ctrl = mockController();
      addClient(PROJECT, SESSION, ctrl);

      const frame: WorkflowStreamFrame = {
        type: "content",
        iterationNumber: 1,
        content: { type: "text", text: "hello" },
      };
      emit(PROJECT, SESSION, frame);

      expect(ctrl.enqueue).toHaveBeenCalledOnce();
      const decoded = decode(ctrl.enqueued);
      expect(decoded).toHaveLength(1);
      expect(decoded[0]).toEqual(frame);
    });

    it("emits to multiple connected clients", () => {
      const ctrl1 = mockController();
      const ctrl2 = mockController();
      addClient(PROJECT, SESSION, ctrl1);
      addClient(PROJECT, SESSION, ctrl2);

      const frame: WorkflowStreamFrame = {
        type: "iteration-boundary",
        iterationNumber: 2,
        status: "started",
      };
      emit(PROJECT, SESSION, frame);

      expect(ctrl1.enqueue).toHaveBeenCalledOnce();
      expect(ctrl2.enqueue).toHaveBeenCalledOnce();
    });

    it("does nothing when no clients are connected", () => {
      // Should not throw
      emit(PROJECT, SESSION, { type: "done", reason: "plan_complete" });
    });

    it("silently removes clients that throw on enqueue", () => {
      const badCtrl = mockController();
      (badCtrl.enqueue as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("stream closed");
      });
      const goodCtrl = mockController();

      addClient(PROJECT, SESSION, badCtrl);
      addClient(PROJECT, SESSION, goodCtrl);

      emit(PROJECT, SESSION, { type: "done", reason: "aborted" });

      // Good controller got the message, bad one was removed
      expect(goodCtrl.enqueue).toHaveBeenCalledOnce();
      // After the bad client is removed, only 1 client remains
      emit(PROJECT, SESSION, { type: "done", reason: "test" });
      expect(goodCtrl.enqueue).toHaveBeenCalledTimes(2);
      expect(badCtrl.enqueue).toHaveBeenCalledTimes(1); // only the first failed attempt
    });
  });

  describe("cleanup function", () => {
    it("removes only the specific client", () => {
      const ctrl1 = mockController();
      const ctrl2 = mockController();
      const cleanup1 = addClient(PROJECT, SESSION, ctrl1);
      addClient(PROJECT, SESSION, ctrl2);

      cleanup1();

      emit(PROJECT, SESSION, { type: "done", reason: "test" });
      expect(ctrl1.enqueue).not.toHaveBeenCalled();
      expect(ctrl2.enqueue).toHaveBeenCalledOnce();
    });

    it("is safe to call multiple times", () => {
      const ctrl = mockController();
      const cleanup = addClient(PROJECT, SESSION, ctrl);
      cleanup();
      expect(() => cleanup()).not.toThrow();
    });
  });

  describe("closeAll", () => {
    it("closes all connected clients", () => {
      const ctrl1 = mockController();
      const ctrl2 = mockController();
      addClient(PROJECT, SESSION, ctrl1);
      addClient(PROJECT, SESSION, ctrl2);

      closeAll(PROJECT, SESSION);

      expect(ctrl1.close).toHaveBeenCalledOnce();
      expect(ctrl2.close).toHaveBeenCalledOnce();
      expect(hasClients(PROJECT, SESSION)).toBe(false);
    });

    it("is a no-op for non-existent workflow", () => {
      expect(() => closeAll(PROJECT, SESSION)).not.toThrow();
    });

    it("handles controllers that throw on close", () => {
      const ctrl = mockController();
      (ctrl.close as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("already closed");
      });
      addClient(PROJECT, SESSION, ctrl);

      expect(() => closeAll(PROJECT, SESSION)).not.toThrow();
    });
  });

  describe("workflow isolation", () => {
    it("different workflows are independent", () => {
      const ctrl1 = mockController();
      const ctrl2 = mockController();
      addClient(PROJECT, "session-a", ctrl1);
      addClient(PROJECT, "session-b", ctrl2);

      emit(PROJECT, "session-a", { type: "done", reason: "test" });
      expect(ctrl1.enqueue).toHaveBeenCalledOnce();
      expect(ctrl2.enqueue).not.toHaveBeenCalled();
    });
  });
});
