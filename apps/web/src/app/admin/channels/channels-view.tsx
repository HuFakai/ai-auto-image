"use client";

import { useCallback, useState } from "react";
import type { ChannelView } from "@/lib/types";
import { ChannelForm, TYPE_LABEL } from "../channel-form";

interface ChannelsPayload {
  channels: ChannelView[];
  providerMode: string;
  providerLabel: string;
}

type TestState = { ok: boolean; detail: string } | "loading" | null;

/** 模型渠道管理（自原设置页迁入；交互一致） */
export function ChannelsView({ initial }: { initial: ChannelsPayload }) {
  const [data, setData] = useState<ChannelsPayload>(initial);
  const [editing, setEditing] = useState<ChannelView | "new" | null>(null);
  const [tests, setTests] = useState<Record<string, TestState>>({});

  const reload = useCallback(async () => {
    const response = await fetch("/api/channels", { cache: "no-store" });
    if (response.ok) setData((await response.json()) as ChannelsPayload);
  }, []);

  async function toggle(channel: ChannelView) {
    await fetch(`/api/channels/${channel.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: !channel.enabled }),
    });
    await reload();
  }

  async function removeChannel(channel: ChannelView) {
    if (!window.confirm(`删除渠道「${channel.name}」？密钥将一并清除。`)) return;
    await fetch(`/api/channels/${channel.id}`, { method: "DELETE" });
    await reload();
  }

  async function move(channel: ChannelView, direction: -1 | 1) {
    const sameType = data.channels.filter((c) => c.type === channel.type);
    const index = sameType.findIndex((c) => c.id === channel.id);
    const target = sameType[index + direction];
    if (!target) return;
    const ids = sameType.map((c) => c.id);
    [ids[index], ids[index + direction]] = [ids[index + direction]!, ids[index]!];
    await fetch("/api/channels/reorder", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    await reload();
  }

  async function test(channel: ChannelView) {
    setTests((prev) => ({ ...prev, [channel.id]: "loading" }));
    const response = await fetch(`/api/channels/${channel.id}/test`, { method: "POST" });
    const result = (await response.json()) as { ok?: boolean; detail?: string };
    setTests((prev) => ({
      ...prev,
      [channel.id]: { ok: Boolean(result.ok), detail: result.detail ?? "" },
    }));
  }

  return (
    <div className="space-y-8">
      <p className="text-xs leading-relaxed text-ink-soft">
        渠道密钥加密落库（只显示末四位），保存即时生效。当前生效：
        <span className="ml-1 font-mono text-xs text-ink">{data.providerLabel}</span>
      </p>

      {(["text", "image"] as const).map((type) => {
        const list = data.channels.filter((c) => c.type === type);
        return (
          <section key={type}>
            <div className="rule-double mb-2 flex items-baseline justify-between pt-2">
              <h2 className="font-display text-lg font-bold">{TYPE_LABEL[type]}</h2>
              <span className="kicker">
                {list.filter((c) => c.enabled).length} 启用 / {list.length}
              </span>
            </div>
            {list.length === 0 && (
              <p className="mb-2 rounded-xl border border-dashed border-line-dark bg-paper-card/40 px-5 py-8 text-center text-sm text-ink-faint">
                暂无{TYPE_LABEL[type]}，未配置时使用 Mock。
              </p>
            )}
            <ul className="space-y-2">
              {list.map((channel, index) => (
                <li
                  key={channel.id}
                  className="rounded-xl border border-line bg-paper-card px-4 py-3.5 transition-colors hover:border-line-dark"
                >
                  <div className="flex items-center gap-4">
                    <div className="flex w-[190px] shrink-0 items-center gap-2.5 max-md:w-auto max-md:min-w-0">
                      <span className="shrink-0 font-mono text-[11px] text-ink-faint">
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <span className="font-display min-w-0 truncate text-[15px] font-bold">
                        {channel.name}
                      </span>
                      {channel.type === "image" && channel.imageEditSupport && (
                        <span className="stamp stamp-quiet shrink-0 text-[10px] text-seal">图生图</span>
                      )}
                      {!channel.enabled && (
                        <span className="stamp stamp-quiet shrink-0 text-[10px] text-ink-faint">停用</span>
                      )}
                    </div>
                    <div
                      className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-faint"
                      title={[channel.model ?? "—", channel.baseUrl, channel.apiKeyHint].join(" · ")}
                    >
                      <span className="text-ink-soft">{channel.model ?? "—"}</span>
                      {" · "}
                      {channel.baseUrl.replace(/^https?:\/\//, "")}
                      {" · "}
                      {channel.apiKeyHint}
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <button
                        className="btn-ghost px-2.5 py-1 font-mono text-[11px]"
                        onClick={() => void test(channel)}
                        disabled={tests[channel.id] === "loading"}
                      >
                        {tests[channel.id] === "loading" ? "测试中…" : "测试"}
                      </button>
                      <button
                        className="btn-ghost px-2.5 py-1 font-mono text-[11px]"
                        onClick={() => setEditing(channel)}
                      >
                        编辑
                      </button>
                      <button
                        className="btn-ghost px-2.5 py-1 font-mono text-[11px]"
                        onClick={() => void toggle(channel)}
                      >
                        {channel.enabled ? "停用" : "启用"}
                      </button>
                      <button
                        className="btn-ghost px-1.5 py-1 font-mono text-[11px]"
                        onClick={() => void move(channel, -1)}
                        disabled={index === 0}
                        title="上移（优先级更高）"
                      >
                        ↑
                      </button>
                      <button
                        className="btn-ghost px-1.5 py-1 font-mono text-[11px]"
                        onClick={() => void move(channel, 1)}
                        disabled={index === list.length - 1}
                        title="下移"
                      >
                        ↓
                      </button>
                      <button
                        className="btn-ghost px-2.5 py-1 font-mono text-[11px] hover:!border-seal hover:!text-seal"
                        onClick={() => void removeChannel(channel)}
                      >
                        删除
                      </button>
                    </div>
                  </div>
                  {tests[channel.id] && tests[channel.id] !== "loading" && (
                    <p
                      className={`mt-2 pl-11 font-mono text-[11px] ${
                        (tests[channel.id] as { ok: boolean }).ok ? "text-[#5FA36B]" : "text-seal"
                      }`}
                    >
                      {(tests[channel.id] as { ok: boolean }).ok ? "✓ " : "✗ "}
                      {(tests[channel.id] as { detail: string }).detail}
                    </p>
                  )}
                </li>
              ))}
            </ul>
            <button
              className="btn-ink mt-4 px-5 py-2 font-mono text-xs tracking-[0.15em]"
              onClick={() => setEditing("new")}
            >
              + 添加{TYPE_LABEL[type]}
            </button>
          </section>
        );
      })}

      {editing && (
        <ChannelForm
          editing={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await reload();
          }}
        />
      )}
    </div>
  );
}
