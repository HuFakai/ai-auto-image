"use client";

import { useEffect, useState } from "react";

interface AssetRow {
  id: string;
  projectId: string | null;
  kind: string;
  slideIndex: number | null;
  mimeType: string;
  width: number;
  height: number;
  bytes: number;
  createdAt: string;
  meta: string | null;
}

const KIND_LABEL: Record<string, string> = {
  native: "生成图",
  generated: "视觉层",
  composite: "合成页",
  export: "导出包",
  upload: "上传",
  reference: "参考图",
};

export default function LibraryPage() {
  const [assets, setAssets] = useState<AssetRow[]>([]);
  const [kind, setKind] = useState("");
  const [q, setQ] = useState("");
  const [projectTitles, setProjectTitles] = useState<Record<string, string>>({});

  useEffect(() => {
    fetch("/api/projects")
      .then((r) => r.json())
      .then((j) => setProjectTitles(Object.fromEntries((j.projects ?? []).map((p: { id: string; title: string }) => [p.id, p.title]))));
  }, []);

  useEffect(() => {
    const params = new URLSearchParams();
    if (kind) params.set("kind", kind);
    if (q) params.set("q", q);
    const t = setTimeout(() => {
      fetch(`/api/library?${params}`)
        .then((r) => r.json())
        .then((j) => setAssets(j.assets ?? []));
    }, 250);
    return () => clearTimeout(t);
  }, [kind, q]);

  return (
    <div className="rise">
      <h1 className="font-display text-3xl font-bold tracking-tight">资产库</h1>
      <p className="mt-1 text-sm text-ink-2">每个资产保留来源血缘：项目、运行、页码与生成模式可追溯。</p>

      <div className="mt-6 mb-5 flex flex-wrap items-center gap-2">
        <input className="input max-w-xs" placeholder="搜索项目名 / 元数据 / ID…" value={q} onChange={(e) => setQ(e.target.value)} />
        <button onClick={() => setKind("")} className={`chip cursor-pointer ${kind === "" ? "chip-accent" : ""}`}>
          全部
        </button>
        {Object.entries(KIND_LABEL).map(([k, label]) => (
          <button key={k} onClick={() => setKind(k)} className={`chip cursor-pointer ${kind === k ? "chip-accent" : ""}`}>
            {label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {assets.map((a) => (
          <div key={a.id} className="card !cursor-default overflow-hidden">
            {a.kind === "export" ? (
              <a href={`/api/exports/${a.id}/download`} className="flex aspect-square items-center justify-center bg-paper-2">
                <span className="chip chip-moss">ZIP 下载</span>
              </a>
            ) : a.mimeType.startsWith("image/") ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={`/api/assets/${a.id}`} alt="" className="aspect-square w-full object-cover" />
            ) : (
              <div className="flex aspect-square items-center justify-center bg-paper-2 text-xs text-ink-3">{a.mimeType}</div>
            )}
            <div className="p-2.5">
              <div className="flex items-center gap-1.5">
                <span className="chip">{KIND_LABEL[a.kind] ?? a.kind}</span>
                {a.slideIndex !== null && <span className="text-[10px] text-ink-3">P{a.slideIndex + 1}</span>}
              </div>
              <div className="mt-1.5 line-clamp-1 text-xs text-ink-2">{a.projectId ? projectTitles[a.projectId] ?? a.projectId : "—"}</div>
              <div className="text-[10px] text-ink-3">
                {a.width}×{a.height} · {(a.bytes / 1024).toFixed(0)}KB
              </div>
            </div>
          </div>
        ))}
        {assets.length === 0 && <div className="col-span-full py-20 text-center text-sm text-ink-3">暂无资产</div>}
      </div>
    </div>
  );
}
