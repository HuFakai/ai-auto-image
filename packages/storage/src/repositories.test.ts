import { describe, expect, it } from "vitest";
import { openDatabase } from "./database";
import { BrandKitRepo } from "./repositories";

function migrationsDir(): string {
  const moduleUrl = import.meta.url;
  return new URL("../drizzle", moduleUrl).pathname;
}

describe("BrandKitRepo", () => {
  it("round-trips the new brand manual fields on create/update", async () => {
    const db = await openDatabase({ migrationsFolder: migrationsDir() });
    try {
      const repo = new BrandKitRepo(db.db);
      const kit = await repo.create({
        name: "测试品牌",
        themeId: "darkroom",
        styleKeywords: ["插画"],
        negativeKeywords: ["真人照片"],
        brandName: "示例品牌",
        slogan: "让知识有光",
        footerSignature: "@示例账号",
        watermarkText: "示例水印",
        watermarkPosition: "center",
        watermarkOpacity: 0.25,
        titleFont: "serif",
        paletteJson: { primary: "#ff0000", accent: "#00ff00", background: "#ffffff", ink: "#111111" },
        coverLayout: "big-center",
      });

      expect(kit.brandName).toBe("示例品牌");
      expect(kit.slogan).toBe("让知识有光");
      expect(kit.footerSignature).toBe("@示例账号");
      expect(kit.watermarkText).toBe("示例水印");
      expect(kit.watermarkPosition).toBe("center");
      expect(kit.watermarkOpacity).toBeCloseTo(0.25);
      expect(kit.titleFont).toBe("serif");
      expect(JSON.parse(kit.paletteJson!)).toEqual({
        primary: "#ff0000",
        accent: "#00ff00",
        background: "#ffffff",
        ink: "#111111",
      });
      expect(kit.coverLayout).toBe("big-center");

      const updated = await repo.update(kit.id, {
        brandName: "新品牌",
        watermarkText: null,
        watermarkOpacity: 0.1,
        titleFont: "sans",
        paletteJson: { primary: "#0000ff" },
        coverLayout: "split",
      });

      expect(updated.brandName).toBe("新品牌");
      expect(updated.watermarkText).toBeNull();
      expect(updated.watermarkOpacity).toBeCloseTo(0.1);
      expect(updated.titleFont).toBe("sans");
      expect(JSON.parse(updated.paletteJson!)).toEqual({ primary: "#0000ff" });
      expect(updated.coverLayout).toBe("split");
    } finally {
      await db.close();
    }
  });

  it("applies column defaults when new fields are omitted", async () => {
    const db = await openDatabase({ migrationsFolder: migrationsDir() });
    try {
      const repo = new BrandKitRepo(db.db);
      const kit = await repo.create({
        name: "默认",
        themeId: "darkroom",
        styleKeywords: [],
        negativeKeywords: [],
      });

      expect(kit.brandName).toBeNull();
      expect(kit.footerSignature).toBeNull();
      expect(kit.watermarkText).toBeNull();
      expect(kit.watermarkPosition).toBe("corner");
      expect(kit.watermarkOpacity).toBeCloseTo(0.18);
      expect(kit.titleFont).toBe("default");
      expect(kit.paletteJson).toBeNull();
      expect(kit.coverLayout).toBe("default");
    } finally {
      await db.close();
    }
  });
});
