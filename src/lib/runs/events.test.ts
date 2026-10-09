import { describe, expect, it } from "vitest";
import type { SSEEvent } from "@/lib/api/sse-events";
import { createRunChangePublisher } from "./events";

const silent = { info: () => {}, warn: () => {}, error: () => {} };

describe("run change publication", () => {
  it("publishes one frame per run for all its changes within a window", () => {
    const published: SSEEvent[] = [];
    let due: Array<() => void> = [];
    const publisher = createRunChangePublisher({
      publish(event) {
        published.push(event);
        return { delivered: true };
      },
      logger: silent,
      defer(flush) {
        due.push(flush);
      },
    });
    const run = (runId: string) => ({
      runId,
      projectPath: "/Users/alex/projects/plc-test-lab",
      sessionName: "fx-run-page",
    });

    publisher.changed(run("run-1"));
    publisher.changed(run("run-1"));
    publisher.changed(run("run-2"));
    expect(published).toEqual([]);
    const flushes = due;
    due = [];
    for (const flush of flushes) flush();

    expect(published).toEqual([
      {
        type: "run-changed",
        projectName: "plc-test-lab",
        sessionName: "fx-run-page",
        runId: "run-1",
      },
      {
        type: "run-changed",
        projectName: "plc-test-lab",
        sessionName: "fx-run-page",
        runId: "run-2",
      },
    ]);
    publisher.changed(run("run-1"));
    expect(due).toHaveLength(1);
  });
});
