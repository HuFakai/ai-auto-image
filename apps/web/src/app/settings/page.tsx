import { redirect } from "next/navigation";
import { requireAdmin } from "@/server/auth";
import { getRuntime } from "@/server/runtime";
import { toBrandKitView } from "@/server/brand-kit-views";
import { SettingsView } from "./settings-view";

export const dynamic = "force-dynamic";

/** 品牌手册设置（模型渠道已迁至 /admin/channels） */
export default async function SettingsPage() {
  const admin = await requireAdmin();
  if (!admin) redirect("/");
  const runtime = await getRuntime();
  return <SettingsView initialKits={(await runtime.brandKitRepo.list()).map(toBrandKitView)} />;
}
