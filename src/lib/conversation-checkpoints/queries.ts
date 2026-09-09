/**
 * Client reads over the scoped checkpoint routes (design §8).
 *
 * Progress is a QUERY, never a retained mutation result: an operation outlives
 * the component that started it, so the panel recovers `building`, `retiring`,
 * `ready`, `applied`, a failure or a reconciliation gate by reading the
 * server's receipt after a remount, a panel close, or an SSE reconnect. The
 * start mutation only seeds these caches.
 *
 * The seed is a separate hook behind a separate key because it is the one
 * explicit disclosure: a surface that renders receipts never pulls payload
 * text into its cache by observing the same query.
 */

import {
  useQueries,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { z } from "zod";

import { apiFetch } from "@/lib/api/fetcher";
import { conversationTargetApiBase } from "@/lib/conversations/conversation-target";

import { checkpointRefusalSchema } from "./admission";
import {
  checkpointKeys,
  type CheckpointListOptions,
  type CheckpointTarget,
} from "./query-keys";
import {
  checkpointReceiptSchema,
  receiptSupersedes,
  type CheckpointReceipt,
} from "./receipt";
import { checkpointPayloadSchema } from "./schemas";
import { foldReceiptIntoPage } from "./sse-cache";

/**
 * How many receipts a conversation surface reads by default. The chip and the
 * panel header need the newest operation; the panel's history shows the recent
 * ones and reads further back on request. It lives in the domain because the
 * composer's maintenance read must key the SAME page the surfaces observe.
 */
export const CHECKPOINT_RECENT_LIMIT = 5;

export const checkpointEligibilityResponseSchema = z.object({
  eligible: z.boolean(),
  /** Every failing predicate, primary first; empty when eligible. */
  refusals: z.array(checkpointRefusalSchema),
  /** The operation holding the conversation's checkpoint slot, when one does. */
  active: checkpointReceiptSchema.nullable(),
  hosted: z.boolean(),
});
export type CheckpointEligibility = z.infer<
  typeof checkpointEligibilityResponseSchema
>;

export const checkpointListResponseSchema = z.object({
  /** Descending by ordinal — the newest operation leads every page. */
  receipts: z.array(checkpointReceiptSchema),
  nextBefore: z.number().int().positive().nullable(),
});
export type CheckpointListPage = z.infer<typeof checkpointListResponseSchema>;

export const checkpointDetailResponseSchema = z.object({
  receipt: checkpointReceiptSchema,
});
export type CheckpointDetail = z.infer<typeof checkpointDetailResponseSchema>;

export const checkpointSeedResponseSchema = z.object({
  receipt: checkpointReceiptSchema,
  /** Null while the operation has frozen no payload. */
  seed: checkpointPayloadSchema.nullable(),
});
export type CheckpointSeed = z.infer<typeof checkpointSeedResponseSchema>;

export function checkpointsBaseUrl(target: CheckpointTarget): string {
  return `${conversationTargetApiBase(target)}/checkpoints`;
}

export function checkpointUrl(
  target: CheckpointTarget,
  operationId: string,
): string {
  return `${checkpointsBaseUrl(target)}/${encodeURIComponent(operationId)}`;
}

function listUrl(
  target: CheckpointTarget,
  options: CheckpointListOptions,
): string {
  const params = new URLSearchParams();
  if (options.before !== undefined)
    params.set("before", String(options.before));
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  const query = params.toString();
  return query === ""
    ? checkpointsBaseUrl(target)
    : `${checkpointsBaseUrl(target)}?${query}`;
}

/**
 * Reconcile one receipt a GET just returned against the newest one this client
 * already knows about.
 *
 * The detail cache is the per-operation freshness ledger: every SSE frame and
 * every mutation response writes it unconditionally, including while a list
 * read is still in flight and has no page to fold into. A GET that started
 * before an event and finished after it therefore carries the OLDER phase, and
 * without this it would put `building` back over a `ready` the server has
 * already published. Whichever receipt is newer by its own `updatedAt` wins,
 * and the ledger keeps it.
 */
function reconcileWithLedger(
  queryClient: QueryClient,
  target: CheckpointTarget,
  incoming: CheckpointReceipt,
): CheckpointReceipt {
  const key = checkpointKeys.detail(target, incoming.operationId);
  const cached = queryClient.getQueryData<CheckpointDetail>(key);
  if (cached !== undefined && !receiptSupersedes(incoming, cached.receipt)) {
    return cached.receipt;
  }
  queryClient.setQueryData<CheckpointDetail>(key, { receipt: incoming });
  return incoming;
}

/** Every per-operation receipt this client currently holds for one target. */
function ledgerReceipts(
  queryClient: QueryClient,
  target: CheckpointTarget,
): CheckpointReceipt[] {
  return queryClient
    .getQueriesData<CheckpointDetail>({
      queryKey: checkpointKeys.details(target),
    })
    .flatMap(([, cached]) => (cached === undefined ? [] : [cached.receipt]));
}

/**
 * Read one page and reconcile it against the ledger — by phase AND by
 * membership.
 *
 * Freshness alone leaves a hole: a read that left the server before an
 * operation was admitted comes back describing a world without it, and
 * reconciling only the rows it happens to contain would publish a page missing
 * an operation this client has already been told about. The chip and the
 * composer read the head of that page, so the hold would silently vanish until
 * some later event restored it.
 *
 * Merging uses the SSE fold, so the rule about what may join a page has one
 * owner: an operation joins only at the head of an uncursored page, only when
 * it is genuinely newer than everything there, and evicting the tail moves the
 * cursor rather than losing the row.
 */
async function readListPage(
  queryClient: QueryClient,
  target: CheckpointTarget,
  listOptions: CheckpointListOptions,
): Promise<CheckpointListPage> {
  const page = await apiFetch(
    listUrl(target, listOptions),
    checkpointListResponseSchema,
  );
  const reconciled: CheckpointListPage = {
    ...page,
    receipts: page.receipts.map((receipt) =>
      reconcileWithLedger(queryClient, target, receipt),
    ),
  };
  const cursored = listOptions.before !== undefined;
  if (cursored) return reconciled;

  const present = new Set(reconciled.receipts.map((r) => r.operationId));
  // Ascending, so each fold prepends onto a head that is still older than it
  // and the page ends up descending by ordinal.
  const missing = ledgerReceipts(queryClient, target)
    .filter((receipt) => !present.has(receipt.operationId))
    .sort((a, b) => a.ordinal - b.ordinal);
  return missing.reduce(
    (carried, receipt) =>
      foldReceiptIntoPage(carried, receipt, {
        cursored: false,
        limit: listOptions.limit ?? null,
      }),
    reconciled,
  );
}

/**
 * Whether a conversation can be checkpointed right now, and why not when it
 * cannot. Read-only on the server: it starts no actor and reserves nothing, so
 * a menu may observe it continuously.
 */
export function useCheckpointEligibility(
  target: CheckpointTarget,
  options?: { enabled?: boolean; staleTime?: number },
) {
  return useQuery({
    queryKey: checkpointKeys.eligibility(target),
    queryFn: () =>
      apiFetch(
        `${checkpointsBaseUrl(target)}/eligibility`,
        checkpointEligibilityResponseSchema,
      ),
    enabled: options?.enabled ?? true,
    ...(options?.staleTime === undefined
      ? {}
      : { staleTime: options.staleTime }),
  });
}

/**
 * One page of the conversation's receipt index. `{ limit: 1 }` is the durable
 * pointer at the newest operation — the read a chip or panel makes after a
 * remount to recover progress it never held in component state.
 */
export function useCheckpointList(
  target: CheckpointTarget,
  listOptions: CheckpointListOptions = {},
  options?: { enabled?: boolean; staleTime?: number },
) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: checkpointKeys.list(target, listOptions),
    queryFn: () => readListPage(queryClient, target, listOptions),
    enabled: options?.enabled ?? true,
    ...(options?.staleTime === undefined
      ? {}
      : { staleTime: options.staleTime }),
  });
}

