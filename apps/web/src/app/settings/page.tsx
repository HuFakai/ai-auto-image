import { redirect } from "next/navigation";
import { requireAdmin } from "@/server/auth";
import { getRuntime } from "@/server/runtime";
import { toBrandKitView } from "@/server/brand-kit-views";
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
      initialKits={(await runtime.brandKitRepo.list()).map(toBrandKitView)}
    />
  );
}
