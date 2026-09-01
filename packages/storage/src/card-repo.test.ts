import { describe, expect, it } from "vitest";
import { openDatabase, type OpenDatabase } from "./database";
import { CardRepo, OrderRepo, UserRepo, WalletRepo, LedgerRepo } from "./repositories";

function migrationsDir() {
  return new URL("../drizzle", import.meta.url).pathname;
}

describe("CardRepo", () => {
  it("redeems a card only once when requests arrive concurrently", async () => {
    const db: OpenDatabase = await openDatabase({ migrationsFolder: migrationsDir() });
    const users = new UserRepo(db.db);
    const cards = new CardRepo(db.db);
    const wallets = new WalletRepo(db.db);
    const orders = new OrderRepo(db.db);
    const ledger = new LedgerRepo(db.db);
    const user = await users.create({ username: `card-user-${Date.now()}`, role: "user" });
    const cardId = `card_test_${Date.now()}`;
    const batchId = `cbatch_test_${Date.now()}`;
    const codeHash = `hash_${Date.now()}`;
    await cards.createBatch({
      id: batchId,
      batchNo: `CBTEST${Date.now()}`,
      name: "并发点数卡",
      benefitType: "credits",
      benefitJson: JSON.stringify({ type: "credits", credits: 6 }),
      quantity: 1,
      source: "admin",
      cards: [{ id: cardId, codeHash, codePrefix: "AAI-TEST", codeLast4: "TEST", expiresAt: null }],
    });

    const outcome = await Promise.all(
      Array.from({ length: 6 }, () => cards.redeem({
        codeHash,
        userId: user.id,
        benefit: { type: "credits", credits: 6 },
        starterCredits: 0,
        nowMs: Date.now(),
      })),
    );
    expect(outcome.filter((item) => item.status === "succeeded")).toHaveLength(1);
    expect(outcome.filter((item) => item.status === "unavailable")).toHaveLength(5);
    expect((await wallets.findByUser(user.id))?.balance).toBe(6);
    expect((await orders.listByUser(user.id, 20)).filter((item) => item.type === "card_redeem")).toHaveLength(1);
    expect((await ledger.listByUser(user.id, 20)).filter((item) => item.reason === "card_redeem")).toHaveLength(1);
    expect(await cards.batchStats(batchId)).toMatchObject({ active: 0, redeemed: 1, expired: 0 });
    expect(await cards.summary()).toMatchObject({ cardCount: 1, redeemed: 1, redeemedCredits: 6, redeemedOrders: 1 });

    await db.close();
  });
});
