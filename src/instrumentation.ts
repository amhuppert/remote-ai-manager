export async function register(): Promise<void> {
  if (process.env["NEXT_RUNTIME"] === "nodejs") {
    const { register: nodeRegister } = await import("./instrumentation.node");
    await nodeRegister();
  }
}
