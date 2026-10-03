import type { ControlPermitsRepo } from "@/lib/state-store/control-permits-repo";
import type { ControlPermitRecord, PermitRef } from "./schemas";

/**
 * Authorization to start supervised effects. Every executor checks `admits`
 * inside its own admission critical section, so pause, cancellation and
 * invalidating amendments take effect at actual admission rather than at
 * submission. Callers compose these operations into their own transaction.
 */
export interface ControlPermits {
  /** Opens a permit; returns the current one when the controller already exists. */
  issue(input: {
    controllerId: string;
    parent: string | null;
    now: string;
  }): PermitRef;
  /** Pauses: nothing under this controller is admitted until reopen. */
  close(controllerId: string, now: string): void;
  /** Resumes under a new generation; requests carrying an older one stay refused. */
  reopen(controllerId: string, now: string): PermitRef;
  /** Cancels for good. */
  revoke(controllerId: string, now: string): void;
  current(controllerId: string): PermitRef | null;
  /** `null` marks an uncontrolled request, such as an interactive turn. */
  admits(permit: PermitRef | null): boolean;
}

export function createControlPermits(repo: ControlPermitsRepo): ControlPermits {
  function require(controllerId: string): ControlPermitRecord {
    const record = repo.get(controllerId);
    if (record === null) {
      throw new Error(`Unknown control permit: ${controllerId}`);
    }
    return record;
  }

  function chainOpen(record: ControlPermitRecord): boolean {
    if (record.state !== "open") return false;
    if (record.parentControllerId === null) return true;
    const parent = repo.get(record.parentControllerId);
    return parent !== null && chainOpen(parent);
  }

  return {
    issue({ controllerId, parent, now }) {
      const existing = repo.get(controllerId);
      if (existing !== null) {
        return { controllerId, generation: existing.generation };
      }
      if (parent !== null && repo.get(parent) === null) {
        throw new Error(
          `Cannot issue control permit ${controllerId}: unknown parent ${parent}`,
        );
      }
      repo.insert({
        controllerId,
        parentControllerId: parent,
        generation: 1,
        state: "open",
        updatedAt: now,
      });
      return { controllerId, generation: 1 };
    },
    close(controllerId, now) {
      const record = require(controllerId);
      if (record.state !== "open") return;
      repo.update(controllerId, {
        generation: record.generation,
        state: "closed",
        updatedAt: now,
      });
    },
    reopen(controllerId, now) {
      const record = require(controllerId);
      if (record.state === "revoked") {
        throw new Error(`Control permit ${controllerId} is revoked`);
      }
      const generation = record.generation + 1;
      repo.update(controllerId, { generation, state: "open", updatedAt: now });
      return { controllerId, generation };
    },
    revoke(controllerId, now) {
      const record = require(controllerId);
      if (record.state === "revoked") return;
      repo.update(controllerId, {
        generation: record.generation,
        state: "revoked",
        updatedAt: now,
      });
    },
    current(controllerId) {
      const record = repo.get(controllerId);
      return record === null
        ? null
        : { controllerId, generation: record.generation };
    },
    admits(permit) {
      if (permit === null) return true;
      const record = repo.get(permit.controllerId);
      return (
        record !== null &&
        record.generation === permit.generation &&
        chainOpen(record)
      );
    },
  };
}
