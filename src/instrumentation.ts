/** Runs once when the Next.js server starts. The Node-only work lives in instrumentation-node.ts. */
export async function register(): Promise<void> {
  // The check must be written exactly like this so the bundler can drop the import from the edge build.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startupChecks } = await import("./instrumentation-node");
    startupChecks();
  }
}