/**
 * The older pages a reader has asked for, each addressed by the `before`
 * cursor the page ahead of it reported.
 *
 * Deliberately separate from the newest page rather than one growing limit:
 * the newest page is the authoritative read the chip and the COMPOSER observe,
 * and it has to keep its key — and its refetching — no matter how far back the
 * panel's history has been paged. Cursors also carry past the server's page
 * cap, which a widening limit cannot.
 */
export function useCheckpointListPages(
  target: CheckpointTarget,
  cursors: readonly number[],
  options?: { enabled?: boolean },
) {
  const queryClient = useQueryClient();
  return useQueries({
    queries: cursors.map((before) => {
      const listOptions: CheckpointListOptions = {
        before,
        limit: CHECKPOINT_RECENT_LIMIT,
      };
      return {
        queryKey: checkpointKeys.list(target, listOptions),
        queryFn: () => readListPage(queryClient, target, listOptions),
        enabled: options?.enabled ?? true,
      };
    }),
  });
}

export function useCheckpointOperation(
  target: CheckpointTarget,
  operationId: string,
  options?: { enabled?: boolean },
) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: checkpointKeys.detail(target, operationId),
    queryFn: async () => {
      const detail = await apiFetch(
        checkpointUrl(target, operationId),
        checkpointDetailResponseSchema,
      );
      return {
        receipt: reconcileWithLedger(queryClient, target, detail.receipt),
      } satisfies CheckpointDetail;
    },
    enabled: (options?.enabled ?? true) && operationId !== "",
  });
}

/**
 * The exact saved seed. Enabled only where a user explicitly asked to read it,
 * so opening a checkpoint receipt never fetches payload text.
 */
export function useCheckpointSeedQuery(
  target: CheckpointTarget,
  operationId: string,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: checkpointKeys.seed(target, operationId),
    queryFn: () =>
      apiFetch(
        `${checkpointUrl(target, operationId)}?detail=seed`,
        checkpointSeedResponseSchema,
      ),
    enabled: (options?.enabled ?? false) && operationId !== "",
  });
}
