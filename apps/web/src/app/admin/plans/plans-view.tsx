"use client";

import { useCallback, useEffect, useState } from "react";

interface AdminPlan {
  id: string;
  code: string;
  name: string;
  description: string;
  priceCents: number;
  periodDays: number;
  creditsPerPeriod: number;
  features: string[];
  active: number;
}

interface AdminPackage {
  id: string;
  name: string;
  credits: number;
  bonusCredits: number;
  priceCents: number;
  active: number;
}

const yuan = (cents: number) => (cents / 100).toFixed(2);

const EMPTY_PLAN = { code: "", name: "", description: "", priceCents: "", periodDays: "30", creditsPerPeriod: "", features: "" };
const EMPTY_PACKAGE = { name: "", credits: "", bonusCredits: "0", priceCents: "" };

export function PlansView() {
  const [plans, setPlans] = useState<AdminPlan[]>([]);
  const [packages, setPackages] = useState<AdminPackage[]>([]);
  const [planForm, setPlanForm] = useState(EMPTY_PLAN);
  const [packageForm, setPackageForm] = useState(EMPTY_PACKAGE);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    const response = await fetch("/api/admin/plans", { cache: "no-store" });
    if (response.ok) {
      const payload = (await response.json()) as { plans: AdminPlan[]; packages: AdminPackage[] };
      setPlans(payload.plans);
      setPackages(payload.packages);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function send(method: "POST" | "PATCH" | "DELETE", body?: Record<string, unknown>, query = "") {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/admin/plans${query}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
      await reload();
      return true;
    } catch (caught) {
      setMessage(`⚠ ${caught instanceof Error ? caught.message : String(caught)}`);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function createPlan() {
    const ok = await send("POST", {
      kind: "plan",
      code: planForm.code.trim(),
      name: planForm.name.trim(),
      description: planForm.description.trim(),
      priceCents: Math.round(Number(planForm.priceCents) * 100),
      periodDays: Number.parseInt(planForm.periodDays, 10) || 30,
      creditsPerPeriod: Number.parseInt(planForm.creditsPerPeriod, 10),
      features: planForm.features.split(/[、\n]/).map((item) => item.trim()).filter(Boolean),
    });
    if (ok) {
      setMessage("✓ 套餐已创建");
      setPlanForm(EMPTY_PLAN);
    }
  }

  async function createPackage() {
    const ok = await send("POST", {
      kind: "package",
      name: packageForm.name.trim(),
      credits: Number.parseInt(packageForm.credits, 10),
      bonusCredits: Number.parseInt(packageForm.bonusCredits, 10) || 0,
      priceCents: Math.round(Number(packageForm.priceCents) * 100),
    });
    if (ok) {
      setMessage("✓ 点数包已创建");
      setPackageForm(EMPTY_PACKAGE);
    }
  }

  const num = (value: string) => Number.parseInt(value, 10);

  return (
    <div className="space-y-10">
      {/* 订阅套餐 */}
      <section>
        <div className="rule-double mb-3 flex items-baseline justify-between pt-2">
          <h2 className="font-display text-base font-bold">订阅套餐</h2>
          <span className="kicker">{plans.length} 个</span>
        </div>
        <ul className="space-y-2">
          {plans.map((plan) => (
            <li key={plan.id} className="rounded-xl border border-line bg-paper-card px-4 py-3.5">
              <div className="flex flex-wrap items-center gap-4">
                <div className="flex w-[220px] shrink-0 items-center gap-2">
                  <span className="font-display min-w-0 truncate text-[15px] font-bold">{plan.name}</span>
                  <span className="font-mono text-[10px] text-ink-faint">{plan.code}</span>
                  {plan.active === 1 ? (
                    <span className="stamp text-[10px] text-seal">在售</span>
                  ) : (
                    <span className="stamp stamp-quiet text-[10px] text-ink-faint">下架</span>
                  )}
                </div>
                <div className="min-w-0 flex-1 font-mono text-[11px] text-ink-faint">
                  ¥{yuan(plan.priceCents)} / {plan.periodDays} 天 · 每期 {plan.creditsPerPeriod} 点
                  <div className="mt-0.5">{plan.features.join(" · ") || plan.description || "—"}</div>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <button
                    className="btn-ghost px-2.5 py-1 font-mono text-[11px]"
                    disabled={busy}
                    onClick={() => void send("PATCH", { kind: "plan", id: plan.id, active: plan.active !== 1 }).then(() => void reload())}
                  >
                    {plan.active === 1 ? "下架" : "上架"}
                  </button>
                  <button
                    className="btn-ghost px-2.5 py-1 font-mono text-[11px] hover:!border-seal hover:!text-seal"
                    disabled={busy}
                    onClick={() => {
                      if (!window.confirm(`删除套餐「${plan.name}」？有订单引用时需改为下架。`)) return;
                      void send("DELETE", undefined, `?kind=plan&id=${plan.id}`);
                    }}
                  >
                    删除
                  </button>
                </div>
              </div>
            </li>
          ))}
          {plans.length === 0 && (
            <li className="rounded-xl border border-dashed border-line-dark bg-paper-card/40 px-5 py-6 text-center text-sm text-ink-faint">
              暂无套餐。
            </li>
          )}
        </ul>

        {/* 新建套餐 */}
        <div className="mt-4 rounded-xl border border-line bg-paper-card p-4">
          <div className="kicker mb-3">新建订阅套餐</div>
          <div className="grid gap-3 sm:grid-cols-6">
            <input className="field-input" placeholder="code（唯一）" value={planForm.code} onChange={(e) => setPlanForm({ ...planForm, code: e.target.value })} />
            <input className="field-input" placeholder="名称" value={planForm.name} onChange={(e) => setPlanForm({ ...planForm, name: e.target.value })} />
            <input className="field-input" placeholder="价格（元）" value={planForm.priceCents} onChange={(e) => setPlanForm({ ...planForm, priceCents: e.target.value })} />
            <input className="field-input" placeholder="周期（天）" value={planForm.periodDays} onChange={(e) => setPlanForm({ ...planForm, periodDays: e.target.value })} />
            <input className="field-input" placeholder="每期点数" value={planForm.creditsPerPeriod} onChange={(e) => setPlanForm({ ...planForm, creditsPerPeriod: e.target.value })} />
            <button className="btn-ink px-4 py-2 font-mono text-xs" disabled={busy || !planForm.code || !planForm.name || !planForm.priceCents || !planForm.creditsPerPeriod} onClick={() => void createPlan()}>
              创建
            </button>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <input className="field-input" placeholder="描述" value={planForm.description} onChange={(e) => setPlanForm({ ...planForm, description: e.target.value })} />
            <input className="field-input" placeholder="权益（顿号分隔）" value={planForm.features} onChange={(e) => setPlanForm({ ...planForm, features: e.target.value })} />
          </div>
        </div>
      </section>

      {/* 点数包 */}
      <section>
        <div className="rule-double mb-3 flex items-baseline justify-between pt-2">
          <h2 className="font-display text-base font-bold">点数充值包</h2>
          <span className="kicker">{packages.length} 个</span>
        </div>
        <ul className="space-y-2">
          {packages.map((pkg) => (
            <li key={pkg.id} className="rounded-xl border border-line bg-paper-card px-4 py-3.5">
              <div className="flex flex-wrap items-center gap-4">
                <div className="flex w-[220px] shrink-0 items-center gap-2">
                  <span className="font-display min-w-0 truncate text-[15px] font-bold">{pkg.name}</span>
                  {pkg.active === 1 ? (
                    <span className="stamp text-[10px] text-seal">在售</span>
                  ) : (
                    <span className="stamp stamp-quiet text-[10px] text-ink-faint">下架</span>
                  )}
                </div>
                <div className="min-w-0 flex-1 font-mono text-[11px] text-ink-faint">
                  ¥{yuan(pkg.priceCents)} · {pkg.credits} 点{pkg.bonusCredits > 0 ? ` + 赠 ${pkg.bonusCredits}` : ""}
                  <span className="ml-2">单价 {(pkg.priceCents / 100 / (pkg.credits + pkg.bonusCredits)).toFixed(3)} 元/点</span>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <button
                    className="btn-ghost px-2.5 py-1 font-mono text-[11px]"
                    disabled={busy}
                    onClick={() => void send("PATCH", { kind: "package", id: pkg.id, active: pkg.active !== 1 }).then(() => void reload())}
                  >
                    {pkg.active === 1 ? "下架" : "上架"}
                  </button>
                  <button
                    className="btn-ghost px-2.5 py-1 font-mono text-[11px] hover:!border-seal hover:!text-seal"
                    disabled={busy}
                    onClick={() => {
                      if (!window.confirm(`删除点数包「${pkg.name}」？有订单引用时需改为下架。`)) return;
                      void send("DELETE", undefined, `?kind=package&id=${pkg.id}`);
                    }}
                  >
                    删除
                  </button>
                </div>
              </div>
            </li>
          ))}
          {packages.length === 0 && (
            <li className="rounded-xl border border-dashed border-line-dark bg-paper-card/40 px-5 py-6 text-center text-sm text-ink-faint">
              暂无点数包。
            </li>
          )}
        </ul>

        <div className="mt-4 rounded-xl border border-line bg-paper-card p-4">
          <div className="kicker mb-3">新建点数包</div>
          <div className="grid gap-3 sm:grid-cols-5">
            <input className="field-input" placeholder="名称" value={packageForm.name} onChange={(e) => setPackageForm({ ...packageForm, name: e.target.value })} />
            <input className="field-input" placeholder="点数" value={packageForm.credits} onChange={(e) => setPackageForm({ ...packageForm, credits: e.target.value })} />
            <input className="field-input" placeholder="赠送点数" value={packageForm.bonusCredits} onChange={(e) => setPackageForm({ ...packageForm, bonusCredits: e.target.value })} />
            <input className="field-input" placeholder="价格（元）" value={packageForm.priceCents} onChange={(e) => setPackageForm({ ...packageForm, priceCents: e.target.value })} />
            <button className="btn-ink px-4 py-2 font-mono text-xs" disabled={busy || !packageForm.name || num(packageForm.credits) <= 0 || !packageForm.priceCents} onClick={() => void createPackage()}>
              创建
            </button>
          </div>
        </div>
      </section>

      {message && <p className="font-mono text-xs text-ink-soft">{message}</p>}
    </div>
  );
}
