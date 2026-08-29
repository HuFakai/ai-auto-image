import { getDashboardData } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(await getDashboardData());
}
