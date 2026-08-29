import { notFound } from "next/navigation";
import { getRuntime } from "@/server/runtime";
import { buildRunDetail } from "@/server/run-views";
import { RunDetailView } from "./detail-view";

export const dynamic = "force-dynamic";

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const runtime = await getRuntime();
  const detail = await buildRunDetail(runtime, id);
  if (!detail) notFound();
  return <RunDetailView initial={detail} />;
}
