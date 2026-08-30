import type { CardTheme } from "./theme";
import type { Element } from "./element";
import { estimateLineWidth, fitFontSize, fitWrappedText, text, truncateToWidth } from "./element";
import type { LayoutData, LayoutHint } from "@aai/shared-schemas";

/**
 * 六种非 default 版式的纯排版布局函数（不使用 AI 背景图）。
 * 可读性优先：只用 Satori 支持的 CSS 子集（flex/absolute/边框/圆角/透明度）。
 * 全部为纯函数：相同输入得到相同子树，保证确定性渲染。
 */

export type NonDefaultLayout = Exclude<LayoutHint, "default">;

export interface LayoutSlideInput {
  /** 已 resolve 的版式（非 default） */
  layout: NonDefaultLayout;
  /** 已通过 LayoutDataSchema 校验且与 layout 匹配的版式数据 */
  layoutData: LayoutData;
  /** 已应用 palette 覆盖的主题 */
  theme: CardTheme;
  width: number;
  height: number;
  /** 与 render.ts 相同的页面内边距（宽 8%） */
  padding: number;
  /** 可用内容宽度（width - padding*2） */
  contentWidth: number;
}

interface LayoutContext extends LayoutSlideInput {
  c: CardTheme["colors"];
}

/* ── big-number：大数字居中偏上 + caption + 底部来源小字 ─────────────────── */

function renderBigNumber(data: LayoutData, ctx: LayoutContext): Element[] {
  if (data.layout !== "big-number") return [];
  const { c, width, height, contentWidth } = ctx;
  const valueSize = fitFontSize([data.value], contentWidth, Math.round(height * 0.28), 64);
  const caption = fitWrappedText(
    data.caption,
    contentWidth,
    Math.round(width * 0.052),
    Math.max(28, Math.round(width * 0.03)),
  );
  const children: Element[] = [
    text(data.value, {
      display: "flex",
      justifyContent: "center",
      textAlign: "center",
      marginTop: height * 0.15,
      fontSize: valueSize,
      fontWeight: 700,
      color: c.accent,
      lineHeight: 1.1,
      letterSpacing: "0.01em",
    }),
  ];
  for (const [i, line] of caption.lines.entries()) {
    children.push(
      text(line, {
        display: "flex",
        justifyContent: "center",
        textAlign: "center",
        marginTop: i === 0 ? height * 0.045 : height * 0.008,
        fontSize: caption.fontSize,
        color: c.ink,
        lineHeight: 1.4,
      }),
    );
  }
  if (data.source) {
    children.push(
      text(data.source, {
        display: "flex",
        justifyContent: "center",
        textAlign: "center",
        position: "absolute",
        bottom: Math.round(height * 0.075),
        left: 0,
        right: 0,
        fontSize: Math.max(18, Math.round(width * 0.026)),
        color: c.muted,
      }),
    );
  }
  return children;
}

/* ── timeline：左侧竖线 + 圆点节点（time + title + note），垂直均匀分布 ──── */

