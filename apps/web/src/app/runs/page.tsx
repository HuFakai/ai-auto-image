import { requireUser } from "@/server/auth";
import { getRuntime } from "@/server/runtime";
import { listRunItems } from "@/server/run-views";
import type { Recipe } from "@aai/shared-schemas";
import { Gallery } from "./gallery";
import type { GalleryRun } from "./gallery";

export const dynamic = "force-dynamic";

/** 作品库为全量浏览,给一个远大于常规列表的上限即可 */
const LIBRARY_LIMIT = 1000;

export default async function RunsPage() {
  const user = await requireUser();
  const runtime = await getRuntime();
  const viewer = user.role === "admin" ? null : user.id;

  const [runs, rows] = await Promise.all([
    listRunItems(runtime, LIBRARY_LIMIT, viewer),
    runtime.runRepo.listForUser(viewer, LIBRARY_LIMIT),
  ]);

  // 补充内容类型(listRunItems 不带 recipe,从冻结的 input 解析一次)
  const recipeByRun = new Map<string, Recipe>();
  for (const row of rows) {
    try {
      const input = JSON.parse(row.inputJson) as { recipe?: Recipe };
      if (input.recipe) recipeByRun.set(row.id, input.recipe);
    } catch {
      /* 坏数据跳过,该卡不参与类型筛选 */
    }
  }
  const initialRuns: GalleryRun[] = runs.map((run) => ({ ...run, recipe: recipeByRun.get(run.runId) }));

  return (
    <>
      {/* 顶部细栏(与工作台一致) */}
      <header className="sticky top-0 z-20 flex h-[52px] items-center gap-3.5 border-b border-line bg-paper/85 px-5 backdrop-blur-md">
        <span className="font-mono text-xs tracking-[0.14em] text-ink-soft">
          作品库 / <b className="font-semibold text-ink">全部作品</b>
        </span>
        <div className="ml-auto flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-[3px] font-mono text-[11px] text-ink-soft">
            <span className="h-1.5 w-1.5 rounded-full bg-[#5fa36b]" />
            渠道在线 · {runtime.config.providerLabel}
          </span>
        </div>
      </header>

      {/* 筛选 chips + 作品网格(纯浏览,无创作条) */}
      <Gallery initialRuns={initialRuns} />
    </>
  );
}
