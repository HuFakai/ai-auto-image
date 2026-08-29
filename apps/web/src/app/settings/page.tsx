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
    />
  );
}
