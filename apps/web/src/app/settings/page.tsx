import { redirect } from "next/navigation";
import { requireAdmin } from "@/server/auth";
import { getRuntime } from "@/server/runtime";
import { SettingsView } from "./settings-view";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const admin = await requireAdmin();
  if (!admin) redirect("/");
  const runtime = await getRuntime();
  return (
    <SettingsView
      initial={{
        channels: await runtime.channelService.list(),
        providerMode: runtime.config.providerMode,
        providerLabel: runtime.config.providerLabel,
      }}
      initialKits={(await runtime.brandKitRepo.list()).map((kit) => ({
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
