import { afterEach, describe, expect, it } from "vitest";
import {
  LedgerRepo,
  PlanRepo,
  ProjectRepo,
  RunRepo,
  SubscriptionRepo,
  UserRepo,
  WalletRepo,
  openDatabase,
  type OpenDatabase,
} from "@aai/storage";
import { BillingService, InsufficientCreditsError, MIN_CREATION_CREDITS } from "./billing";

const databases: OpenDatabase[] = [];

function migrationsDir() {
  return new URL("../../../../packages/storage/drizzle", import.meta.url).pathname;
}

async function createFixture() {
  const db = await openDatabase({ migrationsFolder: migrationsDir() });
  databases.push(db);
  const userRepo = new UserRepo(db.db);
  const projectRepo = new ProjectRepo(db.db);
  const runRepo = new RunRepo(db.db);
  const walletRepo = new WalletRepo(db.db);
  const ledgerRepo = new LedgerRepo(db.db);
  const user = await userRepo.create({ username: `billing-${Math.random()}`, role: "user" });
  const project = await projectRepo.create({ title: "billing", userId: user.id });
  const run = await runRepo.create({ projectId: project.id, inputJson: "{}", userId: user.id });
  const billing = new BillingService(
    walletRepo,
    ledgerRepo,
    new PlanRepo(db.db),
    new SubscriptionRepo(db.db),
    runRepo,
  );
  await billing.ensureWallet(user.id);
  return { db, user, run, billing, walletRepo, runRepo, ledgerRepo };
}

afterEach(async () => {
  while (databases.length > 0) await databases.pop()!.close();
});

describe("billing reservation lifecycle", () => {
  it("uses six credits as the creation admission floor", async () => {
    const fixture = await createFixture();
    await fixture.walletRepo.debit(fixture.user.id, 5);

    await expect(fixture.billing.precheck(fixture.user.id, MIN_CREATION_CREDITS)).rejects.toMatchObject({
      name: "InsufficientCreditsError",
      balance: 5,
      needed: MIN_CREATION_CREDITS,
    } satisfies Partial<InsufficientCreditsError>);
  });

  it("prevents concurrent runs from reserving the same credits", async () => {
    const fixture = await createFixture();
    const project = await new ProjectRepo(fixture.db.db).create({ title: "billing-2", userId: fixture.user.id });
    const otherRun = await fixture.runRepo.create({
      projectId: project.id,
      inputJson: "{}",
      userId: fixture.user.id,
    });

    const results = await Promise.allSettled([
      fixture.billing.reserveRunCredits(fixture.user.id, fixture.run.id, 7),
      fixture.billing.reserveRunCredits(fixture.user.id, otherRun.id, 7),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")[0]).toMatchObject({
      reason: expect.any(InsufficientCreditsError),
    });

    const wallet = await fixture.walletRepo.findByUser(fixture.user.id);
    expect(wallet?.reservedCredits).toBe(7);
    expect((wallet?.balance ?? 0) - (wallet?.reservedCredits ?? 0)).toBe(3);
  });

  it("captures successful images, releases unused capacity, and remains exact under parallel capture", async () => {
    const fixture = await createFixture();
    await fixture.billing.reserveRunCredits(fixture.user.id, fixture.run.id, 4);

    await Promise.all([
      fixture.billing.consumeForImages(fixture.user.id, fixture.run.id, 1, "workflow_node", "node-1"),
      fixture.billing.consumeForImages(fixture.user.id, fixture.run.id, 1, "workflow_node", "node-2"),
      fixture.billing.consumeForImages(fixture.user.id, fixture.run.id, 1, "workflow_node", "node-3"),
    ]);
    await fixture.billing.releaseRunCredits(fixture.run.id);

    const wallet = await fixture.walletRepo.findByUser(fixture.user.id);
    const run = await fixture.runRepo.require(fixture.run.id);
    expect(wallet?.balance).toBe(7);
    expect(wallet?.reservedCredits).toBe(0);
    expect(wallet?.totalConsumed).toBe(3);
    expect(run.creditsReserved).toBe(0);
    expect(run.creditsCharged).toBe(3);
    const ledger = await fixture.ledgerRepo.listByUser(fixture.user.id, 10);
    expect(ledger.some((row) => row.runId === fixture.run.id && row.displayTitle === "billing")).toBe(true);
  });
});
