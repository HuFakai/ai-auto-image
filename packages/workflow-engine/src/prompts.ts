import type { ContentBrief, CreateRunInput, Storyboard, StoryboardSlide, TextRenderingMode } from "@aai/shared-schemas";

/** Brand Kit 风格注入片段（native 与 deterministic 共用） */
export function buildStyleHint(input: CreateRunInput): string[] {
  const kit = input.brandKit;
  if (!kit) return [];
  const lines: string[] = [];
  if (kit.styleKeywords.length > 0) {
    lines.push(`画面风格：${kit.styleKeywords.join("、")}。`);
  }
  if (kit.negativeKeywords.length > 0) {
    lines.push(`画面中不得出现：${kit.negativeKeywords.join("、")}。`);
  }
  return lines;
}

/** 节点统一用「字段：值」的行格式拼 Prompt，Provider 与测试都可以稳定解析 */
export function buildBriefPrompt(input: CreateRunInput): string {
  const lines = [
    `主题：${input.topic}`,
    `目标平台：${input.platform}`,
    "任务：为这套图文生成 Content Brief。",
    "要求：提炼目标受众、核心判断与证据；列出该主题下的表达禁区。",
  ];
  if (input.sourceText) {
    lines.push(
      "参考资料正文（事实只能来自用户输入与以下资料，不得编造超出资料的事实）：",
      "<<<资料开始>>>",
      input.sourceText.slice(0, 6000),
      "<<<资料结束>>>",
    );
  } else {
    lines.push("要求：不得编造用户未提供的事实。");
  }
  return lines.join("\n");
}

const DENSITY_RULES = [
  "分页密度约束：",
  "- 全套 6–10 页（含封面与总结/CTA）。",
  "- 每页只承载一个要点；正文每页不超过 3 条，每条不超过 20 个字。",
  "- 资料中的一个独立论点/步骤/误区占一页，不要把多个论点挤进同一页。",
].join("\n");

export function buildStoryboardPrompt(input: CreateRunInput, brief: ContentBrief): string {
  const lines = [
    `主题：${input.topic}`,
    `目标平台：${input.platform}`,
    `画布比例：${input.aspectRatio}`,
    `核心判断：${brief.coreMessage}`,
    "任务：生成 Storyboard（封面、正文、总结/CTA）。",
    "约束：封面只有一个主标题和一个辅助信息区；单页只表达一个核心观点；正文每页不超过 3 条要点；最后一页是总结或 CTA。",
  ];
  if (input.sourceText) {
    // 密度驱动拆页：长文按要点密度拆为 6–10 页
    lines.push(DENSITY_RULES);
    lines.push(
      "参考资料正文（拆页依据：按资料的自然论点顺序拆页，覆盖全部要点，不得遗漏核心论点）：",
      "<<<资料开始>>>",
      input.sourceText.slice(0, 12000),
      "<<<资料结束>>>",
    );
  } else {
    lines.push("任务：生成 4–6 页。");
  }
  return lines.join("\n");
}

export interface SlidePromptPlan {
  imagePrompt: string;
  expectedCopy: string[];
}

/**
 * 组装单页图片 Prompt 与预期文案。
 * native：已确认文案逐字写入 Prompt，要求模型生成含中文的完整图片；
 * deterministic：只要无文字视觉层，为程序排版预留安全区。
 */
export function buildSlidePrompt(
  slide: StoryboardSlide,
  storyboard: Storyboard,
  input: CreateRunInput,
  mode: TextRenderingMode,
): SlidePromptPlan {
  const pageCount = storyboard.slides.length;
  const pageLabel = `${slide.index + 1}/${pageCount}`;
  const styleLines = buildStyleHint(input);

  if (mode === "native") {
    const copyLines = [slide.headline, ...slide.body].filter((line) => line.trim().length > 0);
    const expectedCopy = [...copyLines, pageLabel];
    const imagePrompt = [
      `主题：${input.topic}`,
      `标题：${slide.headline}`,
      slide.body.length > 0
        ? `正文（必须逐字出现，不得增删改）：\n${slide.body.map((line) => `- ${line}`).join("\n")}`
        : "正文：无",
      `页码：${pageLabel}`,
      `画布比例：${input.aspectRatio}`,
      `目标平台：${input.platform}`,
      `画面：${slide.visualIntent}。版式：${slide.layoutHint}。`,
      ...styleLines,
      "要求：图中中文必须清晰可读、无错字、无缺字；除上述文字外，画面中不得出现任何其他文字、数字、水印或 Logo。",
    ].join("\n");
    return { imagePrompt, expectedCopy };
  }

  return {
    imagePrompt: [
      `主题：${input.topic}`,
      `画布比例：${input.aspectRatio}`,
      `画面：${slide.visualIntent}。版式：${slide.layoutHint}。`,
      ...styleLines,
      "要求：只生成无文字的视觉层（背景、插画、装饰）；画面中绝对不要出现任何文字、数字、字母、水印或 Logo；四周各预留 8% 安全边距供后续排版。",
    ].join("\n"),
    expectedCopy: [],
  };
}
