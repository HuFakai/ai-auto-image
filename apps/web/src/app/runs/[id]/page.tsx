import { notFound } from "next/navigation";
import { requireUser } from "@/server/auth";
import { getRuntime } from "@/server/runtime";
import { buildRunDetail } from "@/server/run-views";
import { RunDetailView } from "./detail-view";

export const dynamic = "force-dynamic";

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  if (user.role !== "admin") {
    try {
      const run = await (await getRuntime()).runRepo.require(id);
      if (run.userId !== user.id) notFound();
    } catch {
      notFound();
    }
  }
  const runtime = await getRuntime();
  const detail = await buildRunDetail(runtime, id);
  if (!detail) notFound();
  return <RunDetailView initial={detail} />;
}
