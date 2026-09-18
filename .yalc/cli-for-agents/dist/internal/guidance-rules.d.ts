import type { EvaluatedGuidance, GuidanceRule, ReminderRule, ReminderRuleDefinition, SteeringDefinition, SteeringRule } from "../guidance/index.js";
/** Callback-bearing declarations are copied field by field; JSON cloning would drop
 * the callbacks and the command identities they reference. */
export declare function captureRecord(value: unknown): Record<string, unknown>;
export declare function captureArray(value: unknown): readonly unknown[];
export declare function checkGuidanceId(value: unknown): asserts value is string;
export declare function checkEvidence(value: unknown): asserts value is string;
export declare function checkPriority(value: unknown): asserts value is number;
export declare function makeReminderRule<State>(definition: ReminderRuleDefinition<State>): ReminderRule<State>;
export declare function makeSteering<State>(definition: SteeringDefinition<State>): SteeringRule<State>;
/** Rules come from defineReminderRule/defineSteering; a raw definition fails here clearly. */
export declare function checkRule(value: unknown): asserts value is GuidanceRule<unknown>;
/** The provider returns what evaluateGuidance produced; a wrong return fails here clearly. */
export declare function checkEvaluatedGuidance(value: unknown): EvaluatedGuidance;
//# sourceMappingURL=guidance-rules.d.ts.map