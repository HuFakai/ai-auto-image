import satori from "satori";
import sharp from "sharp";
import { CANVAS_SIZES, type AspectRatio, type StoryboardSlide } from "@aai/shared-schemas";
import { loadCardFonts, type LoadedFont } from "./fonts";
import type { CardTheme } from "./theme";

export interface RenderSlideInput {
  theme: CardTheme;
  aspectRatio: AspectRatio;
  slide: StoryboardSlide;
  pageCount: number;
  /** 确定性模式下的视觉层（AI 生成图），作为背景叠加文字 */
  visualImageBase64?: string | undefined;
  /** Brand Kit Logo（PNG 透明底，页脚展示） */
  logoBase64?: string | undefined;
}

interface Element {
  type: string;
  props: Record<string, unknown>;
}

/** 文字宽度估算：CJK ≈ 1em，ASCII ≈ 0.55em（ceil 前先消除浮点噪声） */
export function estimateLineWidth(text: string, fontSize: number): number {
  let units = 0;
  for (const char of text) {
    units += char.charCodeAt(0) > 0x2e7f ? 1 : 0.55;
  }
  return Math.ceil(units * fontSize - 1e-6);
}

/** 按容器宽度自动缩小字号；低于最小字号仍溢出则抛错（溢出检出率 100% 的落点） */
export function fitFontSize(
  lines: string[],
  maxWidth: number,
  startSize: number,
  minSize: number,
): number {
  let size = startSize;
  while (size > minSize) {
    if (lines.every((line) => estimateLineWidth(line, size) <= maxWidth)) return size;
    size = Math.floor(size * 0.92);
  }
  if (lines.some((line) => estimateLineWidth(line, minSize) > maxWidth)) {
    throw new Error(
      `text overflow: cannot fit "${lines[0]?.slice(0, 20)}" below ${minSize}px in ${maxWidth}px`,
    );
  }
  return minSize;
}

let cachedFonts: LoadedFont[] | null = null;
function fonts(): LoadedFont[] {
  cachedFonts ??= loadCardFonts();
  return cachedFonts;
}

function text(text: string, style: Record<string, unknown>): Element {
  return { type: "div", props: { style, children: text } };
}

/**
 * 构建卡片布局树：纯函数，相同输入得到相同树（无随机、无时间），
 * 配合固定字体与 Satori，相同 RenderSnapshot 输出字节级一致的图片。
 */
