const observations = new WeakMap();
export function observeRun(signal, observation) {
    observations.set(signal, observation);
    return () => { observations.delete(signal); };
}
export function recordTestEvent(signal, event) {
    observations.get(signal)?.events.push(Object.freeze(event));
}
export function recordTestDelivery(signal, envelope) {
    const observation = observations.get(signal);
    if (observation)
        observation.envelope = envelope;
}
//# sourceMappingURL=test-observation.js.map