"use client";

import { useEffect, useState } from "react";
import type { Recipe } from "@aai/shared-schemas";
import { RECIPE_LABELS } from "@/lib/types";
import type { RunListItem } from "@/lib/types";
import { statusStamp } from "../workbench";

/* ── 视图类型:运行列表条目补充内容类型(供类型筛选与卡片 meta)── */
export interface GalleryRun extends RunListItem {
  recipe?: Recipe | undefined;
}

interface Props {
  initialRuns: GalleryRun[];
}

const REVIEW_FILTERS = [
  { value: "all", label: "全部" },
  { value: "pending", label: "待评审" },
  { value: "approved", label: "已完成" },
] as const;

/** 无封面作品:按类型给渐变占位(与工作台显影卡一致) */
const RECIPE_GRADIENTS: Record<Recipe, string> = {
  knowledge_cards: "radial-gradient(120% 90% at 20% 15%, #2e4a8f 0%, #101a33 58%, #0a0f1e 100%)",
  comic_story: "linear-gradient(200deg, #20302b 0%, #0e1613 60%, #080b0a 100%)",
  quote_cards: "radial-gradient(130% 100% at 50% 0%, #4a3f6b 0%, #241e38 55%, #0e0b18 100%)",
  checklist_cards: "linear-gradient(180deg, #1e3a34 0%, #0c1714 100%)",
  comparison_cards: "linear-gradient(140deg, #dde4ea 0%, #9fb2c4 50%, #4e6072 100%)",
  product_showcase: "radial-gradient(110% 100% at 75% 20%, #e8834a 0%, #b4402a 55%, #3e120c 100%)",
  book_recommendations: "linear-gradient(160deg, #f2e8d5 0%, #d8c9a8 45%, #8a6f45 100%)",
  article_digest: "linear-gradient(180deg, #3a2f22 0%, #171008 100%)",
  strip_comic: "radial-gradient(120% 100% at 30% 80%, #c8b7d9 0%, #7e6a99 45%, #2e2440 100%)",
};

/** 相对时间(挂载后渲染,避免 SSR/客户端水合不一致) */
function relativeTime(ts: number): string {
  const minutes = Math.floor((Date.now() - ts) / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "昨天";
  if (days < 30) return `${days} 天前`;
  return new Date(ts).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

function absoluteTime(ts: number): string {
  return new Date(ts).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** 作品库:全量作品浏览(筛选 chips + 显影卡网格,无创作条) */
export function Gallery({ initialRuns }: Props) {
  const [mounted, setMounted] = useState(false);
  const [reviewFilter, setReviewFilter] = useState<"all" | "pending" | "approved">("all");
  const [typeFilter, setTypeFilter] = useState<Recipe | "all">("all");
  useEffect(() => setMounted(true), []);

  const filteredRuns = initialRuns.filter(
    (run) =>
      (reviewFilter === "all" || run.reviewStatus === reviewFilter) &&
      (typeFilter === "all" || run.recipe === typeFilter),
  );

  return (
    <div className="px-[26px] pb-20 pt-[22px] max-md:px-4">
      {/* 筛选 chips */}
      <div className="mb-4 flex flex-wrap gap-2">
        {REVIEW_FILTERS.map((item) => {
          const on =
            item.value === "all"
              ? reviewFilter === "all" && typeFilter === "all"
              : reviewFilter === item.value;
          return (
            <button
              key={item.value}
              className={`chip ${on ? "on" : ""}`}
              onClick={() => {
                if (item.value === "all") setTypeFilter("all");
                setReviewFilter(item.value);
              }}
            >
              {item.label}
            </button>
          );
        })}
        {(Object.keys(RECIPE_LABELS) as Recipe[]).map((value) => (
          <button
            key={value}
            className={`chip ${typeFilter === value ? "on" : ""}`}
            onClick={() => setTypeFilter((current) => (current === value ? "all" : value))}
          >
            {RECIPE_LABELS[value]}
          </button>
        ))}
      </div>

      {/* 作品网格:显影卡(比工作台稍密) */}
      {filteredRuns.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line-dark px-6 py-14 text-center text-sm text-ink-faint">
          {initialRuns.length === 0 ? "作品库还是空的 —— 回到工作台创作第一件作品。" : "该筛选条件下暂无作品。"}
        </p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-4">
          {filteredRuns.map((run, index) => (
            <LibraryCard key={run.runId} run={run} mounted={mounted} delay={Math.min(index, 7) * 0.05} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ── 作品卡:保持封面原色 + 状态章 + mono meta,点击进详情 ── */
function LibraryCard({ run, mounted, delay }: { run: GalleryRun; mounted: boolean; delay: number }) {
  const isSucceeded = run.status === "succeeded";
  const pendingReview = isSucceeded && run.reviewStatus === "pending";
  const stampText = isSucceeded
    ? pendingReview
      ? "待评审"
      : "已生成"
    : statusStamp(run.status).text;
  const stampClass = pendingReview
    ? "border-[#f0b429]/40 bg-[#0a0908]/66 text-[#f0b429]"
    : "border-white/15 bg-[#0a0908]/66 text-[#e8e2d6]";
  const recipeName = run.recipe ? RECIPE_LABELS[run.recipe] : "图文作品";

  return (
    <button
      className="develop-card group rise text-left"
      style={{ animationDelay: `${delay}s` }}
      onClick={() => window.location.assign(`/runs/${run.runId}`)}
    >
      {/* 封面 */}
      <div className="relative aspect-[3/4] overflow-hidden">
        {run.coverAssetId ? (
          <img
            src={`/api/assets/${run.coverAssetId}`}
            alt={`《${run.topic}》封面`}
            className="cover-img absolute inset-0 h-full w-full object-cover"
          />
        ) : (
          <div
            className="cover-img absolute inset-0"
            style={{ background: RECIPE_GRADIENTS[run.recipe ?? "knowledge_cards"] }}
          >
            <span className="absolute top-[16%] left-0 right-0 text-center font-display text-[44px] font-black text-white">
              {run.topic.slice(0, 1) || "印"}
              <small className="mt-1.5 block text-[13px] font-normal tracking-[0.3em] opacity-75">
                {run.status === "running" ? "显影中" : "待显影"}
              </small>
            </span>
          </div>
        )}
        {/* 状态章 */}
        <span
          className={`absolute left-2 top-2 rounded-[5px] border px-1.5 py-[3px] font-mono text-[10px] tracking-[0.1em] backdrop-blur-[4px] ${stampClass} ${
            run.status === "running" ? "animate-pulse" : ""
          }`}
        >
          {stampText}
        </span>
      </div>
      {/* 标题独立于图片，避免用暗色半透明遮罩压住作品 */}
      <div className="border-t border-line/70 px-2.5 pb-1.5 pt-2.5">
        <p className="line-clamp-2 text-sm font-bold leading-snug text-ink">{run.topic}</p>
      </div>
      {/* meta 行 */}
      <div className="flex items-center justify-between px-2.5 py-2 font-mono text-[11px] text-ink-faint">
        <span className="truncate">
          {recipeName} · {run.pageCount > 0 ? `${run.pageCount}P` : "—"}
        </span>
        <span className="shrink-0 pl-2" suppressHydrationWarning>
          {mounted ? relativeTime(run.createdAt) : absoluteTime(run.createdAt)}
        </span>
      </div>
    </button>
  );
}
