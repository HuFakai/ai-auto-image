import { getRuntime } from "@/server/runtime";
import { ChannelsView } from "./channels-view";

export const dynamic = "force-dynamic";

export default async function AdminChannelsPage() {
  const runtime = await getRuntime();
  return (
    <ChannelsView
      initial={{
        channels: await runtime.channelService.list(),
        providerMode: runtime.config.providerMode,
        providerLabel: runtime.config.providerLabel,
      }}
    />
  );
}
