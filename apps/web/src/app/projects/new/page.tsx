"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

const RECIPES = [
  { id: "knowledge-card", name: "知识卡片", desc: "主题/文章 → 封面、知识点、案例、总结、CTA", icon: "卡" },
  { id: "article-breakdown", name: "文章拆解", desc: "长文 → 摘要、观点、证据、结论卡片", icon: "拆" },
  { id: "book-recommendation", name: "图书推荐", desc: "书名+摘录 → 推荐理由、核心观点、行动建议", icon: "书" },
  { id: "product-promo", name: "产品宣传", desc: "商品资料 → 封面、痛点、卖点、参数、CTA", icon: "品" },
  { id: "science-comic", name: "科普漫画", desc: "科普主题 → 角色连续的多页漫画", icon: "漫" },
];

const PLATFORMS = [
  { id: "xiaohongshu", name: "小红书", ratio: "3:4", note: "3:4 · ≤20字标题" },
  { id: "douyin", name: "抖音图文", ratio: "9:16", note: "9:16 · 竖屏" },
  { id: "wechat", name: "公众号", ratio: "16:9", note: "16:9 · 横图" },
];

const THEMES = [
  { id: "minimal-knowledge", name: "极简知识" },
  { id: "magazine", name: "杂志编辑" },
  { id: "high-contrast", name: "高对比营销" },
  { id: "morandi", name: "莫兰迪生活" },
  { id: "tech-dark", name: "科技深色" },
  { id: "book-paper", name: "图书纸张" },
];

const STEPS = ["输入", "内容类型", "平台与风格", "文字模式", "确认"];

