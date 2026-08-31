import { requireAdmin } from "@/server/auth";
import { redirect } from "next/navigation";
import { getRuntime } from "@/server/runtime";

export const dynamic = "force-dynamic";

const yuan = (cents: number) => (cents / 100).toFixed(2);

const CHANNEL_LABEL: Record<string, string> = { alipay: "支付宝", wechat: "微信支付", mock: "沙箱模拟" };
const STATUS_LABEL: Record<string, string> = {
  pending: "待支付",
  paid: "已支付",
  failed: "失败",
  refunded: "已退款",
  expired: "已过期",
};

/** 后台概览：收入统计 + 经营数字（服务端直取 Repo，无需中间 API） */
export default async function AdminOverviewPage() {
  const admin = await requireAdmin();
  if (!admin) redirect("/");
  void admin;
  const runtime = await getRuntime();
  const DAY_MS = 24 * 60 * 60 * 1000;
  const nowMs = Date.now();
  const [allTime, today, week, byChannel, statusCounts, ledgerSums, userCount] = await Promise.all([
    runtime.orderRepo.revenueByDay(0),
    runtime.orderRepo.revenueByDay(nowMs - DAY_MS),
    runtime.orderRepo.revenueByDay(nowMs - 7 * DAY_MS),
    runtime.orderRepo.revenueByChannel(),
    runtime.orderRepo.statusCounts(),
    runtime.ledgerRepo.sumByReason(),
    runtime.userRepo.count(),
  ]);
  const sum = (rows: Array<{ totalCents: number }>) => rows.reduce((acc, row) => acc + row.totalCents, 0);
  const byReason = Object.fromEntries(ledgerSums.map((row) => [row.reason, row.total]));
  const dailyMax = Math.max(1, ...allTime.map((row) => row.totalCents));
  const consumed = -(byReason["consume"] ?? 0);

  return (
    <div className="space-y-10">
      {/* 收入卡片 */}
      <section className="grid gap-4 sm:grid-cols-3">
        {[
          { label: "今日收入", value: `¥${yuan(sum(today))}`, sub: `${today.reduce((acc, r) => acc + r.count, 0)} 笔订单` },
          { label: "近 7 天收入", value: `¥${yuan(sum(week))}`, sub: `${week.reduce((acc, r) => acc + r.count, 0)} 笔订单` },
          { label: "累计收入", value: `¥${yuan(sum(allTime))}`, sub: `${byChannel.reduce((acc, r) => acc + r.count, 0)} 笔已支付` },
        ].map((card, index) => (
          <div key={card.label} className="rise rounded-[14px] border border-line bg-paper-card p-5" style={{ animationDelay: `${index * 60}ms` }}>
            <div className="kicker">{card.label}</div>
            <div className="mt-2 font-mono text-[26px] font-bold leading-none">{card.value}</div>
            <div className="mt-1.5 font-mono text-[11px] text-ink-faint">{card.sub}</div>
          </div>
        ))}
      </section>

      <div className="grid gap-8 md:grid-cols-2">
        {/* 每日收入（近 30 天柱状） */}
        <section className="rise">
          <div className="rule-double mb-3 flex items-baseline justify-between pt-2">
            <h2 className="font-display text-base font-bold">每日收入</h2>
            <span className="kicker">近 30 天</span>
          </div>
          {allTime.length === 0 ? (
            <p className="rounded-xl border border-dashed border-line-dark bg-paper-card/40 px-5 py-8 text-center text-sm text-ink-faint">
              还没有已支付订单。
            </p>
          ) : (
            <div className="flex h-36 items-end gap-1 rounded-xl border border-line bg-paper-card p-3">
              {allTime.slice(-30).map((row) => (
                <div key={row.day} className="group relative flex-1" title={`${row.day} ¥${yuan(row.totalCents)}（${row.count} 笔）`}>
                  <div
                    className="w-full rounded-sm bg-seal/70 transition-colors group-hover:bg-seal"
                    style={{ height: `${Math.max(4, (row.totalCents / dailyMax) * 110)}px` }}
                  />
                </div>
              ))}
            </div>
          )}
        </section>

        {/* 经营数字 */}
        <section className="rise" style={{ animationDelay: "60ms" }}>
          <div className="rule-double mb-3 flex items-baseline justify-between pt-2">
            <h2 className="font-display text-base font-bold">经营数字</h2>
            <span className="kicker">LEDGER</span>
          </div>
          <ul className="grid grid-cols-2 gap-3">
            {[
              { label: "注册用户", value: userCount },
              { label: "消耗点数", value: consumed },
              { label: "充值点数", value: byReason["purchase"] ?? 0 },
              { label: "订阅发点", value: byReason["subscription_grant"] ?? 0 },
            ].map((item) => (
              <li key={item.label} className="rounded-xl border border-line bg-paper-card px-4 py-3">
                <div className="font-mono text-xl font-bold">{item.value}</div>
                <div className="mt-0.5 text-xs text-ink-faint">{item.label}</div>
              </li>
            ))}
          </ul>
          <div className="mt-3 rounded-xl border border-line bg-paper-card px-4 py-3">
            <div className="kicker mb-2">收入构成</div>
            <ul className="space-y-1 font-mono text-xs text-ink-soft">
              {byChannel.map((row) => (
                <li key={row.channel} className="flex justify-between">
                  <span>{CHANNEL_LABEL[row.channel] ?? row.channel}</span>
                  <span>¥{yuan(row.totalCents)} · {row.count} 笔</span>
                </li>
              ))}
              {byChannel.length === 0 && <li className="text-ink-faint">暂无</li>}
            </ul>
          </div>
          <div className="mt-3 rounded-xl border border-line bg-paper-card px-4 py-3">
            <div className="kicker mb-2">订单状态</div>
            <ul className="flex flex-wrap gap-2">
              {statusCounts.map((row) => (
                <li key={row.status} className="stamp stamp-quiet text-[11px] text-ink-soft">
                  {STATUS_LABEL[row.status] ?? row.status} {row.count}
                </li>
              ))}
              {statusCounts.length === 0 && <li className="font-mono text-xs text-ink-faint">暂无订单</li>}
            </ul>
          </div>
        </section>
      </div>
    </div>
  );
}
