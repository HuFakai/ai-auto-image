import type { SlidePlan } from "@aai/shared-schemas";
import type { ThemeConfig } from "./themes";

export interface RenderInput {
  slide: SlidePlan;
  theme: ThemeConfig;
  brandName?: string;
  watermark?: string;
  width: number;
  height: number;
  /** Base64-encoded image for the visual layer (deterministic mode). */
  imageBase64?: string;
}

/** Overflow finding for one text block. */
export interface OverflowFinding {
  block: string;
  estimatedHeight: number;
  availableHeight: number;
  overflow: boolean;
}

// CJK chars are full-width; latin/digits ~55%; punctuation narrower.
function textWidth(text: string, fontSize: number): number {
  let w = 0;
  for (const ch of text) {
    if (/[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\u3000-\u303F]/.test(ch)) w += fontSize;
    else if (/[A-Z0-9@#%&]/.test(ch)) w += fontSize * 0.66;
    else w += fontSize * 0.52;
  }
  return w;
}

export function wrapLines(text: string, fontSize: number, maxWidth: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const ch of text) {
    if (ch === "\n") {
      lines.push(current);
      current = "";
      continue;
    }
    if (textWidth(current + ch, fontSize) > maxWidth && current.length > 0) {
      lines.push(current);
      current = ch;
    } else {
      current += ch;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Deterministic overflow detection (quality gate). Estimates the rendered
 * height of headline + body against the canvas and reports per-block findings.
 */
export function detectOverflow(input: RenderInput, opts: { headlineSize: number; bodySize: number }): OverflowFinding[] {
  const innerWidth = input.width - input.theme.padding * 2;
  const headlineLines = wrapLines(input.slide.headline, opts.headlineSize, innerWidth);
  const bodyLines = input.slide.body.flatMap((p) => wrapLines(p, opts.bodySize, innerWidth));
  const lineHeight = (size: number) => size * 1.45;
  const headlineHeight = headlineLines.length * lineHeight(opts.headlineSize);
  const bodyHeight = bodyLines.length * lineHeight(opts.bodySize);
  const available = input.height - input.theme.padding * 2 - (input.watermark ? 60 : 0) - 40;
  const total = headlineHeight + 32 + bodyHeight;
  return [
    {
      block: "headline+body",
      estimatedHeight: Math.round(total),
      availableHeight: Math.round(available),
      overflow: total > available,
    },
  ];
}

type El = { type: string; props: Record<string, unknown> };
const el = (type: string, props: Record<string, unknown>): El => ({ type, props });

/** Satori throws on undefined style values — strip them recursively. */
function clean(node: El): El {
  const style = node.props.style as Record<string, unknown> | undefined;
  const props: Record<string, unknown> = { ...node.props };
  if (style) {
    const cleanStyle: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(style)) {
      if (v !== undefined) cleanStyle[k] = v;
    }
    props.style = cleanStyle;
  }
  if (Array.isArray(props.children)) {
    props.children = (props.children as El[]).map(clean);
  }
  return { type: node.type, props };
}

/**
 * Build the Satori element tree for one slide. Covers the four standard roles
 * with optional visual image layer. Deterministic mode only — native mode
 * never calls this.
 */
export function buildSlideElement(input: RenderInput): El {
  const { slide, theme, width, height } = input;
  const pad = theme.padding;
  const headlineSize = slide.role === "cover" ? Math.round(width * 0.082) : Math.round(width * 0.062);
  const bodySize = Math.round(width * 0.038);
  const isDarkBg = isDark(theme.background);

  const children: El[] = [];

  // Badge (page number / kicker)
  const badge = slide.overlayText?.badge ?? (slide.role === "cover" ? undefined : `${slide.index + 1}`);
  if (badge) {
    children.push(
      el("div", {
        style: {
          display: "flex",
          alignSelf: "flex-start",
          backgroundColor: theme.badgeBackground ?? theme.accentColor,
          color: theme.badgeColor ?? "#ffffff",
          fontSize: Math.round(width * 0.026),
          padding: `${Math.round(width * 0.012)}px ${Math.round(width * 0.03)}px`,
          borderRadius: 999,
          marginBottom: Math.round(height * 0.03),
          fontWeight: 700,
        },
        children: badge,
      })
    );
  }

  // Headline
  children.push(
    el("div", {
      style: {
        display: "flex",
        fontSize: headlineSize,
        fontWeight: theme.headingWeight === "bold" ? 700 : 400,
        color: theme.headingColor,
        lineHeight: 1.35,
        letterSpacing: theme.letterSpacing ?? "normal",
      },
      children: slide.headline,
    })
  );

  // Divider for cover
  if (slide.role === "cover") {
    children.push(
      el("div", {
        style: {
          width: Math.round(width * 0.16),
          height: 6,
          backgroundColor: theme.accentColor,
          borderRadius: 3,
          margin: `${Math.round(height * 0.025)}px 0`,
        },
      })
    );
  }

  // Optional visual image
  if (input.imageBase64) {
    children.push(
      el("img", {
        src: `data:image/jpeg;base64,${input.imageBase64}`,
        width: Math.round(width * 0.9),
        height: Math.round(height * 0.32),
        style: {
          display: "flex",
          objectFit: "cover",
          margin: `${Math.round(height * 0.02)}px 0`,
          borderRadius: theme.id.includes("minimal") ? 0 : 24,
        },
      })
    );
  }

  // Body bullets / paragraphs
  if (slide.body.length > 0) {
    children.push(
      el("div", {
        style: {
          display: "flex",
          flexDirection: "column",
          gap: Math.round(bodySize * 0.9),
          marginTop: Math.round(height * 0.02),
        },
        children: slide.body.map((line, i) =>
          el("div", {
            key: i,
            style: {
              display: "flex",
              fontSize: bodySize,
              color: theme.bodyColor,
              lineHeight: 1.5,
            },
            children: line,
          })
        ),
      })
    );
  }

  // CTA chip for cta/summary roles
  if ((slide.role === "cta" || slide.role === "summary") && input.brandName) {
    children.push(
      el("div", {
        style: {
          display: "flex",
          marginTop: "auto",
          fontSize: Math.round(width * 0.03),
          color: isDarkBg ? theme.mutedColor : theme.mutedColor,
          fontWeight: 700,
        },
        children: `— ${input.brandName}`,
      })
    );
  }

  return clean(
    el("div", {
      style: {
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: slide.role === "cover" ? "center" : "flex-start",
        alignItems: "stretch",
        backgroundColor: theme.background,
        backgroundImage: theme.gradient
          ? `linear-gradient(160deg, ${theme.gradient[0]}, ${theme.gradient[1]})`
          : undefined,
        padding: pad,
        boxSizing: "border-box",
      },
      children,
    })
  );
}

function isDark(hex: string): boolean {
  const m = hex.replace("#", "");
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b < 128;
}
