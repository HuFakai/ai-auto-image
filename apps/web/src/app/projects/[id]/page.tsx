"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";

interface Slide {
  index: number;
  role: string;
  headline: string;
  body: string[];
  visualIntent: string;
  assetId?: string;
  revision: number;
}
interface Storyboard {
  title: string;
  slides: Slide[];
}
interface Project {
  id: string;
  title: string;
  recipeId: string;
  platform: string;
  aspectRatio: string;
  status: string;
  textRenderingMode: string;
  themeId: string;
  selectedTitle: string | null;
  storyboard: string | null;
  brief: string | null;
  imageConcurrency: number;
  productData: string | null;
  bookData: string | null;
}
interface RunRow {
  id: string;
  status: string;
  concurrencyRequested: number;
  concurrencyEffective: number;
  estimatedCostCny: number | null;
  actualCostCny: number | null;
  error: string | null;
}
interface NodeRunRow {
  nodeKey: string;
  status: string;
  attempt: number;
  errorSummary: string | null;
}
interface QualityIssue {
  slideIndex?: number;
  check: string;
  severity: string;
  message: string;
}

const NODE_LABEL: Record<string, string> = {
  "parse-input": "解析输入",
  "generate-brief": "内容 Brief",
  "generate-storyboard": "Storyboard",
  "generate-images": "生成图片",
  "render-slides": "合成渲染",
  "quality-check": "质量检查",
  "generate-characters": "角色 Bible",
  "generate-scenes": "场景 Bible",
  "generate-comic-storyboard": "漫画分镜",
  "generate-panels": "生成漫画页",
};

const THEMES = [
  { id: "minimal-knowledge", name: "极简知识" },
  { id: "magazine", name: "杂志编辑" },
  { id: "high-contrast", name: "高对比营销" },
  { id: "morandi", name: "莫兰迪生活" },
  { id: "tech-dark", name: "科技深色" },
  { id: "book-paper", name: "图书纸张" },
];

