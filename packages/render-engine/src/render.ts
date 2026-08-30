import satori from "satori";
import sharp from "sharp";
import {
  CANVAS_SIZES,
  resolveSlideLayout,
  type AspectRatio,
  type BrandKitConfig,
  type StoryboardSlide,
} from "@aai/shared-schemas";
import { loadCardFonts, serifAvailable, type LoadedFont } from "./fonts";
import { applyPaletteOverrides, type CardTheme } from "./theme";
import { applyBrandOverlays } from "./brand-overlays";
import { buildLayoutChildren } from "./layouts";
import { fitFontSize, text, type Element } from "./element";

/* 兼容旧导入路径：宽度估算/字号适配已抽到 element.ts（layouts 与 render 共用） */
export { estimateLineWidth, fitFontSize } from "./element";

export interface RenderSlideInput {
  theme: CardTheme;
  aspectRatio: AspectRatio;
  slide: StoryboardSlide;
  pageCount: number;
  /** 确定性模式下的视觉层（AI 生成图），作为背景叠加文字 */
  visualImageBase64?: string | undefined;
  /** Brand Kit Logo（PNG 透明底，页脚展示） */
  logoBase64?: string | undefined;
  /**
   * Brand Kit 配置：paletteJson 覆盖主题色、coverLayout 切换封面布局、
   * titleFont 切换封面标题字体、footerSignature/watermarkText 渲染后叠加。
   * 缺省时输出与旧版完全一致。
   */
  brand?: Partial<BrandKitConfig> | undefined;
}

let cachedFonts: LoadedFont[] | null = null;
function fonts(): LoadedFont[] {
  cachedFonts ??= loadCardFonts();
  return cachedFonts;
}

/** titleFont → Satori 字体族；default 跟随主题（无衬线）；serif 不可用时回退 Sans（不 throw） */
function titleFontFamily(titleFont: string | undefined, fallback: string): string {
  if (titleFont === "serif") return serifAvailable() ? "Noto Serif SC" : "Noto Sans SC";
  if (titleFont === "sans") return "Noto Sans SC";
  return fallback;
}

/**
 * 构建卡片布局树：纯函数，相同输入得到相同树（无随机、无时间），
 * 配合固定字体与 Satori，相同 RenderSnapshot 输出字节级一致的图片。
 * brand 缺省（或仅填充默认值）时生成的树与旧版逐字节一致。
 */
export function buildSlideTree(input: RenderSlideInput): Element {
  const { slide, pageCount } = input;
  const theme = applyPaletteOverrides(input.theme, input.brand?.paletteJson);
  const { width, height } = CANVAS_SIZES[input.aspectRatio];
  const c = theme.colors;
  const padding = Math.round(width * 0.08);
  const contentWidth = width - padding * 2;
  const isCover = slide.role === "cover";
  const coverLayout = isCover ? input.brand?.coverLayout ?? "default" : "default";
  // 仅显式设置 serif/sans 时切换标题字体；default/未设置不写 fontFamily，输出与旧版一致
  // titleFamilyStyle 只作用于 headline 元素；封面正文/副标题统一默认字体（以 split 布局行为为准）
  const useTitleFont = input.brand?.titleFont === "serif" || input.brand?.titleFont === "sans";
  const titleFamily = titleFontFamily(input.brand?.titleFont, theme.fontFamily);
  const titleFamilyStyle = useTitleFont ? { fontFamily: titleFamily } : {};

  const bodyLines = slide.body.filter((line) => line.trim().length > 0);
  const titleStart = isCover
    ? coverLayout === "big-center"
      ? Math.round(width * 0.135)
      : coverLayout === "split"
        ? Math.round(width * 0.1)
        : Math.round(width * 0.115)
    : Math.round(width * 0.082);
  const titleSize = fitFontSize(
    [slide.headline],
    contentWidth,
    titleStart,
    40,
  );
  const bodySize = bodyLines.length
    ? fitFontSize(bodyLines, contentWidth, Math.round(width * 0.05), 28)
    : 0;

  const children: Element[] = [];

  if (isCover) {
    if (coverLayout === "big-center") {
      // 标题绝对居中放大
      children.push(
        text(slide.headline, {
          display: "flex",
          marginTop: height * 0.42,
          fontSize: titleSize,
          fontWeight: 700,
          color: c.ink,
          lineHeight: 1.2,
          letterSpacing: "0.02em",
          textAlign: "center",
          justifyContent: "center",
          ...titleFamilyStyle,
        }),
      );
      if (bodyLines.length > 0) {
        children.push(
          text(bodyLines[0]!, {
            display: "flex",
            justifyContent: "center",
            marginTop: height * 0.035,
            fontSize: Math.max(30, Math.round(width * 0.046)),
            color: c.accent,
            fontWeight: 700,
          }),
        );
      }
    } else if (coverLayout === "split") {
      // 标题上 1/3 + 分割线
      children.push(
        text(slide.headline, {
          display: "flex",
          marginTop: height * 0.2,
          fontSize: titleSize,
          fontWeight: 700,
          color: c.ink,
          lineHeight: 1.3,
          letterSpacing: "0.02em",
          ...titleFamilyStyle,
        }),
      );
      children.push({
        type: "div",
        props: {
          style: {
            display: "flex",
            width: Math.round(width * 0.18),
            height: Math.round(width * 0.006),
            marginTop: height * 0.045,
            backgroundColor: c.accent,
          },
        },
      });
      if (bodyLines.length > 0) {
        children.push(
          text(bodyLines[0]!, {
            display: "flex",
            marginTop: height * 0.035,
            fontSize: Math.max(30, Math.round(width * 0.04)),
            color: c.accent,
            fontWeight: 700,
          }),
        );
      }
    } else {
      children.push(
        text(slide.headline, {
          display: "flex",
          marginTop: height * 0.16,
          fontSize: titleSize,
          fontWeight: 700,
          color: c.ink,
          lineHeight: 1.25,
          letterSpacing: "0.02em",
          ...titleFamilyStyle,
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
    }
  } else {
    // 版式路由：非 default 版式走纯排版布局函数（仅无视觉层的纯排版路径；
    // 有 AI 背景图时保持旧行为不变）。resolveSlideLayout 内部重新校验，
    // hint/data 不匹配或非法时回退 default，不抛错。
    const resolved = input.visualImageBase64 ? undefined : resolveSlideLayout(slide);
    if (resolved && resolved.layout !== "default" && resolved.layoutData) {
      children.push(
        ...buildLayoutChildren({
          layout: resolved.layout,
          layoutData: resolved.layoutData,
          theme,
          width,
          height,
          padding,
          contentWidth,
        }),
      );
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
  // 页脚与正文一致使用 palette 覆盖后的主题色（而非未覆盖的 input.theme）
  const c = applyPaletteOverrides(input.theme, input.brand?.paletteJson).colors;
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
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  if (input.brand) {
    // Brand Kit 水印/签名：无配置时原样返回（逐字节一致）
    return applyBrandOverlays(png, input.brand);
  }
  return png;
}
