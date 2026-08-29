import { getRuntime } from "@/server/runtime";
import { listRunItems } from "@/server/run-views";
import { Workbench } from "./workbench";
import type { RunsListPayload } from "@/lib/types";

export const dynamic = "force-dynamic";

export default function HomePage() {
  const runtime = getRuntime();
  const initial: RunsListPayload = {
    runs: listRunItems(runtime, 20),
    providerLabel: runtime.config.providerLabel,
    providerMode: runtime.config.providerMode,
    serverMaxConcurrency: runtime.config.serverMaxConcurrency,
    defaultConcurrency: runtime.config.defaultConcurrency,
  };

  return <Workbench initial={initial} />;
}
