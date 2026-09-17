import type { GuidanceRule, ReminderRule, ReminderRuleDefinition, SteeringDefinition, SteeringRule } from "../guidance/index.js";
/** Callback-bearing declarations need descriptor capture without JSON cloning identities. */
export declare function captureRecord(value: unknown): Record<string, unknown>;
export declare function captureArray(value: unknown): readonly unknown[];
export declare function checkGuidanceId(value: unknown): asserts value is string;
export declare function checkEvidence(value: unknown): asserts value is string;
export declare function checkPriority(value: unknown): asserts value is number;
export declare function makeReminderRule<State>(definition: ReminderRuleDefinition<State>): ReminderRule<State>;
export declare function makeSteering<State>(definition: SteeringDefinition<State>): SteeringRule<State>;
export declare function checkRule(value: unknown): asserts value is GuidanceRule<unknown>;
export declare function retainEvaluationRules(batch: object, rules: readonly GuidanceRule<unknown>[]): void;
export declare function evaluatedRules(batch: unknown): readonly GuidanceRule<unknown>[];
//# sourceMappingURL=guidance-rules.d.ts.map