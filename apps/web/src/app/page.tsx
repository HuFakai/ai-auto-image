import { getRuntime } from "@/server/runtime";
import { listRunItems } from "@/server/run-views";
import { Workbench } from "./workbench";
import type { BrandKitView, RunsListPayload } from "@/lib/types";

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
  const brandKits: BrandKitView[] = runtime.brandKitRepo.list().map((kit) => ({
    id: kit.id,
    name: kit.name,
    themeId: kit.themeId,
    styleKeywords: JSON.parse(kit.styleKeywordsJson) as string[],
    negativeKeywords: JSON.parse(kit.negativeKeywordsJson) as string[],
    logoAssetId: kit.logoAssetId,
    builtIn: kit.builtIn === 1,
  }));

  return <Workbench initial={initial} brandKits={brandKits} />;
}
