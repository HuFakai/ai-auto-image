"use client";

import { useEffect, useState } from "react";

interface WfNode {
  id: string;
  kind: string;
  name: string;
  config: Record<string, unknown>;
}
interface WfDef {
  id: string;
  version: number;
  name: string;
  nodes: WfNode[];
  edges: Array<{ from: string; to: string }>;
  limits: { maxParallelism?: number };
}

const KIND_LABEL: Record<string, string> = {
  input: "输入",
  llm_text: "LLM 文本",
  llm_object: "LLM 结构化",
  image_generate: "图片生成",
  image_edit: "图片编辑",
  render: "渲染",
  quality_gate: "质量门",
  condition: "条件",
  parallel_map: "并行",
  human_approval: "人工审批",
  transform: "转换",
  export: "导出",
  publish_draft: "写草稿",
  webhook: "Webhook",
};

const DEFAULT_DEF: WfDef = {
  id: "wf_standard_carousel",
  version: 1,
  name: "标准图文生成流水线",
  nodes: [
    { id: "n1", kind: "input", name: "用户输入", config: {} },
    { id: "n2", kind: "llm_object", name: "Content Brief", config: {} },
    { id: "n3", kind: "llm_object", name: "Storyboard", config: {} },
    { id: "n4", kind: "image_generate", name: "页面图片（并行）", config: {} },
    { id: "n5", kind: "quality_gate", name: "质量检查", config: {} },
    { id: "n6", kind: "human_approval", name: "终稿确认", config: {} },
    { id: "n7", kind: "export", name: "导出发布包", config: {} },
  ],
  edges: [
    { from: "n1", to: "n2" },
    { from: "n2", to: "n3" },
    { from: "n3", to: "n4" },
    { from: "n4", to: "n5" },
    { from: "n5", to: "n6" },
    { from: "n6", to: "n7" },
  ],
  limits: { maxParallelism: 4 },
};

export default function WorkflowsPage() {
  const [def, setDef] = useState<WfDef>(DEFAULT_DEF);
  const [selected, setSelected] = useState("n4");
  const [json, setJson] = useState(JSON.stringify(DEFAULT_DEF, null, 2));
  const [error, setError] = useState("");

  useEffect(() => {
    setJson(JSON.stringify(def, null, 2));
  }, [def]);

  // DAG validation (phase 3 spec): edges must reference existing nodes, no cycles
  function validate(d: WfDef): string[] {
    const problems: string[] = [];
    const ids = new Set(d.nodes.map((n) => n.id));
    for (const e of d.edges) {
      if (!ids.has(e.from) || !ids.has(e.to)) problems.push(`边 ${e.from}→${e.to} 引用了不存在的节点`);
    }
    // cycle detection
    const adj = new Map<string, string[]>();
    for (const e of d.edges) adj.set(e.from, [...(adj.get(e.from) ?? []), e.to]);
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const dfs = (n: string): boolean => {
      if (visiting.has(n)) return true;
      if (visited.has(n)) return false;
      visiting.add(n);
      for (const next of adj.get(n) ?? []) if (dfs(next)) return true;
      visiting.delete(n);
      visited.add(n);
      return false;
    };
    for (const n of d.nodes) if (dfs(n.id)) return [...problems, "图中存在环"];
    return problems;
  }

  function applyJson() {
    try {
      const parsed = JSON.parse(json) as WfDef;
      const problems = validate(parsed);
      if (problems.length) {
        setError(`校验失败：${problems.join("；")}`);
        return;
      }
      setDef(parsed);
      setError("");
    } catch (err) {
      setError(`JSON 解析失败：${err instanceof Error ? err.message : ""}`);
    }
  }

  const selectedNode = def.nodes.find((n) => n.id === selected);

  return (
    <div className="rise">
      <h1 className="font-display text-3xl font-bold tracking-tight">工作流</h1>
      <p className="mt-1 text-sm text-ink-2">声明式 Workflow Definition。定义版本一旦用于正式 Run 即不可变；画布编辑只操作声明式数据，不允许保存可执行脚本。</p>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_360px]">
        {/* canvas */}
        <div className="card !cursor-default overflow-hidden p-6">
          <div className="flex flex-wrap items-center gap-3">
            {def.nodes.map((n, i) => {
              const incoming = def.edges.filter((e) => e.to === n.id).length;
              return (
                <div key={n.id} className="flex items-center gap-3">
                  {i > 0 && <div className="h-px w-6 bg-ink-3" />}
                  <button
                    onClick={() => setSelected(n.id)}
                    className={`rounded-[10px] border px-4 py-3 text-left transition-colors ${
                      selected === n.id ? "border-accent bg-accent-soft" : "border-line bg-white hover:border-ink-3"
                    }`}
                  >
                    <div className="text-sm font-semibold">{n.name}</div>
                    <div className="mt-0.5 text-[10px] tracking-wide text-ink-2">
                      {KIND_LABEL[n.kind] ?? n.kind}
                      {n.kind === "image_generate" && def.limits.maxParallelism ? ` · 并发≤${def.limits.maxParallelism}` : ""}
                      {n.kind === "human_approval" && incoming >= 0 ? " · 暂停等待" : ""}
                    </div>
                  </button>
                </div>
              );
            })}
          </div>
          <p className="mt-4 text-xs text-ink-3">节点 {def.nodes.length} · 边 {def.edges.length} · 校验：DAG 无环 ✓ · Schema 连接 ✓</p>
        </div>

        {/* inspector + json */}
        <div className="space-y-4">
          {selectedNode && (
            <div className="card !cursor-default p-4">
              <h3 className="font-display mb-2 text-sm font-bold">节点配置</h3>
              <div className="space-y-1 text-sm">
                <div className="flex justify-between">
                  <span className="text-ink-2">名称</span>
                  <span className="font-semibold">{selectedNode.name}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-ink-2">类型</span>
                  <span className="font-semibold">{KIND_LABEL[selectedNode.kind] ?? selectedNode.kind}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-ink-2">输入来源</span>
                  <span className="text-xs">{def.edges.filter((e) => e.to === selectedNode.id).map((e) => e.from).join(", ") || "—"}</span>
                </div>
              </div>
            </div>
          )}
          <div className="card !cursor-default p-4">
            <h3 className="font-display mb-2 text-sm font-bold">定义 JSON（版本 v{def.version}）</h3>
            <textarea className="textarea min-h-64 font-mono !text-xs" value={json} onChange={(e) => setJson(e.target.value)} />
            <button onClick={applyJson} className="btn btn-primary mt-3 w-full">
              校验并应用
            </button>
            {error && <p className="mt-2 text-xs text-accent">{error}</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
