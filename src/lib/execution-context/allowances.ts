import type { AllowanceKind, ContextFacts } from "./schemas";

export function remainingAllowance(
  facts: ContextFacts,
  kind: AllowanceKind,
): number {
  const budget = facts.policy[kind] + facts.allowances.granted[kind];
  const used = facts.allowances.charges.filter((c) => c.kind === kind).length;
  return budget - used;
}

/** Whether the allowance can still pay for a turn: unspent, or reserved by one in flight. */
export function allowanceAvailable(facts: ContextFacts, kind: AllowanceKind): boolean {
  return (
    remainingAllowance(facts, kind) > 0 ||
    facts.allowances.charges.some((c) => c.kind === kind && c.state === "reserved")
  );
}

/** Reserved with the work order's intent; one reservation per cause. */
export function reserveAllowance(
  facts: ContextFacts,
  kind: AllowanceKind,
  cause: string,
): ContextFacts {
  if (facts.allowances.charges.some((c) => c.cause === cause)) return facts;
  return {
    ...facts,
    allowances: {
      ...facts.allowances,
      charges: [
        ...facts.allowances.charges,
        { cause, kind, state: "reserved" },
      ],
    },
  };
}

/** An admitted work turn stays charged whatever its outcome. */
export function chargeAllowance(
  facts: ContextFacts,
  cause: string,
): ContextFacts {
  return {
    ...facts,
    allowances: {
      ...facts.allowances,
      charges: facts.allowances.charges.map((c) =>
        c.cause === cause ? { ...c, state: "charged" } : c,
      ),
    },
  };
}

/** A reservation withdrawn before admission is returned. */
export function releaseAllowance(
  facts: ContextFacts,
  cause: string,
): ContextFacts {
  return {
    ...facts,
    allowances: {
      ...facts.allowances,
      charges: facts.allowances.charges.filter(
        (c) => !(c.cause === cause && c.state === "reserved"),
      ),
    },
  };
}

export function grantAllowance(
  facts: ContextFacts,
  kind: AllowanceKind,
  count: number,
): ContextFacts {
  return {
    ...facts,
    allowances: {
      ...facts.allowances,
      granted: {
        ...facts.allowances.granted,
        [kind]: facts.allowances.granted[kind] + count,
      },
    },
  };
}