function renderTimeline(data: LayoutData, ctx: LayoutContext): Element[] {
  if (data.layout !== "timeline") return [];
  const { c, width, height, contentWidth } = ctx;
  // 底部预留页脚空间（页脚占约 12% 高度）
  const areaHeight = Math.round((height - ctx.padding * 2) * 0.78);
  const dotColumnWidth = Math.round(width * 0.07);
  const dotSize = Math.round(width * 0.022);
  const timeSize = Math.max(20, Math.round(width * 0.028));
  const titleSize = fitFontSize(
    data.nodes.map((node) => node.title),
    contentWidth - dotColumnWidth,
    Math.round(width * 0.04),
    30,
  );
  const noteSize = Math.max(20, Math.round(width * 0.03));

  const rows: Element[] = data.nodes.map((node) => {
    const content: Element[] = [
      {
        type: "div",
        props: {
          style: {
            display: "flex",
            flexDirection: "row",
            alignItems: "center",
          },
          children: [
            ...(node.time
              ? [
                  text(node.time, {
                    display: "flex",
                    fontSize: timeSize,
                    color: c.accent,
                    fontWeight: 700,
                    marginRight: Math.round(width * 0.024),
                    letterSpacing: "0.04em",
                  }),
                ]
              : []),
            text(truncateToWidth(node.title, contentWidth - dotColumnWidth, titleSize), {
              display: "flex",
              fontSize: titleSize,
              fontWeight: 700,
              color: c.ink,
            }),
          ],
        },
      },
    ];
    if (node.note) {
      content.push(
        text(truncateToWidth(node.note, contentWidth - dotColumnWidth, noteSize), {
          display: "flex",
          marginTop: height * 0.006,
          fontSize: noteSize,
          color: c.muted,
          lineHeight: 1.4,
        }),
      );
    }
    return {
      type: "div",
      props: {
        style: {
          display: "flex",
          flexDirection: "row",
          alignItems: "flex-start",
        },
        children: [
          {
            type: "div",
            props: {
              style: {
                display: "flex",
                width: dotColumnWidth,
                alignItems: "flex-start",
                justifyContent: "flex-start",
              },
              children: [
                {
                  type: "div",
                  props: {
                    style: {
                      width: dotSize,
                      height: dotSize,
                      borderRadius: 999,
                      backgroundColor: c.accent,
                      // 与节点标题行居中对齐
                      marginTop: Math.round((titleSize - dotSize) / 2) + Math.round(height * 0.004),
                    },
                  },
                },
              ],
            },
          },
          {
            type: "div",
            props: {
              style: {
                display: "flex",
                flexDirection: "column",
              },
              children: content,
            },
          },
        ],
      },
    };
  });

  return [
    {
      type: "div",
      props: {
        style: {
          position: "relative",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          height: areaHeight,
          marginTop: height * 0.05,
        },
        children: [
          {
            type: "div",
            props: {
              style: {
                position: "absolute",
                left: Math.round(dotColumnWidth / 2) - 1,
                top: 8,
                width: 2,
                height: areaHeight - 16,
                backgroundColor: c.line,
              },
            },
          },
          ...rows,
        ],
      },
    },
  ];
}

/* ── table：flex 模拟表头（底边线）+ 隔行浅底数据行，第一列 28% 宽 ────────── */

function renderTable(data: LayoutData, ctx: LayoutContext): Element[] {
  if (data.layout !== "table") return [];
  const { c, width, height, contentWidth } = ctx;
  const firstColWidth = Math.round(contentWidth * 0.28);
  const restColWidth = Math.floor(
    (contentWidth - firstColWidth) / Math.max(1, data.columns.length - 1),
  );
  const colWidths = data.columns.map((_, i) => (i === 0 ? firstColWidth : restColWidth));
  const cellPadding = Math.round(width * 0.016);
  const fontSize = Math.round(width * 0.028);
  const rowPaddingY = Math.round(height * 0.014);

  const cell = (value: string, colIndex: number, bold: boolean): Element =>
    text(truncateToWidth(value, colWidths[colIndex]! - cellPadding * 2, fontSize), {
      display: "flex",
      width: colWidths[colIndex]! - cellPadding * 2,
      fontSize,
      fontWeight: bold ? 700 : 400,
      color: c.ink,
      lineHeight: 1.35,
    });

  const headerRow: Element = {
    type: "div",
    props: {
      style: {
        display: "flex",
        flexDirection: "row",
        paddingBottom: rowPaddingY,
      },
      children: data.columns.map((column, i) => cell(column, i, true)),
    },
  };
  const headerDivider: Element = {
    type: "div",
    props: {
      style: {
        display: "flex",
        width: contentWidth,
        height: 3,
        backgroundColor: c.ink,
      },
    },
  };

  const rows = data.rows.map((row, rowIndex): Element => {
    const rowChildren: Element[] = row.map((value, colIndex) => cell(value, colIndex, false));
    return {
      type: "div",
      props: {
        style: {
          display: "flex",
          flexDirection: "row",
          alignItems: "center",
          paddingTop: rowPaddingY,
          paddingBottom: rowPaddingY,
          // 隔行浅色底（surface）
          ...(rowIndex % 2 === 1 ? { backgroundColor: c.surface } : {}),
        },
        children: rowChildren,
      },
    };
  });

  return [
    {
      type: "div",
      props: {
        style: {
          display: "flex",
          flexDirection: "column",
          marginTop: height * 0.05,
        },
        children: [headerRow, headerDivider, ...rows],
      },
    },
  ];
}

