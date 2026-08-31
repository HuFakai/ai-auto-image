import { requireUser } from "@/server/auth";
import { getRuntime } from "@/server/runtime";
import { toBrandKitView } from "@/server/brand-kit-views";
import { listRunItems } from "@/server/run-views";
import { Workbench } from "./workbench";
import type { WorkbenchInitial, WorkbenchRun } from "./workbench";
import type { Recipe } from "@aai/shared-schemas";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const user = await requireUser();
  const runtime = await getRuntime();
  const viewer = user.role === "admin" ? null : user.id;

  const [runs, brandKits] = await Promise.all([
    listRunItems(runtime, 20, viewer),
    runtime.brandKitRepo.list().then((rows) => rows.map(toBrandKitView)),
  ]);

  // 补充内容类型（listRunItems 不带 recipe，从冻结的 input 解析一次）
  const recipeByRun = new Map<string, Recipe>();
  for (const row of await runtime.runRepo.listForUser(viewer, 20)) {
    try {
      const input = JSON.parse(row.inputJson) as { recipe?: Recipe };
      if (input.recipe) recipeByRun.set(row.id, input.recipe);
    } catch {
      /* 坏数据跳过，该卡不参与类型筛选 */
    }
  }
  const initialRuns: WorkbenchRun[] = runs.map((run) => ({ ...run, recipe: recipeByRun.get(run.runId) }));

  // 统计行：总数 / 待评审 / 已生成图片（成功运行的页数合计）
  const pendingCount = initialRuns.filter((run) => run.reviewStatus === "pending").length;
  const imageCount = initialRuns
    .filter((run) => run.status === "succeeded")
    .reduce((sum, run) => sum + run.pageCount, 0);

  const initial: WorkbenchInitial = {
    runs: initialRuns,
    providerLabel: runtime.config.providerLabel,
    providerMode: runtime.config.providerMode,
  };

  return (
    <>
      {/* 顶部细栏 */}
      <header className="sticky top-0 z-20 flex h-[52px] items-center gap-3.5 border-b border-line bg-paper/85 px-5 backdrop-blur-md">
        <span className="font-mono text-xs tracking-[0.14em] text-ink-soft">
          工作台 / <b className="font-semibold text-ink">全部作品</b>
        </span>
        <div className="ml-auto flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-[3px] font-mono text-[11px] text-ink-soft">
            <span className="h-1.5 w-1.5 rounded-full bg-[#5fa36b]" />
            渠道在线 · {initial.providerLabel}
          </span>
          <span className="inline-flex items-center rounded-full border border-line px-2.5 py-[3px] font-mono text-[11px] text-ink-soft">
            渠道并发按后台配置
          </span>
        </div>
      </header>

      {/* 统计行 + 作品网格 + 创作条（客户端筛选与交互） */}
      <Workbench
        initial={initial}
        brandKits={brandKits}
        stats={{
          total: initialRuns.length,
          pending: pendingCount,
          images: imageCount,
        }}
      />
    </>
  );
}
