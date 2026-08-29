import sharp from "sharp";
import { CANVAS_SIZES, type AspectRatio, type ComicDialogue } from "@aai/shared-schemas";
import { loadCardFonts, type LoadedFont } from "./fonts";
import type { CardTheme } from "./themes";

export interface RenderComicSlideInput {
  theme: CardTheme;
  aspectRatio: AspectRatio;
  /** 漫画页面（无文字画面，已预留气泡安全区） */
  panelImageBase64: string;
  title: string;
  pageIndex: number;
  pageCount: number;
  dialogues: ComicDialogue[];
  /** 对白文字颜色跟随主题 */
  logoBase64?: string | undefined;
}

interface Element {
  type: string;
  props: Record<string, unknown>;
}

function el(type: string, props: Record<string, unknown>): Element {
  return { type, props };
}
function text(t: string, style: Record<string, unknown>): Element {
  return { type: "div", props: { style, children: t } };
}

let cachedFonts: LoadedFont[] | null = null;
function fonts(): LoadedFont[] {
  cachedFonts ??= loadCardFonts();
  return cachedFonts;
}

/** 文本行数估算（气泡高度按行数自适应） */
function estimateLines(text: string, fontSize: number, maxWidth: number): number {
  const perLine = Math.max(4, Math.floor(maxWidth / fontSize));
  let lines = 0;
  for (const paragraph of text.split("\n")) {
    lines += Math.max(1, Math.ceil([...paragraph].length / perLine));
  }
  return lines;
}

/**
 * 漫画气泡层（简化版）：
 * - narration：页面顶部矩形旁白框；
 * - speech：底部横向排布的圆角对白气泡（最多 3 条，避免遮挡画面主体）。
 * 布局为确定性纯函数；文字全部由程序渲染，可编辑。
 */
export function buildComicOverlayTree(input: RenderComicSlideInput): Element {
  const { theme, dialogues } = input;
  const { width, height } = CANVAS_SIZES[input.aspectRatio];
  const c = theme.colors;
  const padding = Math.round(width * 0.06);
  const contentWidth = width - padding * 2;

  const children: Element[] = [];

  const narrations = dialogues.filter((d) => d.type === "narration").slice(0, 1);
  const speeches = dialogues.filter((d) => d.type !== "narration").slice(0, 3);

  // 旁白框（顶部）
  if (narrations[0]) {
    const fontSize = Math.round(width * 0.032);
    const lines = estimateLines(narrations[0].text, fontSize, contentWidth - padding * 2);
    children.push(
      el(
        "div",
        {
          style: {
            position: "absolute",
            top: padding,
            left: padding,
            right: padding,
            display: "flex",
            flexDirection: "column",
            backgroundColor: "rgba(255, 253, 249, 0.94)",
            border: `2px solid ${c.ink}`,
            borderRadius: 4,
            padding: Math.round(width * 0.02),
            marginBottom: height * 0.01,
          },
          children: [
            text(narrations[0].text, {
              display: "flex",
              fontSize,
              lineHeight: 1.5,
              color: "#1c1814",
              fontWeight: 500,
            }),
          ],
        },
      ),
    );
    void lines;
  }

  // 对白气泡（底部一行均分）
  if (speeches.length > 0) {
    const bubbleWidth = Math.floor((contentWidth - (speeches.length - 1) * 16) / speeches.length);
    const fontSize = Math.round(width * 0.03);
    children.push(
      el(
        "div",
        {
          style: {
            position: "absolute",
            bottom: Math.round(height * 0.075),
            left: padding,
            right: padding,
            display: "flex",
            gap: 16,
            alignItems: "flex-end",
          },
          children: speeches.map((dialogue) =>
            el("div", {
              style: {
                display: "flex",
                flexDirection: "column",
                width: bubbleWidth,
                backgroundColor: "rgba(255, 253, 249, 0.96)",
                border: `2px solid ${c.ink}`,
                borderRadius: Math.round(width * 0.05),
                borderBottomLeftRadius: 6,
                padding: Math.round(width * 0.022),
              },
              children: [
                text(dialogue.speaker, {
                  display: "flex",
                  fontSize: Math.round(width * 0.024),
                  color: "#b5382d",
                  fontWeight: 700,
                  marginBottom: Math.round(width * 0.008),
                }),
                text(dialogue.text, {
                  display: "flex",
                  fontSize,
                  lineHeight: 1.45,
                  color: "#1c1814",
                  fontWeight: 500,
                }),
              ],
            }),
          ),
        },
      ),
    );
  }

  // 页脚
  children.push(
    el(
      "div",
      {
        style: {
          position: "absolute",
          bottom: Math.round(height * 0.025),
          left: padding,
          right: padding,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        },
        children: [
          el("div", {
            style: { display: "flex", alignItems: "center" },
            children: [
              ...(input.logoBase64
                ? [
                    el("img", {
                      src: `data:image/png;base64,${input.logoBase64}`,
                      width: Math.round(width * 0.04),
                      height: Math.round(width * 0.04),
                      style: {
                        width: Math.round(width * 0.04),
                        height: Math.round(width * 0.04),
                        objectFit: "contain",
                        marginRight: Math.round(width * 0.012),
                      },
                    }),
                  ]
                : []),
              text(`${input.title} · 科普漫画`, {
                display: "flex",
                fontSize: Math.round(width * 0.026),
                color: "rgba(255,255,255,0.85)",
              }),
            ],
          }),
          text(`${input.pageIndex + 1} / ${input.pageCount}`, {
            display: "flex",
            fontSize: Math.round(width * 0.026),
            color: "rgba(255,255,255,0.9)",
            fontWeight: 700,
          }),
        ],
      },
    ),
  );

  return el("div", {
    style: { width, height, display: "flex", position: "relative" },
    children,
  });
}

/** 漫画页合成：画面 + 气泡层（Satori）→ PNG。相同输入字节级一致 */
export async function renderComicSlide(input: RenderComicSlideInput): Promise<Buffer> {
  const { width, height } = CANVAS_SIZES[input.aspectRatio];
  const satori = (await import("satori")).default;
  const overlay = buildComicOverlayTree(input);
  const svg = await satori(overlay as unknown as Parameters<typeof satori>[0], {
    width,
    height,
    fonts: fonts(),
  });
  const overlayPng = await sharp(Buffer.from(svg)).png().toBuffer();
  // 画面铺满画布，气泡层叠加其上
  const panel = await sharp(Buffer.from(input.panelImageBase64, "base64"))
    .resize(width, height, { fit: "cover", position: "center" })
    .png()
    .toBuffer();
  return sharp(panel).composite([{ input: overlayPng }]).png().toBuffer();
}
