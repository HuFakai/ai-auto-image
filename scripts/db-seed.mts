/** 测试种子数据：插入一个演示项目与 Prompt 版本，便于新环境快速验证 */
import path from "node:path";
import { openDatabase, ProjectRepo, PromptRepo } from "@aai/storage";
import { loadDotEnv } from "./lib/env";

loadDotEnv();

const root = path.resolve(import.meta.dirname ?? process.cwd(), "..");
const migrationsDir =
  process.env.SQLITE_MIGRATIONS_DIR ?? path.join(root, "packages", "storage", "drizzle");

const db = await openDatabase({ url: process.env.DATABASE_URL, migrationsFolder: migrationsDir });
const projectRepo = new ProjectRepo(db.db);
const promptRepo = new PromptRepo(db.db);

const project = await projectRepo.create({ title: "种子项目：三分钟看懂量子纠缠" });
const briefPrompt = await promptRepo.ensureVersion(
  "generate-brief",
  ["主题：{topic}", "目标平台：{platform}", "任务：为这套图文生成 Content Brief。"].join("\n"),
);
const storyboardPrompt = await promptRepo.ensureVersion(
  "generate-storyboard",
  [
    "主题：{topic}",
    "画布比例：{aspectRatio}",
    "任务：生成 4–6 页 Storyboard（封面、正文、总结/CTA）。",
  ].join("\n"),
);

console.log(`seeded project=${project.id}`);
console.log(`prompt versions: ${briefPrompt.id} (v${briefPrompt.version}), ${storyboardPrompt.id} (v${storyboardPrompt.version})`);
await db.close();
