"use client";

import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Film,
  Layers3,
  PackageOpen,
  Sparkles,
} from "lucide-react";
import type { ReactNode } from "react";
import type { Channel, ProductionJob } from "@/lib/types";
import styles from "./attention-center.module.css";

type AttentionCenterProps = {
  channels: Channel[];
  jobs: ProductionJob[];
  onQueue: (status: string) => void;
  onLibrary: () => void;
  onChannel: (channel: Channel) => void;
  onAssistant: () => void;
};

export function AttentionCenter({
  channels,
  jobs,
  onQueue,
  onLibrary,
  onChannel,
  onAssistant,
}: AttentionCenterProps) {
  const failed = jobs.filter((job) => job.status === "failed").length;
  const storyboards = jobs.filter((job) => job.status === "awaiting_storyboard").length;
  const reviews = channels.reduce((sum, channel) => sum + channel.review_pending, 0);
  const lowStock = channels
    .filter((channel) => channel.enabled && !channel.paused && channel.ready < channel.inventory.ready_target)
    .sort((left, right) => {
      const leftGap = left.inventory.ready_target - left.ready;
      const rightGap = right.inventory.ready_target - right.ready;
      return rightGap - leftGap;
    });
  const quiet = !failed && !storyboards && !reviews && !lowStock.length;

  return (
    <section className={styles.center} aria-labelledby="attention-title">
      <header>
        <div>
          <span><Sparkles size={13} /> NOW / NEXT</span>
          <h2 id="attention-title">现在最值得处理的事</h2>
        </div>
        <button type="button" className={styles.assistant} onClick={onAssistant}>
          <Sparkles size={14} />交给 AI 制片规划
        </button>
      </header>

      {quiet ? (
        <div className={styles.clear}>
          <CheckCircle2 size={20} />
          <div><strong>生产台当前没有阻塞项</strong><span>库存、分镜和审核门禁都在健康区间。</span></div>
        </div>
      ) : (
        <div className={styles.grid}>
          {failed ? <ActionCard icon={<AlertTriangle />} tone="danger" value={failed} title="最近失败任务" detail="基于最近任务；查看错误并按已有进度重试" action="去处理" onClick={() => onQueue("failed")} /> : null}
          {storyboards ? <ActionCard icon={<Layers3 />} tone="warning" value={storyboards} title="最近待确认分镜" detail="基于最近任务；确认后才会继续生成" action="去确认" onClick={() => onQueue("awaiting_storyboard")} /> : null}
          {reviews ? <ActionCard icon={<Film />} tone="accent" value={reviews} title="等待审核" detail="集中播放、通过或驳回成片" action="去审核" onClick={onLibrary} /> : null}
          {lowStock.length ? <ActionCard icon={<PackageOpen />} tone="neutral" value={lowStock.length} title="库存低于水位" detail={`${lowStock[0].name} 等频道需要关注`} action="看频道" onClick={() => onChannel(lowStock[0])} /> : null}
        </div>
      )}
    </section>
  );
}

function ActionCard({ icon, tone, value, title, detail, action, onClick }: {
  icon: ReactNode;
  tone: "danger" | "warning" | "accent" | "neutral";
  value: number;
  title: string;
  detail: string;
  action: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className={`${styles.card} ${styles[tone]}`} onClick={onClick}>
      <span className={styles.icon}>{icon}</span>
      <strong>{value}</strong>
      <div><b>{title}</b><small>{detail}</small></div>
      <em>{action}<ArrowRight size={12} /></em>
    </button>
  );
}