export default function ProjectPage() {
  const params = useParams<{ id: string }>();
  const projectId = params.id;
  const [project, setProject] = useState<Project | null>(null);
  const [run, setRun] = useState<RunRow | null>(null);
  const [nodes, setNodes] = useState<NodeRunRow[]>([]);
  const [assets, setAssets] = useState<Array<{ id: string; slideIndex: number | null; kind: string }>>([]);
  const [quality, setQuality] = useState<{ passed: boolean; issues: QualityIssue[] } | null>(null);
  const [selected, setSelected] = useState(0);
  const [headline, setHeadline] = useState("");
  const [bodyText, setBodyText] = useState("");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [exportInfo, setExportInfo] = useState<{ assetId: string; fileCount: number } | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const storyboard: Storyboard | null = project?.storyboard ? JSON.parse(project.storyboard) : null;
  const isComic = storyboard !== null && "panels" in storyboard;
  const slides: Slide[] = isComic
    ? ((storyboard as unknown as { panels: Array<Record<string, unknown>> }).panels.map((p, i) => ({
        index: i,
        role: "content",
        headline: String(p.action ?? "").slice(0, 24) || `第 ${i + 1} 格`,
        body: ((p.dialogue as Array<{ text: string }> | undefined) ?? []).map((d) => d.text),
        visualIntent: "",
        revision: 0,
        assetId: assets.find((a) => a.slideIndex === i)?.id,
      })) as Slide[])
    : (storyboard?.slides ?? []);

  const load = useCallback(async () => {
    const res = await fetch(`/api/projects/${projectId}`);
    if (!res.ok) return;
    const json = await res.json();
    setProject(json.project);
    setRun(json.latestRun);
    setNodes(json.latestRun ? json.nodes.filter((n: { runId: string }) => n.runId === json.latestRun.id) : []);
    setAssets(json.assets ?? []);
    setQuality(json.qualityReport);
    if (json.project?.status === "GENERATING" || json.latestRun?.status === "GENERATING") {
      if (!pollRef.current) {
        pollRef.current = setInterval(load, 2500);
      }
    } else if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, [projectId]);

  useEffect(() => {
    load();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [load]);

  useEffect(() => {
    const s = slides[selected];
    if (s) {
      setHeadline(s.headline);
      setBodyText(s.body.join("\n"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, project?.storyboard]);

  const generating = project?.status === "GENERATING";

  async function startGenerate() {
    setBusy("generate");
    setNotice("");
    const res = await fetch(`/api/projects/${projectId}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const json = await res.json();
    setBusy("");
    if (!res.ok) {
      setNotice(`启动失败：${json.error}`);
      return;
    }
    setNotice(`已启动生成（实际生效并发 ${json.concurrency?.effective ?? 1}，预估 ${((json.estimatedCostCents ?? 0) / 100).toFixed(2)} 元）`);
    setTimeout(load, 800);
  }

  async function saveCopy() {
    setBusy("save");
    const res = await fetch(`/api/projects/${projectId}/slides/${selected}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ headline, body: bodyText.split("\n").filter(Boolean) }),
    });
    const json = await res.json();
    setBusy("");
    setNotice(
      json.requiresRegeneration
        ? "文案已保存。原生文字模式下需要重新生成本页图片才会生效（产生一次图片调用费用）。"
        : "文案已保存，本页已用程序重新渲染（未产生 AI 费用）。"
    );
    load();
  }

  async function regenerateSlide() {
    if (!confirm(`重新生成第 ${selected + 1} 页图片？将产生一次图片模型调用费用。`)) return;
    setBusy(`regen-${selected}`);
    await fetch(`/api/projects/${projectId}/slides/${selected}`, { method: "POST" });
    setBusy("");
    setNotice("本页已重新生成。");
    load();
  }

  async function switchTheme(themeId: string) {
    setBusy("theme");
    await fetch(`/api/projects/${projectId}/render`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ themeId }),
    });
    setBusy("");
    setNotice("主题已切换并重新渲染（确定性模式；未产生 AI 费用）。");
    load();
  }

  async function doExport() {
    setBusy("export");
    const res = await fetch(`/api/projects/${projectId}/export`, { method: "POST" });
    const json = await res.json();
    setBusy("");
    if (res.ok) {
      setExportInfo({ assetId: json.assetId, fileCount: json.fileCount });
      setNotice("导出包已生成。");
      load();
    } else {
      setNotice(`导出失败：${json.error}`);
    }
  }

  async function pushDraft() {
    if (!confirm(`确认将「${draftTitle}」写入平台草稿？将执行外部写操作。`)) return;
    setBusy("draft");
    const platform = project?.platform === "wechat" ? "wechat" : "xiaohongshu";
    const accountsRes = await fetch("/api/platform");
    const { accounts } = (await accountsRes.json()) as { accounts: Array<{ id: string; platform: string; alias: string }> };
    const account = accounts.find((a) => a.platform === platform);
    if (!account) {
      setBusy("");
      setNotice(`还没有 ${platform} 平台账号，请先在「运营」页添加。`);
      return;
    }
    const res = await fetch(`/api/projects/${projectId}/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platform,
        accountId: account.id,
        scope: "draft",
        title: draftTitle,
        body: draftBody,
        tags: [],
        authorization: { userId: "user_default", accountAlias: account.alias, confirm: true },
      }),
    });
    const json = await res.json();
    setBusy("");
    setNotice(res.ok ? json.message : `草稿写入失败：${json.error}`);
  }

  if (!project) {
    return <div className="py-32 text-center text-ink-3">加载中…</div>;
  }

  const selectedAsset = slides[selected]?.assetId;

  return (
    <div className="rise">
      {/* header */}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link href="/" className="text-xs text-ink-3 hover:text-ink">
            ← 返回项目列表
          </Link>
          <h1 className="font-display mt-1 text-3xl font-bold tracking-tight">{project.title}</h1>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <span className={`chip ${project.status === "GENERATING" ? "chip-accent pulse-dot" : project.status === "READY_TO_EXPORT" ? "chip-moss" : ""}`}>
              {project.status}
            </span>
            <span className="chip">{project.textRenderingMode === "native" ? "原生文字" : "确定性文字"}</span>
            <span className="chip">{project.aspectRatio}</span>
            {run && <span className="chip">费用 ¥{((run.actualCostCny ?? 0) / 100).toFixed(2)} / 预估 ¥{((run.estimatedCostCny ?? 0) / 100).toFixed(2)}</span>}
            {run && <span className="chip">并发 {run.concurrencyEffective}（请求 {run.concurrencyRequested}）</span>}
          </div>
        </div>
        <div className="flex gap-2">
          {project.status === "DRAFT" && (
            <button onClick={startGenerate} disabled={busy !== ""} className="btn btn-accent">
              {busy === "generate" ? "启动中…" : "开始生成"}
            </button>
          )}
          {project.status === "FAILED_RETRYABLE" && (
            <button onClick={startGenerate} disabled={busy !== ""} className="btn btn-accent">
              重试失败节点
            </button>
          )}
          <button onClick={doExport} disabled={busy !== "" || slides.length === 0} className="btn btn-primary">
            {busy === "export" ? "打包中…" : "导出 ZIP"}
          </button>
        </div>
      </div>

      {notice && <div className="mb-5 rounded-[10px] border border-line bg-white px-4 py-3 text-sm">{notice}</div>}

      {/* node progress */}
      {(generating || nodes.length > 0) && (
        <div className="card !cursor-default mb-6 p-4">
          <div className="flex flex-wrap items-center gap-3">
            {Object.keys(NODE_LABEL)
              .filter((k) => (isComic ? !["generate-storyboard", "generate-images", "render-slides"].includes(k) : !["generate-characters", "generate-scenes", "generate-comic-storyboard", "generate-panels"].includes(k)))
              .map((key) => {
                const n = nodes.find((x) => x.nodeKey === key);
                const status = n?.status ?? "PENDING";
                return (
                  <div key={key} className="flex items-center gap-1.5">
                    <span
                      className={`inline-block h-2 w-2 rounded-full ${
                        status === "SUCCEEDED" ? "bg-moss" : status === "RUNNING" ? "bg-accent pulse-dot" : status === "FAILED_RETRYABLE" || status === "FAILED_FINAL" ? "bg-accent" : "bg-ink-3/40"
                      }`}
                    />
                    <span className={`text-xs ${status === "PENDING" ? "text-ink-3" : "font-semibold"}`}>{NODE_LABEL[key]}</span>
                    {n && n.attempt > 1 && <span className="text-[10px] text-accent">×{n.attempt}</span>}
                  </div>
                );
              })}
            {run?.error && <span className="ml-auto max-w-md truncate text-xs text-accent">{run.error}</span>}
          </div>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[88px_1fr_340px]">
        {/* thumbnail rail */}
        <div className="flex gap-3 overflow-x-auto pb-2 lg:flex-col lg:overflow-visible">
          {slides.map((s) => (
            <button
              key={s.index}
              onClick={() => setSelected(s.index)}
              className={`relative shrink-0 overflow-hidden rounded-[10px] border-2 transition-colors ${
                selected === s.index ? "border-accent" : "border-line hover:border-ink-3"
              }`}
              style={{ width: 84, aspectRatio: project.aspectRatio.replace(":", "/") }}
            >
              {s.assetId ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={`/api/assets/${s.assetId}`} alt={s.headline} className="h-full w-full object-cover" />
              ) : (
                <span className="flex h-full items-center justify-center bg-paper-2 font-display text-xl text-ink-3">{s.index + 1}</span>
              )}
              <span className="absolute bottom-1 right-1 rounded bg-ink/70 px-1 text-[9px] text-paper">{s.index + 1}</span>
            </button>
          ))}
          {slides.length === 0 && (
            <div className="flex h-28 w-[84px] items-center justify-center rounded-[10px] border border-dashed border-line text-ink-3">待生成</div>
          )}
        </div>

        {/* canvas */}
        <div>
          <div className="card !cursor-default overflow-hidden p-0">
            <div className="flex min-h-[420px] items-center justify-center bg-paper-2" style={{ maxHeight: 640 }}>
              {selectedAsset ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={`/api/assets/${selectedAsset}`} alt={slides[selected]?.headline ?? ""} className="max-h-[640px] w-auto max-w-full" />
              ) : (
                <span className="text-sm text-ink-3">{generating ? "本页生成中…" : "本页还没有图片"}</span>
              )}
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-ink-3">
            <span>
              第 {selected + 1} / {slides.length} 页 · {slides[selected]?.role}
            </span>
            {project.textRenderingMode === "native" && slides[selected] && (
              <button onClick={regenerateSlide} disabled={busy !== ""} className="btn btn-ghost !py-1 !text-xs">
                {busy === `regen-${selected}` ? "重新生成中（约 20 秒）…" : "重新生成本页图片（产生费用）"}
              </button>
            )}
          </div>
        </div>

        {/* right panel */}
        <div className="space-y-5">
          {/* copy editor */}
          {slides[selected] && !isComic && (
            <div className="card !cursor-default p-4">
              <h3 className="font-display mb-3 text-sm font-bold">页面文案</h3>
              <label className="label">标题</label>
              <input className="input mb-3" value={headline} onChange={(e) => setHeadline(e.target.value)} />
              <label className="label">正文（每行一条）</label>
              <textarea className="textarea min-h-28" value={bodyText} onChange={(e) => setBodyText(e.target.value)} />
              <button onClick={saveCopy} disabled={busy !== ""} className="btn btn-primary mt-3 w-full">
                {busy === "save" ? "保存中…" : project.textRenderingMode === "native" ? "保存文案（原生模式需重新生成图片）" : "保存并重新渲染（无 AI 费用）"}
              </button>
            </div>
          )}

          {/* theme switch */}
          <div className="card !cursor-default p-4">
            <h3 className="font-display mb-3 text-sm font-bold">视觉主题</h3>
            <div className="flex flex-wrap gap-1.5">
              {THEMES.map((t) => (
                <button
                  key={t.id}
                  onClick={() => switchTheme(t.id)}
                  disabled={busy !== ""}
                  className={`chip cursor-pointer ${project.themeId === t.id ? "chip-accent" : ""}`}
                >
                  {t.name}
                </button>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-ink-3">确定性模式下切换主题立即重新渲染，不产生 AI 费用；原生模式下主题影响后续生成。</p>
          </div>

          {/* quality */}
          {quality && (
            <div className="card !cursor-default p-4">
              <h3 className="font-display mb-3 flex items-center gap-2 text-sm font-bold">
                质量检查
                <span className={`chip ${quality.passed ? "chip-moss" : "chip-accent"}`}>{quality.passed ? "通过" : "有问题"}</span>
              </h3>
              <ul className="space-y-1.5 text-xs">
                {quality.issues.slice(0, 12).map((i, idx) => (
                  <li key={idx} className={i.severity === "error" ? "text-accent" : i.severity === "warning" ? "text-ink" : "text-ink-2"}>
                    [{i.severity === "error" ? "错误" : i.severity === "warning" ? "警告" : "提示"}]
                    {i.slideIndex !== undefined ? ` 第${i.slideIndex + 1}页 ·` : ""} {i.message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* export */}
          <div className="card !cursor-default p-4">
            <h3 className="font-display mb-2 text-sm font-bold">导出</h3>
            {exportInfo ? (
              <a href={`/api/exports/${exportInfo.assetId}/download`} className="btn btn-primary w-full">
                下载 ZIP（{exportInfo.fileCount} 个文件）
              </a>
            ) : (
              <button onClick={doExport} disabled={busy !== "" || slides.length === 0} className="btn btn-primary w-full">
                {busy === "export" ? "打包中…" : "生成导出包"}
              </button>
            )}
            <p className="mt-2 text-[11px] text-ink-3">ZIP 内含按序图片、发布文案 Markdown 和发布清单。</p>
          </div>

          {/* draft push */}
          <div className="card !cursor-default p-4">
            <h3 className="font-display mb-2 text-sm font-bold">写入平台草稿</h3>
            <label className="label">草稿标题</label>
            <input className="input mb-3" value={draftTitle} onChange={(e) => setDraftTitle(e.target.value)} placeholder={project.selectedTitle ?? "标题"} />
            <label className="label">草稿正文</label>
            <textarea className="textarea min-h-20" value={draftBody} onChange={(e) => setDraftBody(e.target.value)} placeholder="正文与标签" />
            <button
              onClick={() => {
                if (!draftTitle) setDraftTitle(project.selectedTitle ?? "");
                pushDraft();
              }}
              disabled={busy !== ""}
              className="btn btn-ghost mt-3 w-full"
            >
              {busy === "draft" ? "写入中…" : "确认授权并写入草稿"}
            </button>
            <p className="mt-2 text-[11px] text-ink-3">
              终稿确认不等于发布授权；写草稿前会要求显式确认，重复提交会被幂等键拦截。
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
