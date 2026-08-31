import { describe, expect, it } from "vitest";
import { openDatabase, type OpenDatabase } from "./database";
import { ProjectRepo, RunRepo, UserRepo, WalletRepo } from "./index";

function migrationsDir() {
  return new URL("../drizzle", import.meta.url).pathname;
}

/** RunRepo.onNodeSucceeded 钩子：节点成功产出图片时触发（计费扣点的接入点） */
describe("RunRepo node succeeded hooks", () => {
  it("fires with runId and image count when a node succeeds with images", async () => {
    const db: OpenDatabase = await openDatabase({ migrationsFolder: migrationsDir() });
    const projectRepo = new ProjectRepo(db.db);
    const runRepo = new RunRepo(db.db);
    const userRepo = new UserRepo(db.db);
    const walletRepo = new WalletRepo(db.db);

    const user = await userRepo.create({ username: "hook-user", role: "user" });
    await walletRepo.ensure(user.id, 10);
    const project = await projectRepo.create({ title: "t", userId: user.id });
    const run = await runRepo.create({ projectId: project.id, inputJson: "{}", userId: user.id });

    const events: Array<{ runId: string; images: number }> = [];
    runRepo.onNodeSucceeded(async (event) => {
      events.push({ runId: event.runId, images: event.images });
      await walletRepo.debit(user.id, event.images);
    });

    const node = await runRepo.createNodeRun(run.id, "generate-page");
    await runRepo.succeedNode(node.id, { images: 3 });

    expect(events).toEqual([{ runId: run.id, images: 3 }]);
    const wallet = await walletRepo.findByUser(user.id);
    expect(wallet?.totalConsumed).toBe(3);
    await db.close();
  });

  it("does not fire when the node produces no images", async () => {
    const db: OpenDatabase = await openDatabase({ migrationsFolder: migrationsDir() });
    const projectRepo = new ProjectRepo(db.db);
    const runRepo = new RunRepo(db.db);
    const project = await projectRepo.create({ title: "t2" });
    const run = await runRepo.create({ projectId: project.id, inputJson: "{}" });

    let calls = 0;
    runRepo.onNodeSucceeded(async () => {
      calls += 1;
    });
    const node = await runRepo.createNodeRun(run.id, "text-node");
    await runRepo.succeedNode(node.id, {});
    expect(calls).toBe(0);
    await db.close();
  });
});