/* ── index：目录标题 + 大序号（accent）+ 章节标题，行距舒展 ──────────────── */

function renderIndex(data: LayoutData, ctx: LayoutContext): Element[] {
  if (data.layout !== "index") return [];
  const { c, width, height, contentWidth } = ctx;
  const titleSize = Math.round(width * 0.058);
  const numberSize = Math.round(width * 0.05);
  const itemSize = Math.round(width * 0.038);
  const numberWidth = Math.round(estimateLineWidth("08", numberSize) + width * 0.045);

  const items: Element[] = data.items.map((item, i) => ({
    type: "div",
    props: {
      style: {
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
      },
      children: [
        text(`0${i + 1}`, {
          display: "flex",
          width: numberWidth,
          fontSize: numberSize,
          fontWeight: 700,
          color: c.accent,
          letterSpacing: "0.04em",
        }),
        text(truncateToWidth(item.title, contentWidth - numberWidth, itemSize), {
          display: "flex",
          fontSize: itemSize,
          color: c.ink,
          fontWeight: 700,
        }),
      ],
    },
  }));

  return [
    text("目录", {
      display: "flex",
      marginTop: height * 0.08,
      fontSize: titleSize,
      fontWeight: 700,
      color: c.ink,
      letterSpacing: "0.02em",
    }),
    {
      type: "div",
      props: {
        style: {
          display: "flex",
          width: Math.round(width * 0.14),
          height: Math.round(width * 0.006),
          marginTop: height * 0.018,
          backgroundColor: c.accent,
        },
      },
    },
    {
      type: "div",
      props: {
        style: {
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          height: Math.round((height - ctx.padding * 2) * 0.6),
          marginTop: height * 0.06,
        },
        children: items,
      },
    },
  ];
}

/* ── quote：超大低透明度引号装饰 + 居中引文 + 右对齐署名 + 上下细线 ───────── */

function renderQuote(data: LayoutData, ctx: LayoutContext): Element[] {
  if (data.layout !== "quote") return [];
  const { c, width, height, contentWidth } = ctx;
  const quote = fitWrappedText(
    data.quote,
    contentWidth * 0.88,
    Math.round(height * 0.06),
    Math.max(30, Math.round(width * 0.03)),
  );
  const accentLine = (marginTop = 0): Element => ({
    type: "div",
    props: {
      style: {
        display: "flex",
        width: Math.round(contentWidth * 0.16),
        height: 3,
        backgroundColor: c.accent,
        marginTop,
      },
    },
  });

  const quoteLines: Element[] = quote.lines.map((lineText, i) =>
    text(lineText, {
      display: "flex",
      justifyContent: "center",
      textAlign: "center",
      marginTop: i === 0 ? 0 : quote.fontSize * 0.35,
      fontSize: quote.fontSize,
      color: c.ink,
      fontWeight: 700,
      lineHeight: 1.3,
    }),
  );

  return [
    {
      type: "div",
      props: {
        style: {
          position: "relative",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          height: Math.round((height - ctx.padding * 2) * 0.82),
          marginTop: height * 0.04,
        },
        children: [
          text("“", {
            position: "absolute",
            top: Math.round(-height * 0.03),
            left: 0,
            display: "flex",
            fontSize: Math.round(height * 0.4),
            fontWeight: 700,
            color: c.accent,
            opacity: 0.16,
            lineHeight: 1,
          }),
          accentLine(),
          ...quoteLines,
          accentLine(height * 0.05),
          ...(data.attribution
            ? [
                text(data.attribution, {
                  display: "flex",
                  alignSelf: "flex-end",
                  marginTop: height * 0.03,
                  fontSize: Math.max(20, Math.round(width * 0.03)),
                  color: c.muted,
                }),
              ]
            : []),
        ],
      },
    },
  ];
}

