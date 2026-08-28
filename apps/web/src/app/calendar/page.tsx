"use client";

import { useEffect, useMemo, useState } from "react";

interface PublishJob {
  id: string;
  projectId: string;
  platform: string;
  scope: string;
  status: string;
  scheduledAt: string | null;
  authorization: string;
  createdAt: string;
}

const STATUS_CLS: Record<string, string> = {
  draft_created: "chip-moss",
  pending: "chip-accent",
  failed: "chip-accent",
  unknown_result: "",
};

export default function CalendarPage() {
  const [jobs, setJobs] = useState<PublishJob[]>([]);
  const [projectTitles, setProjectTitles] = useState<Record<string, string>>({});
  const [cursor, setCursor] = useState(() => {
    const d = new Date();
    return { y: d.getFullYear(), m: d.getMonth() };
  });

  useEffect(() => {
    fetch("/api/platform")
      .then((r) => r.json())
      .then((j) => setJobs(j.jobs ?? []));
    fetch("/api/projects")
      .then((r) => r.json())
      .then((j) => setProjectTitles(Object.fromEntries((j.projects ?? []).map((p: { id: string; title: string }) => [p.id, p.title]))));
  }, []);

  const cells = useMemo(() => {
    const first = new Date(cursor.y, cursor.m, 1);
    const startWeekday = first.getDay();
    const daysInMonth = new Date(cursor.y, cursor.m + 1, 0).getDate();
    const arr: Array<{ day: number | null; jobs: PublishJob[] }> = [];
    for (let i = 0; i < startWeekday; i += 1) arr.push({ day: null, jobs: [] });
    for (let d = 1; d <= daysInMonth; d += 1) {
      arr.push({
        day: d,
        jobs: jobs.filter((j) => {
          const t = j.scheduledAt ?? j.createdAt;
          const dt = new Date(t);
          return dt.getFullYear() === cursor.y && dt.getMonth() === cursor.m && dt.getDate() === d;
        }),
      });
    }
    return arr;
  }, [jobs, cursor]);

  async function schedule(jobId: string, day: number) {
    const time = new Date(cursor.y, cursor.m, day, 10, 0).toISOString();
    await fetch("/api/platform", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobId, scheduledAt: time }) });
    setJobs((prev) => prev.map((j) => (j.id === jobId ? { ...j, scheduledAt: time } : j)));
  }

  return (
    <div className="rise">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-tight">内容日历</h1>
          <p className="mt-1 text-sm text-ink-2">草稿任务排期。拖动需求请通过点击日期格重排（幂等键保证不重复写入平台）。</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="btn btn-ghost !py-1.5"
            onClick={() => setCursor(({ y, m }) => (m === 0 ? { y: y - 1, m: 11 } : { y, m: m - 1 }))}
          >
            ←
          </button>
          <span className="font-display text-lg font-bold">
            {cursor.y} 年 {cursor.m + 1} 月
          </span>
          <button
            className="btn btn-ghost !py-1.5"
            onClick={() => setCursor(({ y, m }) => (m === 11 ? { y: y + 1, m: 0 } : { y, m: m + 1 }))}
          >
            →
          </button>
        </div>
      </div>

      <div className="card !cursor-default mt-6 overflow-hidden p-0">
        <div className="grid grid-cols-7 border-b border-line bg-paper-2 text-center text-xs font-semibold text-ink-2">
          {["日", "一", "二", "三", "四", "五", "六"].map((d) => (
            <div key={d} className="py-2">
              {d}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {cells.map((c, i) => (
            <div key={i} className="min-h-24 border-b border-r border-line p-1.5 last:border-r-0" style={{ borderBottomWidth: i >= cells.length - 7 ? 0 : 1 }}>
              {c.day && <div className="text-xs text-ink-3">{c.day}</div>}
              <div className="space-y-1">
                {c.jobs.map((j) => (
                  <button
                    key={j.id}
                    onClick={() => c.day && schedule(j.id, c.day)}
                    title="点击将排期调整到当天 10:00"
                    className={`block w-full truncate rounded px-1.5 py-1 text-left text-[10px] font-medium ${
                      j.status === "draft_created" ? "bg-[#eef4e2] text-moss" : "bg-accent-soft text-accent"
                    }`}
                  >
                    {projectTitles[j.projectId]?.slice(0, 8) ?? j.projectId.slice(0, 8)}·{j.platform}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      <h2 className="font-display mt-8 text-lg font-bold">发布任务</h2>
      <div className="card !cursor-default mt-3 overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-ink-2">
              <th className="px-4 py-2.5">项目</th>
              <th className="px-4 py-2.5">平台</th>
              <th className="px-4 py-2.5">范围</th>
              <th className="px-4 py-2.5">状态</th>
              <th className="px-4 py-2.5">授权摘要</th>
              <th className="px-4 py-2.5">创建时间</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => {
              const auth = JSON.parse(j.authorization) as { accountAlias?: string; titleSummary?: string };
              return (
                <tr key={j.id} className="border-b border-line last:border-0">
                  <td className="px-4 py-2.5">{projectTitles[j.projectId] ?? j.projectId}</td>
                  <td className="px-4 py-2.5">{j.platform}</td>
                  <td className="px-4 py-2.5">{j.scope === "publish" ? "正式发布" : "草稿"}</td>
                  <td className="px-4 py-2.5">
                    <span className={`chip ${STATUS_CLS[j.status] ?? ""}`}>{j.status}</span>
                  </td>
                  <td className="px-4 py-2.5 text-xs text-ink-2">
                    {auth.accountAlias} · {auth.titleSummary}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-ink-3">{new Date(j.createdAt).toLocaleString("zh-CN")}</td>
                </tr>
              );
            })}
            {jobs.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-ink-3">
                  暂无发布任务
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
