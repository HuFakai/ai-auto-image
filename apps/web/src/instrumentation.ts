import { toBeijingIsoString } from "@aai/shared-schemas";

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startRuntimeRunner } = await import("./server/runtime");
    await startRuntimeRunner();
    console.log(JSON.stringify({ ts: toBeijingIsoString(), level: "info", msg: "in-process job runner started via instrumentation" }));
  }
}
