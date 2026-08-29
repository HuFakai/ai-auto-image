import type { ContentBrief, CreateRunInput, Storyboard, StoryboardSlide, TextRenderingMode } from "@aai/shared-schemas";

/** 节点统一用「字段：值」的行格式拼 Prompt，Provider 与测试都可以稳定解析 */
export function buildBriefPrompt(input: CreateRunInput): string {
  return [
    `主题：${input.topic}`,
    `目标平台：${input.platform}`,
    "任务：为这套图文生成 Content Brief。",
    "要求：提炼目标受众、核心判断与证据；不得编造用户未提供的事实；列出该主题下的表达禁区。",
  ].join("\n");
}

export function buildStoryboardPrompt(input: CreateRunInput, brief: ContentBrief): string {
  return [
    `主题：${input.topic}`,
    `目标平台：${input.platform}`,
    `画布比例：${input.aspectRatio}`,
    `核心判断：${brief.coreMessage}`,
    "任务：生成 4–6 页 Storyboard（封面、正文、总结/CTA）。",
    "约束：封面只有一个主标题和一个辅助信息区；单页只表达一个核心观点；正文每页不超过 3 条要点；最后一页是总结或 CTA。",
  ].join("\n");
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
      "要求：图中中文必须清晰可读、无错字、无缺字；除上述文字外，画面中不得出现任何其他文字、数字、水印或 Logo。",
    ].join("\n");
    return { imagePrompt, expectedCopy };
  }

  return {
    imagePrompt: [
      `主题：${input.topic}`,
      `画布比例：${input.aspectRatio}`,
      `画面：${slide.visualIntent}。版式：${slide.layoutHint}。`,
      "要求：只生成无文字的视觉层（背景、插画、装饰）；画面中绝对不要出现任何文字、数字、字母、水印或 Logo；四周各预留 8% 安全边距供后续排版。",
    ].join("\n"),
    expectedCopy: [],
  };
}
