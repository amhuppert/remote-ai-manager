/**
 * Concurrency regression tests for the conversation-scoped single-flight lock.
 *
 * These tests pin the behavior the workflow/conversation unification work
 * (see memory-bank/unify-workflow-conversations-design.md, F-points) must
 * preserve:
 *
 *   1. Different conversations in the same session never block each other.
 *   2. Two turns targeting the *same* conversation never hold the lock
 *      concurrently — the second turn's start is observed at/after the
 *      first's release.
 *   3. While a conversation is "paused" mid-turn (the closest available
 *      abstraction today is "lock held without releasing"), no foreign
 *      caller can slip in and acquire the same lock; only the original
 *      holder's release closure ends the hold.
 *
 * Exercises the real `createLockManager()` primitive (no mocking).
 * Each test gets its own isolated LockManager instance so concurrent
 * vitest runs cannot cross-talk.
 */

import { describe, it, expect } from "vitest";
import { createLockManager } from "@/lib/prompt/single-flight";
import type { Logger } from "@/lib/logging";

const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => silentLogger,
} as unknown as Logger;

const project = "/tmp/parity-project";
const session = "parity-session";

describe("conversation lock — concurrency parity", () => {
  it("cross-conversation: a long-running turn in conversation A does not block a prompt in conversation B", () => {
    const locks = createLockManager(silentLogger);

    const releaseA = locks.acquireConversationLock(project, session, "conv-A");
    expect(locks.isConversationBusy(project, session, "conv-A")).toBe(true);

    // Conversation B's acquisition must succeed immediately while A holds
    // its lock — the lock is conversation-scoped, not session-scoped.
    let releaseB: (() => void) | undefined;
    expect(() => {
      releaseB = locks.acquireConversationLock(project, session, "conv-B");
    }).not.toThrow();
    expect(locks.isConversationBusy(project, session, "conv-B")).toBe(true);

    // Releasing A leaves B's lock untouched.
    releaseA();
    expect(locks.isConversationBusy(project, session, "conv-A")).toBe(false);
    expect(locks.isConversationBusy(project, session, "conv-B")).toBe(true);

    releaseB?.();
    expect(locks.isConversationBusy(project, session, "conv-B")).toBe(false);
  });

  it("same-conversation: the second simultaneous acquisition is rejected while the first holds the lock (current reject-on-contention semantics)", () => {
    // TODO(unify-workflow-conversations F8): The acceptance criterion for
    // this test is "two simultaneous workflow-driven turns targeting the
    // same conversationId serialize via acquireConversationLock — the
    // second turn must wait until the first releases the lock". The
    // current production primitive does NOT implement queue-and-wait —
    // it rejects synchronously on contention (see
    // src/lib/prompt/single-flight.ts:148). Workflow-driven turns
    // therefore do not actually serialize through the lock today; a
    // concurrent submission to the same conversation surfaces the
    // "Conversation is busy" error to the caller instead of waiting.
    //
    // Per the task instructions ("Tests pass against current code; any
    // case that exposes a pre-existing behavior gap is documented as a
    // comment in the test rather than failed"), this test pins the
    // *current* behavior — synchronous rejection — and records the
    // serialization gap here. F8 of
    // memory-bank/unify-workflow-conversations-design.md is expected to
    // introduce queue-and-wait semantics at the primitive (or a wrapper
    // submission path on the conversation manager); when it lands,
    // replace this assertion with the timing-based serialization check
    // (second turn's startedAt >= first turn's releasedAt), driven by
    // the real submission path through the conversation manager.
    const locks = createLockManager(silentLogger);

    const releaseFirst = locks.acquireConversationLock(
      project,
      session,
      "conv-shared",
    );
    expect(locks.isConversationBusy(project, session, "conv-shared")).toBe(
      true,
    );

    expect(() =>
      locks.acquireConversationLock(project, session, "conv-shared"),
    ).toThrow(/Conversation is busy/);

    releaseFirst();
    expect(locks.isConversationBusy(project, session, "conv-shared")).toBe(
      false,
    );

    // After release, a fresh acquisition succeeds — establishing that
    // the rejection above was contention-driven, not a permanent fault.
    const releaseSecond = locks.acquireConversationLock(
      project,
      session,
      "conv-shared",
    );
    expect(releaseSecond).not.toBe(releaseFirst);
    releaseSecond();
  });

  it("pause-resume: the lock holder identity is preserved across a simulated pause — no foreign holder can slip in", () => {
    // TODO(unify-workflow-conversations F8): the codebase has no native
    // pause/resume primitive for conversation turns today. The closest
    // available abstraction is "hold the lock across the pause interval";
    // the invariant we pin here — only the original release closure can
    // end the hold, and no foreign caller can acquire during the gap —
    // is what F8's pause/resume support must preserve.
    const locks = createLockManager(silentLogger);

    const releaseOriginal = locks.acquireConversationLock(
      project,
      session,
      "conv-paused",
    );
    expect(locks.isConversationBusy(project, session, "conv-paused")).toBe(
      true,
    );

    // During the "paused" interval no foreign holder may acquire the same
    // lock — the holder identity is preserved across the gap.
    expect(() =>
      locks.acquireConversationLock(project, session, "conv-paused"),
    ).toThrow(/Conversation is busy/);

    // Other conversations in the same session are unaffected by the pause.
    const releaseOther = locks.acquireConversationLock(
      project,
      session,
      "conv-other",
    );
    expect(locks.isConversationBusy(project, session, "conv-other")).toBe(true);
    releaseOther();

    // Still held by the original holder after the unrelated traffic.
    expect(locks.isConversationBusy(project, session, "conv-paused")).toBe(
      true,
    );

    // "Resume" — only the original release closure ends the hold.
    releaseOriginal();
    expect(locks.isConversationBusy(project, session, "conv-paused")).toBe(
      false,
    );

    // After resume, the next turn may take a fresh lock. Its release
    // closure is a *new* identity — it cannot be the paused turn's
    // closure smuggled in by a third party.
    const releaseNext = locks.acquireConversationLock(
      project,
      session,
      "conv-paused",
    );
    expect(releaseNext).not.toBe(releaseOriginal);
    releaseNext();
  });
});
