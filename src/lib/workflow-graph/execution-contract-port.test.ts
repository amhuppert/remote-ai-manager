import { describe, expect, it } from "vitest";
import {
  assertGraphExecutionContractAccepted,
  GraphExecutionContractViolationError,
} from "./execution-contract-port";

describe("graph execution contract decisions", () => {
  it("preserves policy refusal evidence for route consumers", () => {
    const refusal = {
      ok: false as const,
      code: "contract_refused",
      issues: [{ code: "contract-refused", message: "Missing coverage." }],
      instruction: "Restore coverage.",
    };
    expect(() => assertGraphExecutionContractAccepted(refusal)).toThrow(
      GraphExecutionContractViolationError,
    );
    try {
      assertGraphExecutionContractAccepted(refusal);
    } catch (error) {
      expect(error).toMatchObject({
        code: refusal.code,
        issues: refusal.issues,
        instruction: refusal.instruction,
        message: "Missing coverage.",
      });
    }
    expect(() =>
      assertGraphExecutionContractAccepted({ ok: true }),
    ).not.toThrow();
  });
});
