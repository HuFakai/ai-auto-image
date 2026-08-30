"use client";

import { useEffect, useRef, useState } from "react";
import { TextRenderingModeSchema } from "@aai/shared-schemas";
import type { Recipe } from "@aai/shared-schemas";
import { RECIPE_LABELS } from "@/lib/types";
import type { BrandKitView, RunListItem, RunsListPayload } from "@/lib/types";

/* ── 视图类型：运行列表条目补充内容类型（供类型筛选与卡片 meta）── */
export interface WorkbenchRun extends RunListItem {
  recipe?: Recipe | undefined;
}
export interface WorkbenchInitial extends RunsListPayload {
  runs: WorkbenchRun[];
}

interface Props {
  initial: WorkbenchInitial;
  brandKits: BrandKitView[];
  stats: { total: number; pending: number; images: number };
}

/** 编辑部状态章：状态 → 章文与色 */
export function statusStamp(status: string): { text: string; className: string } {
  switch (status) {
    case "succeeded":
      return { text: "已讫", className: "stamp text-seal" };
    case "running":
      return { text: "制中", className: "stamp text-seal animate-pulse" };
    case "queued":
      return { text: "待排", className: "stamp stamp-quiet text-ink-faint" };
    case "failed":
      return { text: "作废", className: "stamp text-ink line-through decoration-1" };
    case "cancelled":
      return { text: "已废", className: "stamp stamp-quiet text-ink-faint" };
    default:
      return { text: status, className: "stamp stamp-quiet text-ink-faint" };
  }
}

/** 主题输入框占位文案（按内容类型给出示例） */
const TOPIC_PLACEHOLDERS: Record<Recipe, string> = {
  knowledge_cards: "主题，例如：三分钟看懂量子纠缠",
  comic_story: "漫画主题，例如：为什么会晕车",
  quote_cards: "主题，例如：保持专注的三句话",
  checklist_cards: "主题，例如：新手露营清单",
  comparison_cards: "对比主题，例如：骑自行车还是坐地铁通勤",
  product_showcase: "产品主题，例如：这款便携咖啡机",
  book_recommendations: "图书主题，例如：《置身事内》为什么值得读",
  article_digest: "长文主题，例如：复利思维入门",
  strip_comic: "漫画主题，例如：没带伞的一天",
};

/* ── 类型 / 品牌预览托盘数据（效果图存于 public/previews/）── */
const TYPE_PREVIEWS: Array<{ id: Recipe; name: string; img: string }> = (
  Object.keys(RECIPE_LABELS) as Recipe[]
).map((id) => ({ id, name: RECIPE_LABELS[id], img: `/previews/types/${id}.png` }));

const BRAND_PREVIEWS: Array<{ id: string; name: string; img: string }> = [
  { id: "darkroom", name: "暗房工作室", img: "/previews/brands/darkroom.png" },
  { id: "paper_minimal", name: "纸感极简", img: "/previews/brands/paper_minimal.png" },
  { id: "high_contrast", name: "高对比营销", img: "/previews/brands/high_contrast.png" },
  { id: "morandi", name: "莫兰迪生活", img: "/previews/brands/morandi.png" },
  { id: "tech_dark", name: "科技深色", img: "/previews/brands/tech_dark.png" },
  { id: "book_paper", name: "图书纸张", img: "/previews/brands/book_paper.png" },
];

/** 无封面作品：按类型给渐变占位（参照静态稿 .ph-*） */
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

/** 相对时间（挂载后渲染，避免 SSR/客户端水合不一致） */
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

const REVIEW_FILTERS = [
  { value: "all", label: "全部" },
  { value: "pending", label: "待评审" },
  { value: "approved", label: "已完成" },
  { value: "rejected", label: "驳回" },
] as const;