/* ── process：垂直步骤列表（编号圆 + 加粗标题 + 小注），框间竖线连接 ──────── */

function renderProcess(data: LayoutData, ctx: LayoutContext): Element[] {
  if (data.layout !== "process") return [];
  const { c, width, height, contentWidth } = ctx;
  const circleSize = Math.round(width * 0.038);
  const titleSize = Math.round(width * 0.033);
  const noteSize = Math.max(18, Math.round(width * 0.026));
  const boxPaddingY = Math.round(height * 0.016);
  const boxPaddingX = Math.round(width * 0.032);
  const connectorHeight = Math.round(height * 0.02);

  const blocks: Element[] = [];
  data.steps.forEach((step, i) => {
    blocks.push({
      type: "div",
      props: {
        style: {
          display: "flex",
          flexDirection: "row",
          alignItems: "center",
          width: contentWidth,
          border: `2px solid ${c.line}`,
          borderRadius: 16,
          paddingTop: boxPaddingY,
          paddingBottom: boxPaddingY,
          paddingLeft: boxPaddingX,
          paddingRight: boxPaddingX,
          backgroundColor: c.surface,
        },
        children: [
          {
            type: "div",
            props: {
              style: {
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: circleSize,
                height: circleSize,
                borderRadius: 999,
                backgroundColor: c.accent,
                marginRight: Math.round(width * 0.028),
              },
              children: [`${i + 1}`],
            },
          },
          {
            type: "div",
            props: {
              style: { display: "flex", flexDirection: "column" },
              children: [
                text(truncateToWidth(step.title, contentWidth - circleSize - boxPaddingX * 2, titleSize), {
                  display: "flex",
                  fontSize: titleSize,
                  fontWeight: 700,
                  color: c.ink,
                }),
                ...(step.note
                  ? [
                      text(
                        truncateToWidth(
                          step.note,
                          contentWidth - circleSize - boxPaddingX * 2,
                          noteSize,
                        ),
                        {
                          display: "flex",
                          marginTop: Math.round(height * 0.005),
                          fontSize: noteSize,
                          color: c.muted,
                          lineHeight: 1.4,
                        },
                      ),
                    ]
                  : []),
              ],
            },
          },
        ],
      },
    });
    if (i < data.steps.length - 1) {
      blocks.push({
        type: "div",
        props: {
          style: {
            display: "flex",
            width: contentWidth,
            justifyContent: "center",
            paddingTop: Math.round(connectorHeight * 0.4),
            paddingBottom: Math.round(connectorHeight * 0.4),
          },
          children: [
            {
              type: "div",
              props: {
                style: {
                  display: "flex",
                  width: 2,
                  height: connectorHeight,
                  backgroundColor: c.line,
                },
              },
            },
          ],
        },
      });
    }
  });

  return [
    {
      type: "div",
      props: {
        style: {
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          marginTop: height * 0.05,
        },
        children: blocks,
      },
    },
  ];
}

const RENDERERS: Record<NonDefaultLayout, (data: LayoutData, ctx: LayoutContext) => Element[]> = {
  "big-number": (data, ctx) => renderBigNumber(data, ctx),
  timeline: (data, ctx) => renderTimeline(data, ctx),
  table: (data, ctx) => renderTable(data, ctx),
  index: (data, ctx) => renderIndex(data, ctx),
  quote: (data, ctx) => renderQuote(data, ctx),
  process: (data, ctx) => renderProcess(data, ctx),
};

/** 按 layout 分派到对应布局函数（layout 已由调用方窄化为非 default） */
export function buildLayoutChildren(input: LayoutSlideInput): Element[] {
  const renderer = RENDERERS[input.layout];
  if (!renderer) return [];
  return renderer(input.layoutData, { ...input, c: input.theme.colors });
}
