import { getRuntime } from "@/server/runtime";
import { SettingsView } from "./settings-view";

export const dynamic = "force-dynamic";

export default function SettingsPage() {
  const runtime = getRuntime();
  return (
    <SettingsView
      initial={{
        channels: runtime.channelService.list(),
        providerMode: runtime.config.providerMode,
        providerLabel: runtime.config.providerLabel,
      }}
      initialKits={runtime.brandKitRepo.list().map((kit) => ({
        id: kit.id,
        name: kit.name,
        themeId: kit.themeId,
        styleKeywords: JSON.parse(kit.styleKeywordsJson) as string[],
        negativeKeywords: JSON.parse(kit.negativeKeywordsJson) as string[],
        logoAssetId: kit.logoAssetId,
        builtIn: kit.builtIn === 1,
      }))}
    />
  );
}