export function Workbench({ initial, brandKits, stats }: Props) {
  const [data, setData] = useState<WorkbenchInitial>(initial);
  const [topic, setTopic] = useState("");
  const [aspectRatio, setAspectRatio] = useState("3:4");
  const [mode, setMode] = useState<string>("native");
  const [sourceText, setSourceText] = useState("");
  const [brandKitId, setBrandKitId] = useState("");
  const [brandTheme, setBrandTheme] = useState(""); // 托盘选中的品牌主题 id（"" = 不使用）
  const [recipe, setRecipe] = useState<Recipe>("knowledge_cards");
  const [castDescription, setCastDescription] = useState("");
  const [comparisonTarget, setComparisonTarget] = useState("");
  const [productName, setProductName] = useState("");
  const [productSellingPoints, setProductSellingPoints] = useState("");
  const [productAudience, setProductAudience] = useState("");
  const [productPriceNote, setProductPriceNote] = useState("");
  const [bookTitle, setBookTitle] = useState("");
  const [bookAuthor, setBookAuthor] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [urlImporting, setUrlImporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requireApproval, setRequireApproval] = useState(false);
  const [generateCovers, setGenerateCovers] = useState(false);
  const [reviewFilter, setReviewFilter] = useState<"all" | "pending" | "approved" | "rejected">("all");
  const [typeFilter, setTypeFilter] = useState<Recipe | "all">("all");

  /* 托盘与 lightbox */
  const [trayGroup, setTrayGroup] = useState<"type" | "brand" | null>(null);
  const [lightbox, setLightbox] = useState<{ img: string; name: string } | null>(null);
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const trayRowRef = useRef<HTMLDivElement | null>(null);

  /* 内容类型映射（轮询刷新不携带 recipe，用首屏解析结果回填） */
  const recipeMap = useRef<Map<string, Recipe | undefined>>(
    new Map(initial.runs.map((run) => [run.runId, run.recipe])),
  );

  const isComicRecipe = recipe === "comic_story" || recipe === "strip_comic";
  const brandName = BRAND_PREVIEWS.find((item) => item.id === brandTheme)?.name ?? "不使用";

  /* Esc 关闭大图 / 托盘；卸载时清理计时器 */
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setLightbox(null);
      setTrayGroup(null);
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (clickTimer.current) clearTimeout(clickTimer.current);
    };
  }, []);

  useEffect(() => {
    const active = data.runs.some((run) => run.status === "running" || run.status === "queued");
    const timer = setInterval(
      async () => {
        try {
          const response = await fetch("/api/runs", { cache: "no-store" });
          if (!response.ok) return;
          const payload = (await response.json()) as RunsListPayload;
          setData({
            ...payload,
            runs: payload.runs.map((run) => ({ ...run, recipe: recipeMap.current.get(run.runId) })),
          });
        } catch {
          /* 下一轮再取 */
        }
      },
      active ? 3000 : 15000,
    );
    return () => clearInterval(timer);
  }, [data.runs]);

  async function importUrl() {
    if (!url.trim() || urlImporting) return;
    setUrlImporting(true);
    setError(null);
    try {
      const response = await fetch("/api/fetch-url", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });
      const result = (await response.json()) as { title?: string; text?: string; error?: string };
      if (!response.ok || !result.text) throw new Error(result.error ?? `HTTP ${response.status}`);
      setSourceText(`${result.title ? `【${result.title}】\n` : ""}${result.text}`.slice(0, 20000));
      setNotice(`已导入「${result.title || url}」正文，可编辑后生成。`);
    } catch (caught) {
      setError(`URL 抓取失败（${caught instanceof Error ? caught.message : caught}），可直接粘贴正文。`);
    } finally {
      setUrlImporting(false);
    }
  }

  async function submit() {
    if (!topic.trim() || submitting) return;
    if (recipe === "article_digest" && !sourceText.trim()) {
      setError("长文拆解需要提供参考资料正文（sourceText）才能拆解。");
      setMoreOpen(true);
      return;
    }
    setSubmitting(true);
    setError(null);
    const productInfo = {
      ...(productName.trim() ? { name: productName.trim().slice(0, 200) } : {}),
      ...(productSellingPoints.trim()
        ? { sellingPoints: productSellingPoints.split(/[,，]/).map((s) => s.trim()).filter(Boolean).slice(0, 12) }
        : {}),
      ...(productAudience.trim() ? { audience: productAudience.trim().slice(0, 400) } : {}),
      ...(productPriceNote.trim() ? { priceNote: productPriceNote.trim().slice(0, 200) } : {}),
    };
    const bookInfo = {
      ...(bookTitle.trim() ? { title: bookTitle.trim().slice(0, 300) } : {}),
      ...(bookAuthor.trim() ? { author: bookAuthor.trim().slice(0, 200) } : {}),
    };
    try {
      const response = await fetch("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          recipe,
          topic: topic.trim(),
          aspectRatio,
          textRenderingMode: TextRenderingModeSchema.parse(mode),
          ...(isComicRecipe && castDescription.trim()
            ? { castDescription: castDescription.trim().slice(0, 2000) }
            : {}),
          ...(recipe === "comparison_cards" && comparisonTarget.trim()
            ? { comparisonTarget: comparisonTarget.trim().slice(0, 400) }
            : {}),
          ...(recipe === "product_showcase" && Object.keys(productInfo).length > 0 ? { productInfo } : {}),
          ...(recipe === "book_recommendations" && Object.keys(bookInfo).length > 0 ? { bookInfo } : {}),
          ...(!isComicRecipe && sourceText.trim()
            ? { sourceText: sourceText.trim().slice(0, 20000) }
            : {}),
          ...(brandKitId ? { brandKitId } : {}),
          requireApproval,
          generateCoverCandidates: generateCovers,
        }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${response.status}`);
      }
      const created = (await response.json()) as { runId: string };
      window.location.assign(`/runs/${created.runId}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setSubmitting(false);
    }
  }

  /* 托盘交互：单击 = 选中（260ms 后收起），双击 = 大图 */
  function openTray(group: "type" | "brand") {
    setTrayGroup((current) => (current === group ? null : group));
    // 展开后让当前选中卡滚到可视中心
    requestAnimationFrame(() => {
      setTimeout(() => {
        const el = trayRowRef.current?.querySelector(".tray-card.sel");
        el?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
      }, 60);
    });
  }
  function selectTrayCard(group: "type" | "brand", id: string) {
    if (group === "type") {
      setRecipe(id as Recipe);
    } else {
      setBrandTheme(id);
      setBrandKitId(brandKits.find((kit) => kit.themeId === id)?.id ?? "");
    }
    // 选中后保持托盘展开,并让选中卡滚动到可视中心(后面的选项不被遮挡)
    requestAnimationFrame(() => {
      const el = trayRowRef.current?.querySelector(".tray-card.sel");
      el?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
    });
  }
  function onTrayCardClick(group: "type" | "brand", id: string) {
    if (clickTimer.current) clearTimeout(clickTimer.current);
    clickTimer.current = setTimeout(() => selectTrayCard(group, id), 260);
  }
  function onTrayCardDoubleClick(group: "type" | "brand", item: { name: string; img?: string }) {
    if (clickTimer.current) clearTimeout(clickTimer.current);
    if (item.img) setLightbox({ img: item.img, name: item.name });
  }

  const filteredRuns = data.runs.filter(
    (run) =>
      (reviewFilter === "all" || run.reviewStatus === reviewFilter) &&
      (typeFilter === "all" || run.recipe === typeFilter),
  );

  const trayItems =
    trayGroup === "type"
      ? TYPE_PREVIEWS
      : trayGroup === "brand"
        ? [{ id: "", name: "不使用", img: "" }, ...BRAND_PREVIEWS]
        : [];
  const traySelectedId = trayGroup === "type" ? recipe : trayGroup === "brand" ? brandTheme : "";

  return (
    <div className="px-[26px] pb-[190px] pt-[22px] max-md:px-4">
      {/* 统计行 */}
      <div className="mb-5 flex flex-wrap gap-[26px] max-md:gap-4">
        <div>
          <div className="font-mono text-[22px] font-bold leading-tight">{stats.total}</div>
          <div className="text-xs text-ink-faint">作品总数</div>
        </div>
        <div>
          <div className="font-mono text-[22px] font-bold leading-tight text-seal">{stats.pending}</div>
          <div className="text-xs text-ink-faint">待评审</div>
        </div>
        <div>
          <div className="font-mono text-[22px] font-bold leading-tight">{stats.images}</div>
          <div className="text-xs text-ink-faint">已生成图片</div>
        </div>
      </div>

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

      {/* 作品网格：显影卡 */}
      {filteredRuns.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line-dark px-6 py-14 text-center text-sm text-ink-faint">
          {data.runs.length === 0 ? "版面还是空的 —— 在下方写下第一个主题。" : "该筛选条件下暂无作品。"}
        </p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(215px,1fr))] gap-[18px]">
          {filteredRuns.map((run, index) => (
            <DevelopCard key={run.runId} run={run} delay={Math.min(index, 7) * 0.05} />
          ))}
        </div>
      )}

      {/* 底部悬浮创作条 */}
      <div className="createbar-shell">
        <div className="createbar">
          {error && <p className="px-4 pt-2.5 font-mono text-xs text-seal">⚠ {error}</p>}
          {notice && <p className="px-4 pt-2.5 font-mono text-xs text-ink-soft">✓ {notice}</p>}

          {/* row1：主题 + 开始创作 */}
          <div className="flex items-center gap-2.5 px-3.5 pb-1 pt-3 max-sm:px-3">
            <input
              className="min-w-0 flex-1 bg-transparent py-2.5 text-[15px] text-ink outline-none placeholder:text-ink-faint"
              placeholder={TOPIC_PLACEHOLDERS[recipe]}
              value={topic}
              maxLength={120}
              onChange={(event) => setTopic(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void submit();
              }}
            />
            <button
              className="btn-ink shrink-0 px-5 py-2.5 text-sm"
              onClick={() => void submit()}
              disabled={submitting || !topic.trim()}
            >
              {submitting ? "排字中…" : "开始创作"}
            </button>
          </div>

          {/* 类型 / 品牌预览托盘 */}
          <div className={`tray ${trayGroup ? "open" : ""}`}>
            <p className="tray-hint">
              {(trayGroup === "type" ? "内容类型" : "品牌手册") + " · 单击卡片 = 选中 · 双击 = 查看大图"}
            </p>
            <div className="tray-row" ref={trayRowRef}>
              {trayItems.map((item) => (
                <div
                  key={item.id || "none"}
                  className={`tray-card ${traySelectedId === item.id ? "sel" : ""}`}
                  onClick={() => onTrayCardClick(trayGroup!, item.id)}
                  onDoubleClick={() => onTrayCardDoubleClick(trayGroup!, item)}
                >
                  {item.img ? (
                    <img src={item.img} alt={item.name} />
                  ) : (
                    <div className="grid aspect-[3/4] place-items-center font-mono text-[10px] tracking-[0.2em] text-ink-faint">
                      无
                    </div>
                  )}
                  <div className="tray-name">{item.name}</div>
                </div>
              ))}
            </div>
          </div>

          {/* row2：参数 chips */}
          <div className="flex flex-wrap items-center gap-1.5 px-3 pb-3 pt-2 max-sm:px-2.5">
            <Param label="类型" value={RECIPE_LABELS[recipe]} onClick={() => openTray("type")} active={trayGroup === "type"} />
            <Param
              label="文字"
              value={mode === "native" ? "原生中文" : "确定性排版"}
              onClick={() => setMode((current) => (current === "native" ? "deterministic" : "native"))}
              title="单击切换文字模式"
            />
            <Param
              label="比例"
              value={aspectRatio}
              onClick={() =>
                setAspectRatio((current) => {
                  const order = ["3:4", "9:16", "1:1", "16:9"];
                  return order[(order.indexOf(current) + 1) % order.length] ?? "3:4";
                })
              }
              title="单击切换比例"
            />
            <Param label="品牌" value={brandName} onClick={() => openTray("brand")} active={trayGroup === "brand"} />
            {!isComicRecipe && (
              <ToggleParam
                label="封面候选"
                on={generateCovers}
                onClick={() => setGenerateCovers(!generateCovers)}
                title="生成 3 个封面候选供挑选（额外消耗 3 次图片额度）"
              />
            )}
            <ToggleParam
              label="审批门"
              on={requireApproval}
              onClick={() => setRequireApproval(!requireApproval)}
              title="完成后需人工确认终稿（确认前不可导出）"
            />
            <button
              className="ml-auto bg-none font-mono text-[11px] text-ink-faint transition-colors hover:text-ink"
              onClick={() => setMoreOpen(!moreOpen)}
            >
              {moreOpen ? "收起长文 ▴" : "粘贴长文 · 从 URL 导入 ▾"}
            </button>
          </div>

          {/* 展开区：长文 / 类型专属字段 */}
          {moreOpen && (
            <div className="space-y-3.5 border-t border-line px-3.5 pb-4 pt-3.5 max-sm:px-3">
              {isComicRecipe && (
                <div>
                  <span className="field-label">主角设定（可选）</span>
                  <textarea
                    className="field-input mt-1 min-h-[48px] resize-y font-mono !text-[12px]"
                    placeholder="例如：科普向导少女「阿晕」，扎双马尾，戴圆框眼镜，穿薄荷绿实验服"
                    value={castDescription}
                    maxLength={2000}
                    onChange={(event) => setCastDescription(event.target.value)}
                  />
                </div>
              )}

              {recipe === "comparison_cards" && (
                <div>
                  <span className="field-label">对比对象 B（可选 · 留空则由模型从主题语境确定）</span>
                  <input
                    className="field-input mt-1 font-mono !text-[12px]"
                    placeholder="例如：骑自行车（A） vs 坐地铁（B）中的「坐地铁」"
                    value={comparisonTarget}
                    maxLength={400}
                    onChange={(event) => setComparisonTarget(event.target.value)}
                  />
                </div>
              )}

              {recipe === "product_showcase" && (
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <span className="field-label">产品名称（可选）</span>
                    <input
                      className="field-input mt-1 font-mono !text-[12px]"
                      placeholder="例如：摩卡壶"
                      value={productName}
                      maxLength={200}
                      onChange={(event) => setProductName(event.target.value)}
                    />
                  </div>
                  <div>
                    <span className="field-label">目标人群（可选）</span>
                    <input
                      className="field-input mt-1 font-mono !text-[12px]"
                      placeholder="例如：租房白领"
                      value={productAudience}
                      maxLength={400}
                      onChange={(event) => setProductAudience(event.target.value)}
                    />
                  </div>
                  <div>
                    <span className="field-label">价格说明（可选）</span>
                    <input
                      className="field-input mt-1 font-mono !text-[12px]"
                      placeholder="例如：200 元档，双十一有优惠"
                      value={productPriceNote}
                      maxLength={200}
                      onChange={(event) => setProductPriceNote(event.target.value)}
                    />
                  </div>
                  <div>
                    <span className="field-label">卖点（可选 · 逗号分隔）</span>
                    <input
                      className="field-input mt-1 font-mono !text-[12px]"
                      placeholder="例如：小巧、出杯快、好清洗"
                      value={productSellingPoints}
                      maxLength={500}
                      onChange={(event) => setProductSellingPoints(event.target.value)}
                    />
                  </div>
                </div>
              )}

              {recipe === "book_recommendations" && (
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <span className="field-label">书名（可选）</span>
                    <input
                      className="field-input mt-1 font-mono !text-[12px]"
                      placeholder="例如：置身事内"
                      value={bookTitle}
                      maxLength={300}
                      onChange={(event) => setBookTitle(event.target.value)}
                    />
                  </div>
                  <div>
                    <span className="field-label">作者（可选）</span>
                    <input
                      className="field-input mt-1 font-mono !text-[12px]"
                      placeholder="例如：兰小欢"
                      value={bookAuthor}
                      maxLength={200}
                      onChange={(event) => setBookAuthor(event.target.value)}
                    />
                  </div>
                </div>
              )}

              {!isComicRecipe && (
                <div>
                  <div className="flex items-center justify-between">
                    <span className="field-label">
                      {recipe === "article_digest"
                        ? "参考资料（必填 · 长文拆解需要原文）"
                        : recipe === "product_showcase"
                          ? "产品资料正文（可选 · 有则作为产品资料唯一事实来源）"
                          : "参考资料（可选 · 长文按要点密度拆为 6–10 页）"}
                    </span>
                    <span className="font-mono text-[10px] text-ink-faint">{sourceText.length}/20000</span>
                  </div>
                  <textarea
                    className="field-input mt-1 min-h-[48px] resize-y font-mono !text-[12px]"
                    placeholder="粘贴文章 / Markdown / 资料正文"
                    value={sourceText}
                    maxLength={20000}
                    onChange={(event) => setSourceText(event.target.value)}
                  />
                  <div className="mt-2 flex items-center gap-2">
                    <input
                      className="field-input !py-1 font-mono !text-xs"
                      placeholder="https://example.com/article（实验能力）"
                      value={url}
                      onChange={(event) => setUrl(event.target.value)}
                    />
                    <button
                      className="btn-ghost shrink-0 px-3 py-1 font-mono text-[11px]"
                      onClick={() => void importUrl()}
                      disabled={urlImporting || !url.trim()}
                    >
                      {urlImporting ? "抓取中…" : "从 URL 导入"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 大图 lightbox */}
      {lightbox && (
        <div className="lightbox open" onClick={() => setLightbox(null)}>
          <img src={lightbox.img} alt={lightbox.name} />
          <div className="text-sm text-ink">
            {lightbox.name}
            <small className="mt-1 block text-center font-mono text-[11px] text-ink-faint">单击任意处关闭</small>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── row2 参数小按钮（mono）── */
function Param({
  label,
  value,
  onClick,
  title,
  active,
}: {
  label: string;
  value: string;
  onClick: () => void;
  title?: string;
  /** 托盘展开中：文字与值转小红书红表示选中态 */
  active?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-[7px] border border-line px-2.5 py-1 font-mono text-[11.5px] transition-colors ${
        active ? "border-seal/60 text-seal hover:text-seal" : "text-ink-soft hover:border-ink-faint hover:text-ink"
      }`}
    >
      {label}
      <b className={`font-semibold ${active ? "text-seal" : "text-ink"}`}>{value}</b>
      {(label === "类型" || label === "品牌") && <span className="text-ink-faint">▾</span>}
    </button>
  );
}

/* ── row2 开关小按钮（封面候选 / 审批门）── */
function ToggleParam({
  label,
  on,
  onClick,
  title,
}: {
  label: string;
  on: boolean;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-[7px] border border-line px-2.5 py-1 font-mono text-[11.5px] transition-colors hover:border-ink-faint ${
        on ? "text-ink" : "text-ink-soft"
      }`}
    >
      <span
        className="relative inline-block h-2 w-3.5 rounded-full transition-colors"
        style={{ background: on ? "var(--color-seal-deep)" : "#3a342e" }}
      >
        <span
          className="absolute top-[3px] h-[6px] w-[6px] rounded-full transition-all"
          style={{ left: on ? "8px" : "2px", background: on ? "#fff" : "var(--color-ink-soft)" }}
        />
      </span>
      {label}
    </button>
  );
}

/* ── 作品显影卡：封面 hover 显影 + 状态章 + mono meta ── */
function DevelopCard({ run, delay }: { run: WorkbenchRun; delay: number }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

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
            className="cover-img absolute inset-0 h-full w-full object-cover brightness-[.42] saturate-[.9] group-hover:brightness-100 group-hover:saturate-105"
          />
        ) : (
          <div
            className="cover-img absolute inset-0 brightness-[.42] saturate-[.9] transition-[filter] duration-500 group-hover:brightness-100 group-hover:saturate-100"
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
        {/* 渐变叠加标题 */}
        <div className="absolute inset-0 flex items-end bg-gradient-to-b from-transparent from-55% to-[#0a0908]/70 p-3.5 transition-opacity duration-300">
          <p className="line-clamp-2 text-[15px] font-bold leading-snug text-white [text-shadow:0_1px_8px_rgba(0,0,0,.5)]">
            {run.topic}
          </p>
        </div>
        {/* 状态章 */}
        <span
          className={`absolute left-2.5 top-2.5 rounded-[5px] border px-2 py-[3px] font-mono text-[10px] tracking-[0.1em] backdrop-blur-[4px] ${stampClass} ${
            run.status === "running" ? "animate-pulse" : ""
          }`}
        >
          {stampText}
        </span>
      </div>
      {/* meta 行 */}
      <div className="flex items-center justify-between px-3 py-2 font-mono text-[11px] text-ink-faint">
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
