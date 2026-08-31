import { redirect } from "next/navigation";
import { requireAdmin } from "@/server/auth";
import { AdminNav } from "./admin-nav";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const admin = await requireAdmin();
  if (!admin) redirect("/");
  return (
    <div className="mx-auto max-w-[1080px] px-[26px] pb-24 pt-8 max-md:px-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="kicker">ADMIN · 管理后台</p>
          <h1 className="mt-2 font-display text-xl font-bold">运营控制台</h1>
        </div>
        <span className="font-mono text-[11px] text-ink-faint">signed in as {admin.username}</span>
      </div>
      <AdminNav />
      <div className="mt-8">{children}</div>
    </div>
  );
}
