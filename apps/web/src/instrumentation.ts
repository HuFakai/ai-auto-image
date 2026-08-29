export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startRuntimeRunner } = await import("./server/runtime");
    startRuntimeRunner();
    console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", msg: "in-process job runner started via instrumentation" }));
  }
}