export function buildSlideTree(input: RenderSlideInput): Element {
  const { theme, slide, pageCount } = input;
  const { width, height } = CANVAS_SIZES[input.aspectRatio];
  const c = theme.colors;
  const padding = Math.round(width * 0.08);
  const contentWidth = width - padding * 2;
  const isCover = slide.role === "cover";

  const bodyLines = slide.body.filter((line) => line.trim().length > 0);
  const titleSize = fitFontSize(
    [slide.headline],
    contentWidth,
    isCover ? Math.round(width * 0.115) : Math.round(width * 0.082),
    40,
  );
  const bodySize = bodyLines.length
    ? fitFontSize(bodyLines, contentWidth, Math.round(width * 0.05), 28)
    : 0;

  const children: Element[] = [];

  if (isCover) {
    children.push(
      text(slide.headline, {
        display: "flex",
        marginTop: height * 0.16,
        fontSize: titleSize,
        fontWeight: 700,
        color: c.ink,
        lineHeight: 1.25,
        letterSpacing: "0.02em",
      }),
    );
    if (bodyLines.length > 0) {
      children.push(
        text(bodyLines[0]!, {
          display: "flex",
          marginTop: height * 0.03,
          fontSize: Math.max(30, Math.round(width * 0.042)),
          color: c.accent,
          fontWeight: 700,
        }),
      );
    }
  } else {
    children.push(
      text(`0${slide.index + 1}`, {
        display: "flex",
        fontSize: Math.round(width * 0.045),
        color: c.accent,
        fontWeight: 700,
        marginBottom: height * 0.02,
      }),
      text(slide.headline, {
        display: "flex",
        fontSize: titleSize,
        fontWeight: 700,
        color: c.ink,
        lineHeight: 1.25,
        letterSpacing: "0.02em",
      }),
    );
    if (bodyLines.length > 0) {
      children.push({
        type: "div",
        props: {
          style: {
            display: "flex",
            flexDirection: "column",
            marginTop: height * 0.035,
            gap: height * 0.022,
          },
          children: bodyLines.map((line) => ({
            type: "div",
            props: {
              style: {
                display: "flex",
                alignItems: "center",
                fontSize: bodySize,
                color: c.ink,
                lineHeight: 1.5,
              },
              children: [
                {
                  type: "div",
                  props: {
                    style: {
                      width: Math.round(width * 0.018),
                      height: Math.round(width * 0.018),
                      borderRadius: 999,
                      backgroundColor: c.accent,
                      marginRight: Math.round(width * 0.028),
                    },
                  },
                },
                line,
              ],
            },
          })),
        },
      });
    }
  }

  /* 视觉层作为背景 + 文字覆盖层；否则纯排版卡片 */
  const content: Element = input.visualImageBase64
    ? {
        type: "div",
        props: {
          style: { width, height, display: "flex", position: "relative" },
          children: [
            {
              type: "img",
              props: {
                src: `data:image/png;base64,${input.visualImageBase64}`,
                width,
                height,
                style: { position: "absolute", top: 0, left: 0, width, height, objectFit: "cover" },
              },
            },
            {
              type: "div",
              props: {
                style: {
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width,
                  height,
                  display: "flex",
                  flexDirection: "column",
                  padding,
                  backgroundColor: "rgba(14, 14, 16, 0.74)",
                },
                children,
              },
            },
            footer(input, pageCount),
          ],
        },
      }
    : {
        type: "div",
        props: {
          style: {
            width,
            height,
            display: "flex",
            flexDirection: "column",
            backgroundColor: c.background,
            padding,
            boxSizing: "border-box",
            position: "relative",
          },
          children: [...children, footer(input, pageCount)],
        },
      };

  return content;
}

function footer(input: RenderSlideInput, pageCount: number): Element {
  const { width } = CANVAS_SIZES[input.aspectRatio];
  const c = input.theme.colors;
  const padding = Math.round(width * 0.08);
  return {
    type: "div",
    props: {
      style: {
        position: "absolute",
        bottom: Math.round(padding * 0.7),
        left: padding,
        right: padding,
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
      },
      children: [
        {
          type: "div",
          props: {
            style: { display: "flex", alignItems: "center" },
            children: [
              ...(input.logoBase64
                ? [
                    {
                      type: "img",
                      props: {
                        src: `data:image/png;base64,${input.logoBase64}`,
                        width: Math.round(width * 0.05),
                        height: Math.round(width * 0.05),
                        style: {
                          width: Math.round(width * 0.05),
                          height: Math.round(width * 0.05),
                          objectFit: "contain",
                          marginRight: Math.round(width * 0.015),
                        },
                      },
                    },
                  ]
                : []),
              text("AI 图文工坊 · 知识卡片", {
                display: "flex",
                fontSize: Math.round(width * 0.028),
                color: c.muted,
              }),
            ],
          },
        },
        text(`${input.slide.index + 1} / ${pageCount}`, {
          display: "flex",
          fontSize: Math.round(width * 0.028),
          color: input.slide.role === "cover" ? c.accent : c.muted,
          fontWeight: 700,
        }),
      ],
    },
  };
}

/** 确定性渲染单页卡片 → PNG Buffer。相同输入与字体下字节级一致 */
export async function renderSlideDeterministic(input: RenderSlideInput): Promise<Buffer> {
  const { width, height } = CANVAS_SIZES[input.aspectRatio];
  const tree = buildSlideTree(input);
  const svg = await satori(tree as unknown as Parameters<typeof satori>[0], {
    width,
    height,
    fonts: fonts(),
  });
  return sharp(Buffer.from(svg)).png().toBuffer();
}
