import { getSettingsData } from "@/lib/api";
import { SettingsConsole } from "./settings-console";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const settings = await getSettingsData();
  return <SettingsConsole initialSettings={settings} />;
}