export default function NewProjectPage() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [inputKind, setInputKind] = useState<"topic" | "article" | "product" | "book">("topic");
  const [inputText, setInputText] = useState("");
  const [productData, setProductData] = useState("");
  const [bookData, setBookData] = useState("");
  const [recipeId, setRecipeId] = useState("knowledge-card");
  const [platform, setPlatform] = useState("xiaohongshu");
  const [aspectRatio, setAspectRatio] = useState("3:4");
  const [themeId, setThemeId] = useState("minimal-knowledge");
  const [mode, setMode] = useState<"native" | "deterministic">("native");
  const [concurrency, setConcurrency] = useState(1);
  const [brandKits, setBrandKits] = useState<Array<{ id: string; name: string }>>([]);
  const [brandKitId, setBrandKitId] = useState("");
  const [title, setTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/brand-kits")
      .then((r) => r.json())
      .then((j) => setBrandKits(j.brandKits ?? []))
      .catch(() => {});
  }, []);

  const canNext = useMemo(() => {
    if (step === 0) {
      if (inputKind === "topic") return inputText.trim().length >= 2;
      if (inputKind === "article") return inputText.trim().length >= 50;
      if (inputKind === "product") return productData.trim().length >= 10;
      if (inputKind === "book") return bookData.trim().length >= 10;
    }
    return true;
  }, [step, inputKind, inputText, productData, bookData]);

  function pickPlatform(p: (typeof PLATFORMS)[number]) {
    setPlatform(p.id);
    setAspectRatio(p.ratio);
    if (p.id === "wechat") setAspectRatio("16:9");
  }

  async function submit() {
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title || undefined,
          recipeId,
          platform,
          aspectRatio,
          textRenderingMode: mode,
          themeId,
          brandKitId: brandKitId || undefined,
          inputKind,
          inputText,
          productData: inputKind === "product" ? safeJson(productData) : undefined,
          bookData: inputKind === "book" ? safeJson(bookData) : undefined,
          imageConcurrency: concurrency,
        }),
      });
      const json = (await res.json()) as { project?: { id: string }; error?: string };
      if (!res.ok || !json.project) throw new Error(json.error ?? "创建失败");
      router.push(`/projects/${json.project.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建失败");
      setSubmitting(false);
    }
  }

  return (
    <div className="rise mx-auto max-w-3xl">
      <h1 className="font-display text-3xl font-bold tracking-tight">新建项目</h1>

      {/* step rail */}
      <div className="mt-6 mb-8 flex items-center gap-1">
        {STEPS.map((s, i) => (
          <div key={s} className="flex flex-1 items-center gap-1">
            <button
              onClick={() => i < step && setStep(i)}
              className={`flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
                i === step ? "bg-ink text-paper" : i < step ? "cursor-pointer text-accent" : "text-ink-3"
              }`}
            >
              <span className={`inline-flex h-5 w-5 items-center justify-center rounded-full border text-[10px] ${i === step ? "border-paper" : i < step ? "border-accent" : "border-line"}`}>
                {i + 1}
              </span>
              {s}
            </button>
            {i < STEPS.length - 1 && <div className={`h-px flex-1 ${i < step ? "bg-accent" : "bg-line"}`} />}
          </div>
        ))}
      </div>

      {step === 0 && (
        <section className="space-y-5">
          <div className="flex gap-2">
            {(
              [
                ["topic", "主题"],
                ["article", "文章"],
                ["product", "商品"],
                ["book", "图书"],
              ] as const
            ).map(([k, label]) => (
              <button key={k} onClick={() => setInputKind(k)} className={`chip cursor-pointer ${inputKind === k ? "chip-accent" : ""}`}>
                {label}
              </button>
            ))}
          </div>
          {(inputKind === "topic" || inputKind === "article") && (
            <div>
              <label className="label">{inputKind === "topic" ? "主题或一句话需求" : "粘贴文章或 Markdown"}</label>
              <textarea
                className="textarea min-h-40"
                placeholder={inputKind === "topic" ? "例如：久坐办公族的 5 个拉伸动作" : "粘贴 3000 字以内的文章…"}
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
              />
              {inputKind === "article" && <p className="mt-1 text-xs text-ink-3">{inputText.length} 字</p>}
            </div>
          )}
          {inputKind === "product" && (
            <div>
              <label className="label">商品资料（JSON 或自由文本：名称、卖点、参数、价格）</label>
              <textarea
                className="textarea min-h-40"
                placeholder={'{"name":"保温杯","price":79,"sellingPoints":["316不锈钢","24小时保温"],"audience":"上班族"}'}
                value={productData}
                onChange={(e) => setProductData(e.target.value)}
              />
            </div>
          )}
          {inputKind === "book" && (
            <div>
              <label className="label">图书资料（JSON 或自由文本：书名、作者、简介、摘录）</label>
              <textarea
                className="textarea min-h-40"
                placeholder={'{"title":"纳瓦尔宝典","author":"埃里克·乔根森","excerpt":"…"}'}
                value={bookData}
                onChange={(e) => setBookData(e.target.value)}
              />
            </div>
          )}
        </section>
      )}

      {step === 1 && (
        <section className="grid gap-3 sm:grid-cols-2">
          {RECIPES.map((r) => (
            <button
              key={r.id}
              onClick={() => setRecipeId(r.id)}
              className={`card !cursor-pointer flex items-start gap-3 p-4 text-left ${recipeId === r.id ? "!border-accent shadow-[0_0_0_1px_var(--color-accent)]" : ""}`}
            >
              <span className="font-display mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-paper-2 text-lg font-bold">
                {r.icon}
              </span>
              <span>
                <span className="block font-semibold">{r.name}</span>
                <span className="mt-0.5 block text-xs text-ink-2">{r.desc}</span>
              </span>
            </button>
          ))}
        </section>
      )}

      {step === 2 && (
        <section className="space-y-6">
          <div>
            <label className="label">平台</label>
            <div className="grid gap-3 sm:grid-cols-3">
              {PLATFORMS.map((p) => (
                <button
                  key={p.id}
                  onClick={() => pickPlatform(p)}
                  className={`card !cursor-pointer p-4 text-left ${platform === p.id ? "!border-accent shadow-[0_0_0_1px_var(--color-accent)]" : ""}`}
                >
                  <span className="block font-semibold">{p.name}</span>
                  <span className="mt-0.5 block text-xs text-ink-2">{p.note}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="label">画布比例</label>
              <select className="select" value={aspectRatio} onChange={(e) => setAspectRatio(e.target.value)}>
                {["3:4", "9:16", "1:1", "16:9", "4:3"].map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">视觉主题</label>
              <select className="select" value={themeId} onChange={(e) => setThemeId(e.target.value)}>
                {THEMES.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {brandKits.length > 0 && (
            <div>
              <label className="label">Brand Kit（可选）</label>
              <select className="select" value={brandKitId} onChange={(e) => setBrandKitId(e.target.value)}>
                <option value="">不使用</option>
                {brandKits.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </section>
      )}

      {step === 3 && (
        <section className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <button
              onClick={() => setMode("native")}
              className={`card !cursor-pointer p-4 text-left ${mode === "native" ? "!border-accent shadow-[0_0_0_1px_var(--color-accent)]" : ""}`}
            >
              <span className="flex items-center gap-2 font-semibold">
                模型原生文字 <span className="chip chip-accent">默认</span>
              </span>
              <span className="mt-1 block text-xs leading-relaxed text-ink-2">
                主力图片模型直接生成含中文的完整图片：流程短、融合度高。修改文字需重新生成该页（产生费用）。
              </span>
            </button>
            <button
              onClick={() => setMode("deterministic")}
              className={`card !cursor-pointer p-4 text-left ${mode === "deterministic" ? "!border-accent shadow-[0_0_0_1px_var(--color-accent)]" : ""}`}
            >
              <span className="font-semibold">确定性文字渲染</span>
              <span className="mt-1 block text-xs leading-relaxed text-ink-2">
                AI 只画视觉层，中文由程序精确渲染：文字可编辑、价格绝对可控，每页多一次本地合成。
              </span>
            </button>
          </div>
          <div>
            <label className="label">
              图片生成并发 ·{" "}
              <span className="normal-case text-ink-3">
                服务器安全上限 4；实际生效 = min(请求值, 服务器上限, Provider 限流)
              </span>
            </label>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={1}
                max={4}
                value={concurrency}
                onChange={(e) => setConcurrency(parseInt(e.target.value, 10))}
                className="w-64 accent-[var(--color-accent)]"
              />
              <span className="font-display text-xl font-bold">{concurrency}</span>
              {concurrency > 2 && <span className="chip chip-accent">注意内存峰值</span>}
            </div>
          </div>
        </section>
      )}

      {step === 4 && (
        <section className="space-y-4">
          <div className="card !cursor-default space-y-3 p-5">
            {[
              ["内容类型", RECIPES.find((r) => r.id === recipeId)?.name ?? ""],
              ["平台 / 比例", `${PLATFORMS.find((p) => p.id === platform)?.name} · ${aspectRatio}`],
              ["主题", THEMES.find((t) => t.id === themeId)?.name ?? ""],
              ["文字模式", mode === "native" ? "模型原生文字（默认）" : "确定性文字渲染"],
              ["图片并发", `${concurrency}（实际生效以服务端裁剪为准）`],
              ["Brand Kit", brandKits.find((b) => b.id === brandKitId)?.name ?? "不使用"],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between border-b border-line pb-2 text-sm last:border-0 last:pb-0">
                <span className="text-ink-2">{k}</span>
                <span className="font-semibold">{v}</span>
              </div>
            ))}
          </div>
          <div>
            <label className="label">项目名称（可选，默认取输入前 30 字）</label>
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="给这个项目起个名字" />
          </div>
          {error && <p className="text-sm text-accent">{error}</p>}
        </section>
      )}

      <div className="mt-8 flex justify-between">
        <button onClick={() => setStep(Math.max(0, step - 1))} disabled={step === 0} className="btn btn-ghost">
          上一步
        </button>
        {step < 4 ? (
          <button onClick={() => setStep(step + 1)} disabled={!canNext} className="btn btn-primary">
            下一步
          </button>
        ) : (
          <button onClick={submit} disabled={submitting} className="btn btn-accent">
            {submitting ? "创建中…" : "创建并开始生成"}
          </button>
        )}
      </div>
    </div>
  );
}

function safeJson(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return { raw: trimmed };
    }
  }
  return { raw: trimmed };
}
