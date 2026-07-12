import type { QueryClient } from "@tanstack/react-query";

import { ticketKeys } from "./query-keys";

interface TicketMutationGate {
  projectName: string;
  number: number;
  tail: Promise<void>;
  holders: number;
}

interface TicketIdentity {
  projectName: string;
  number: number;
}

interface TicketMutationScope {
  projectName: string;
  number?: number;
}

interface QueuedTicketInvalidations {
  lists: boolean;
  details: Map<string, TicketIdentity>;
}

const mutationGates = new WeakMap<
  QueryClient,
  Map<string, TicketMutationGate>
>();
const queuedInvalidations = new WeakMap<
  QueryClient,
  QueuedTicketInvalidations
>();

function ticketIdentityKey(projectName: string, number: number): string {
  return JSON.stringify([projectName, number]);
}

async function waitForPromisesOrAbort(
  promises: Promise<void>[],
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal === undefined) {
    await Promise.all(promises);
    return;
  }
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    void Promise.all(promises).then(
      () => {
        cleanup();
        resolve();
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

export async function waitForTicketMutations(
  queryClient: QueryClient,
  scope?: TicketMutationScope,
  signal?: AbortSignal,
): Promise<void> {
  for (;;) {
    const clientGates = mutationGates.get(queryClient);
    const gates = (() => {
      if (scope === undefined) return [...(clientGates?.values() ?? [])];
      if (scope.number !== undefined) {
        return [
          clientGates?.get(ticketIdentityKey(scope.projectName, scope.number)),
        ];
      }
      return [...(clientGates?.values() ?? [])].filter(
        (gate) => gate.projectName === scope.projectName,
      );
    })();
    const tails = gates.flatMap((gate) => (gate ? [gate.tail] : []));
    if (tails.length === 0) return;
    await waitForPromisesOrAbort(tails, signal);
  }
}

export async function acquireTicketMutationGate(
  queryClient: QueryClient,
  projectName: string,
  number: number,
): Promise<() => void> {
  let clientGates = mutationGates.get(queryClient);
  if (!clientGates) {
    clientGates = new Map();
    mutationGates.set(queryClient, clientGates);
  }

  const key = ticketIdentityKey(projectName, number);
  let gate = clientGates.get(key);
  if (!gate) {
    gate = {
      projectName,
      number,
      tail: Promise.resolve(),
      holders: 0,
    };
    clientGates.set(key, gate);
  }

  const predecessor = gate.tail;
  let unlock = (): void => {};
  const turn = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  gate.tail = predecessor.then(() => turn);
  gate.holders += 1;
  await predecessor;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    gate.holders -= 1;
    unlock();
    if (gate.holders === 0) {
      clientGates.delete(key);
      if (clientGates.size === 0) mutationGates.delete(queryClient);
    }
    flushTicketInvalidations(queryClient);
  };
}

export interface TicketCacheInvalidationRequest {
  includeLists: boolean;
  details?: Iterable<TicketIdentity>;
}

export function scheduleTicketCacheInvalidation(
  queryClient: QueryClient,
  request: TicketCacheInvalidationRequest,
): void {
  let queued = queuedInvalidations.get(queryClient);
  if (!queued) {
    queued = { lists: false, details: new Map() };
    queuedInvalidations.set(queryClient, queued);
  }
  if (request.includeLists) queued.lists = true;
  for (const identity of request.details ?? []) {
    queued.details.set(
      ticketIdentityKey(identity.projectName, identity.number),
      identity,
    );
  }
  flushTicketInvalidations(queryClient);
}

function flushTicketInvalidations(queryClient: QueryClient): void {
  const queued = queuedInvalidations.get(queryClient);
  if (!queued) return;
  const clientGates = mutationGates.get(queryClient);

  for (const [key, identity] of queued.details) {
    if (clientGates?.has(key)) continue;
    queued.details.delete(key);
    void queryClient.invalidateQueries({
      queryKey: ticketKeys.detail(identity.projectName, identity.number),
    });
  }

  if (queued.lists && (!clientGates || clientGates.size === 0)) {
    queued.lists = false;
    void queryClient.invalidateQueries({ queryKey: ticketKeys.lists() });
  }

  if (!queued.lists && queued.details.size === 0) {
    queuedInvalidations.delete(queryClient);
  }
}

export async function cancelTicketQueries(
  queryClient: QueryClient,
  projectName: string,
  number: number,
): Promise<void> {
  await Promise.all([
    queryClient.cancelQueries({ queryKey: ticketKeys.lists() }),
    queryClient.cancelQueries({
      queryKey: ticketKeys.detail(projectName, number),
    }),
  ]);
}

export async function beginTicketMutation(
  queryClient: QueryClient,
  projectName: string,
  number: number,
): Promise<() => void> {
  const releaseGate = await acquireTicketMutationGate(
    queryClient,
    projectName,
    number,
  );
  try {
    await cancelTicketQueries(queryClient, projectName, number);
    return releaseGate;
  } catch (error) {
    releaseGate();
    throw error;
  }
}

export function settleTicketMutation(
  queryClient: QueryClient,
  projectName: string,
  number: number,
  releaseGate: (() => void) | undefined,
  includeLists: boolean,
): void {
  scheduleTicketCacheInvalidation(queryClient, {
    includeLists,
    details: [{ projectName, number }],
  });
  releaseGate?.();
}
