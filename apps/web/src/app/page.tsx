"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface ProjectRow {
  id: string;
  title: string;
  recipeId: string;
  platform: string;
  status: string;
  textRenderingMode: string;
  aspectRatio: string;
  coverAssetId: string | null;
  updatedAt: string;
}

const STATUS_LABEL: Record<string, { text: string; cls: string }> = {
  DRAFT: { text: "草稿", cls: "" },
  GENERATING: { text: "生成中", cls: "chip-accent" },
  READY_TO_EXPORT: { text: "待导出", cls: "chip-moss" },
  COMPLETED: { text: "已完成", cls: "chip-moss" },
  PAUSED: { text: "已暂停", cls: "" },
  CANCELLED: { text: "已取消", cls: "" },
  FAILED_RETRYABLE: { text: "失败可重试", cls: "chip-accent" },
  FAILED_FINAL: { text: "失败", cls: "chip-accent" },
};

const RECIPE_LABEL: Record<string, string> = {
  "knowledge-card": "知识卡片",
  "article-breakdown": "文章拆解",
  "book-recommendation": "图书推荐",
  "product-promo": "产品宣传",
  "science-comic": "科普漫画",
};

const PLATFORM_LABEL: Record<string, string> = {
  xiaohongshu: "小红书",
  douyin: "抖音",
  wechat: "公众号",
};

export default function ProjectsPage() {
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [filter, setFilter] = useState<string>("all");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
    async function load() {
      const res = await fetch("/api/projects");
      const json = (await res.json()) as { projects: ProjectRow[] };
      setProjects(json.projects ?? []);
      setLoading(false);
    }
  }, []);

  const filtered = filter === "all" ? projects : projects.filter((p) => p.status === filter);

  return (
    <div className="rise">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-tight">项目</h1>
          <p className="mt-1 text-sm text-ink-2">从输入到发布包，全部链路在一个工作台完成。</p>
        </div>
        <Link href="/projects/new" className="btn btn-accent">
          新建项目
        </Link>
      </div>

      <div className="mb-6 flex flex-wrap gap-2">
        {["all", "GENERATING", "READY_TO_EXPORT", "DRAFT", "FAILED_RETRYABLE"].map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`chip cursor-pointer ${filter === f ? "chip-accent" : ""}`}
          >
            {f === "all" ? "全部" : STATUS_LABEL[f]?.text ?? f}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="h-64 animate-pulse rounded-[14px] border border-line bg-paper-2" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="card flex cursor-default flex-col items-center justify-center gap-3 py-24 text-center">
          <div className="font-display text-xl font-bold">还没有项目</div>
          <p className="max-w-sm text-sm text-ink-2">
            输入一个主题、一篇文章或一份商品资料，几分钟内生成一套可直接发布的小红书/抖音/公众号图文。
          </p>
          <Link href="/projects/new" className="btn btn-primary mt-2">
            创建第一个项目
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((p, i) => {
            const st = STATUS_LABEL[p.status] ?? { text: p.status, cls: "" };
            return (
              <Link
                key={p.id}
                href={`/projects/${p.id}`}
                className="card rise group overflow-hidden"
                style={{ animationDelay: `${Math.min(i * 60, 400)}ms` }}
              >
                <div
                  className="relative flex items-center justify-center overflow-hidden border-b border-line bg-paper-2"
                  style={{ aspectRatio: p.aspectRatio.replace(":", "/") }}
                >
                  {p.coverAssetId ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={`/api/assets/${p.coverAssetId}`}
                      alt={p.title}
                      className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
                    />
                  ) : (
                    <span className="font-display text-4xl text-ink-3">壁</span>
                  )}
                  <span className={`chip absolute left-3 top-3 ${st.cls} ${p.status === "GENERATING" ? "pulse-dot" : ""} bg-white/90`}>
                    {st.text}
                  </span>
                </div>
                <div className="p-4">
                  <h3 className="font-display line-clamp-1 text-base font-bold">{p.title}</h3>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <span className="chip">{RECIPE_LABEL[p.recipeId] ?? p.recipeId}</span>
                    <span className="chip">{PLATFORM_LABEL[p.platform] ?? p.platform}</span>
                    <span className="chip">{p.aspectRatio}</span>
                    <span className={`chip ${p.textRenderingMode === "native" ? "chip-accent" : "chip-moss"}`}>
                      {p.textRenderingMode === "native" ? "原生文字" : "确定性"}
                    </span>
                  </div>
                  <div className="mt-3 text-xs text-ink-3">{new Date(p.updatedAt).toLocaleString("zh-CN")}</div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
