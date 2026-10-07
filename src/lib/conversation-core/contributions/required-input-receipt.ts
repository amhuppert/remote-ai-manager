/** Required acceptance failures survive execution until settlement can retain them. */
export function createRequiredInputReceipt(record: () => Promise<void>) {
  let acceptance: Promise<void> | undefined;
  let failureReported = false;
  function accept(): Promise<void> {
    acceptance ??= Promise.resolve().then(record);
    return acceptance;
  }
  return {
    onInputAccepted: accept,
    async finish() {
      if (!acceptance) return;
      try {
        await acceptance;
      } catch (error) {
        if (!failureReported) {
          failureReported = true;
          throw error;
        }
        acceptance = undefined;
        await accept();
      }
    },
  };
}
