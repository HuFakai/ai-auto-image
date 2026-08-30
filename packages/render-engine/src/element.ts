/**
 * Satori 元素树的共享构件（render.ts 与 layouts.ts 共用）。
 * 全部为纯函数：相同输入得到相同树，保证字节级确定性。
 */

/** Satori 元素（受限子集：div/img + flex/absolute CSS） */
export interface Element {
  type: string;
  props: Record<string, unknown>;
}

/** 单行文字节点（Satori 要求文字必须挂在 display:flex 的 div 上） */
export function text(text: string, style: Record<string, unknown>): Element {
  return { type: "div", props: { style, children: text } };
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

/** 按估算宽度把文本切成若干行（CJK 逐字可断；用于布局函数的受控换行） */
export function wrapToLines(text: string, maxWidth: number, fontSize: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const char of text) {
    if (char === "\n") {
      lines.push(current);
      current = "";
      continue;
    }
    if (current && estimateLineWidth(current + char, fontSize) > maxWidth) {
      lines.push(current);
      current = char;
    } else {
      current += char;
    }
  }
  if (current || lines.length === 0) lines.push(current);
  return lines;
}

/** 截断到估算宽度以内，超出部分以省略号结尾（保证单行不溢出） */
export function truncateToWidth(text: string, maxWidth: number, fontSize: number): string {
  if (estimateLineWidth(text, fontSize) <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && estimateLineWidth(`${out}…`, fontSize) > maxWidth) {
    out = out.slice(0, -1);
  }
  return `${out}…`;
}

/** 先按宽度换行再整体适配字号；最小字号下仍放不下的行截断省略（不抛错） */
export function fitWrappedText(
  text: string,
  maxWidth: number,
  startSize: number,
  minSize: number,
): { lines: string[]; fontSize: number } {
  let size = startSize;
  while (size > minSize) {
    const lines = wrapToLines(text, maxWidth, size);
    if (lines.every((line) => estimateLineWidth(line, size) <= maxWidth)) {
      return { lines, fontSize: size };
    }
    size = Math.floor(size * 0.92);
  }
  return {
    lines: wrapToLines(text, maxWidth, minSize).map((line) =>
      truncateToWidth(line, maxWidth, minSize),
    ),
    fontSize: minSize,
  };
}
