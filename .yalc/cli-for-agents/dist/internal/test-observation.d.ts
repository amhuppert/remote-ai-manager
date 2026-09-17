import type { AnyEnvelope } from "../results.js";
import type { TestEvent } from "../testing/index.js";
/** Request-local instrumentation. No callbacks run in production; concurrent tests
 * cannot intercept each other's events or mutate the response being delivered. */
export type Observation = {
    readonly events: TestEvent[];
    envelope?: AnyEnvelope;
};
export declare function observeRun(signal: AbortSignal, observation: Observation): () => void;
export declare function recordTestEvent(signal: AbortSignal, event: TestEvent): void;
export declare function recordTestDelivery(signal: AbortSignal, envelope: AnyEnvelope): void;
//# sourceMappingURL=test-observation.d.ts.map