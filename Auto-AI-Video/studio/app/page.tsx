import { getDashboardData } from "@/lib/api";
import { ProductionDesk } from "./production-desk";

export const dynamic = "force-dynamic";

export default async function Home() {
  const initialData = await getDashboardData();
  return <ProductionDesk initialData={initialData} />;
}
