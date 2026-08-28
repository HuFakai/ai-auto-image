import type { AspectRatio, ContentBrief, Platform, Storyboard, TextRenderingMode } from "@aai/shared-schemas";
import { PROMPT_VERSION } from "./config";
import { recipeOf } from "./recipes";

export const prompts = {
  brief: {
    version: PROMPT_VERSION,
    build(input: { inputText: string; inputKind: string; recipeId: string; product?: unknown; book?: unknown }): string {
      const recipe = recipeOf(input.recipeId);
      const extras =
        input.inputKind === "product"
          ? `\n商品资料（价格、参数必须原样保留，禁止编造）：\n${JSON.stringify(input.product ?? null, null, 2)}`
          : input.inputKind === "book"
            ? `\n图书资料（摘录必须逐字保留）：\n${JSON.stringify(input.book ?? null, null, 2)}`
            : "";
      return [
        `你是一名资深中文自媒体内容策划。请根据以下输入，为「${recipe.name}」内容生成 Content Brief。`,
        `内容约束：\n${recipe.constraints.map((c) => `- ${c}`).join("\n")}`,
        `\n输入类型：${input.inputKind}`,
        `\n输入内容：\n${input.inputText.slice(0, 6000)}${extras}`,
        "",
        "要求：",
        "- coreMessage 是一句话核心判断，具体、可验证",
        "- evidence 中不得出现输入之外的编造事实；无法确认的标注 confidence=inferred",
        "- prohibitedClaims 列出该主题下不能出现的夸大或绝对化表达",
        "只输出符合 schema 的 JSON。",
      ].join("\n");
    },
  },
  storyboard: {
    version: PROMPT_VERSION,
    build(input: {
      brief: ContentBrief;
      recipeId: string;
      platform: Platform;
      aspectRatio: string;
      slideCount: number;
      titles?: string[];
    }): string {
      const recipe = recipeOf(input.recipeId);
      return [
        `你是一名小红书/抖音爆款图文设计师。基于以下 Content Brief，生成一套 ${input.slideCount} 页的 Storyboard。`,
        `平台：${input.platform}，画布比例：${input.aspectRatio}。`,
        `内容类型：${recipe.name}。约束：\n${recipe.constraints.map((c) => `- ${c}`).join("\n")}`,
        `\nContent Brief：\n${JSON.stringify(input.brief, null, 2)}`,
        input.titles?.length ? `\n已确认标题：${input.titles[0]}` : "",
        "",
        "要求：",
        `- 第 1 页 role=cover：headline 是主标题（不超过 16 字），body 只有一行辅助信息`,
        "- 中间页 role=content：headline 不超过 14 字；body 每页 2-4 条短句，每条不超过 26 字",
        "- 最后 1 页 role=cta 或 summary",
        "- visualIntent 描述这一页的画面视觉（人物/物品/场景/构图/色调），不包含要绘制的文字",
        "- layoutHint 从以下选择：center-title | title-bullets | split-image | full-bleed",
        "- 严禁在 visualIntent 中要求生成文字、logo、水印",
        "只输出符合 schema 的 JSON。",
      ]
        .filter(Boolean)
        .join("\n");
    },
  },
  platformCopy: {
    version: PROMPT_VERSION,
    build(input: { storyboard: Storyboard; platform: Platform }): string {
      const spec = { xiaohongshu: { max: 20 }, douyin: { max: 30 }, wechat: { max: 64 } }[input.platform];
      return [
        `基于以下 Storyboard 生成 ${input.platform} 发布文案。`,
        `标题不超过 ${spec.max} 字，带一个 emoji；正文用短段落和换行，口语化、有钩子、结尾有 CTA；`,
        `标签 4-8 个，格式如 #知识科普。不要出现"标题："等前缀。`,
        `\nStoryboard：\n${JSON.stringify(input.storyboard, null, 2)}`,
        '只输出 JSON：{"title":"...","body":"...","tags":["#..."]}',
      ].join("\n");
    },
  },
  characterBible: {
    version: PROMPT_VERSION,
    build(input: { topic: string; characterCount: number }): string {
      return [
        `为科普漫画设计 ${input.characterCount} 个角色的 Character Bible。主题：${input.topic}`,
        "要求：每个角色有鲜明且可复现的外形描述（发型、脸型、服装、配色、显著特征），",
        "canonicalPrompt 是一段可直接用于文生图的英文角色描述（含 all views consistent）。",
        '只输出 JSON 数组，每项：{"name":"...","ageRange":"...","faceShape":"...","hair":"...","distinctiveFeatures":["..."],"palette":["#hex"],"outfits":[{"name":"...","description":"..."}],"canonicalPrompt":"..."}',
      ].join("\n");
    },
  },
  sceneBible: {
    version: PROMPT_VERSION,
    build(input: { topic: string; sceneCount: number }): string {
      return [
        `为科普漫画设计 ${input.sceneCount} 个场景的 Scene Bible。主题：${input.topic}`,
        "canonicalPrompt 是一段可直接用于文生图的英文场景描述（lighting, spatial layout 固定）。",
        '只输出 JSON 数组，每项：{"name":"...","timeOfDay":"...","lighting":"...","keyProps":["..."],"palette":["#hex"],"canonicalPrompt":"..."}',
      ].join("\n");
    },
  },
  comicStoryboard: {
    version: PROMPT_VERSION,
    build(input: { topic: string; facts: string; characters: unknown; scenes: unknown; panelCount: number }): string {
      return [
        `基于主题、事实、角色和场景 Bible，生成 ${input.panelCount} 格科普漫画分镜。`,
        `\n主题：${input.topic}\n事实要点：${input.facts.slice(0, 2000)}`,
        `\n角色：${JSON.stringify(input.characters)}\n场景：${JSON.stringify(input.scenes)}`,
        "要求：每格一个知识点；动作和表情明确；对白简短（每条不超过 40 字）；标注 sceneId 和角色 outfit。",
        '只输出 JSON：{"panels":[{"shot":"中景","camera":"...","characterIds":["c1"],"outfitIds":{"c1":"o1"},"sceneId":"s1","action":"...","expressions":{"c1":"惊讶"},"dialogue":[{"speakerId":"c1","type":"speech","text":"..."}],"continuityNotes":"..."}]}',
      ].join("\n");
    },
  },
};

/** Build the image prompt for one slide — the heart of native text mode. */
export function buildSlideImagePrompt(input: {
  slide: Storyboard["slides"][number];
  mode: TextRenderingMode;
  aspectRatio: AspectRatio | string;
  styleKeywords: string[];
  negativeKeywords: string[];
  brandName?: string;
  coverSubject?: string;
}): string {
  const { slide, mode, aspectRatio } = input;
  const style = input.styleKeywords.length ? input.styleKeywords.join("、") : "干净现代的中文排版设计";
  const negative = input.negativeKeywords.length ? input.negativeKeywords.join("、") : "水印、乱码文字、错误汉字";

  if (mode === "native") {
    const textLines: string[] = [];
    if (slide.role === "cover") {
      textLines.push(`主标题（画面最醒目位置，大号粗体）：「${slide.headline}」`);
      if (slide.body[0]) textLines.push(`副标题（小号文字）：「${slide.body[0]}」`);
    } else {
      textLines.push(`页面标题（顶部，大号粗体）：「${slide.headline}」`);
      if (slide.body.length) {
        textLines.push(`正文要点（逐条清晰可读，分点排版）：`);
        slide.body.forEach((b, i) => textLines.push(`  ${i + 1}. 「${b}」`));
      }
    }
    return [
      `设计一张 ${aspectRatio} 竖版中文信息图卡片（中文自媒体配图风格）。`,
      `画面视觉：${slide.visualIntent || input.coverSubject || "简约几何装饰与柔和渐变背景"}。`,
      `整体风格：${style}。`,
      "",
      `图中必须准确包含以下中文文字，一个字都不能错、不能多、不能少，保持正确中文语法和自然断行：`,
      ...textLines,
      "",
      `排版要求：留白充足、层级清晰、对比度达标（WCAG AA），文字区域不得被插画遮挡。`,
      `画面中除上述文字外不得出现任何其他文字、字母、数字、水印或 logo。禁止出现：${negative}。`,
    ].join("\n");
  }

  // deterministic mode: no text in the image at all
  return [
    `生成一张 ${aspectRatio} 的无文字视觉插画，用于中文信息卡片。`,
    `画面内容：${slide.visualIntent || input.coverSubject || "与主题相关的简约插画"}。`,
    `风格：${style}。`,
    `画面必须预留大面积干净的负空间用于后续文字排版（标题在上方，正文在中下部）。`,
    `严禁出现任何文字、字母、数字、水印、logo；书页、招牌、包装上的装饰性伪文字（乱码线条字）也一律不允许，用空白或纯色纹理代替。禁止出现：${negative}。`,
  ].join("\n");
}

/** English prompt for comic panels with continuity injection. */
export function buildPanelPrompt(input: {
  panel: string; // ComicPanel JSON
  index: number;
  panelCount: number;
  characters: Array<{ id: string; canonicalPrompt: string; outfit?: { name: string; description: string } }>;
  scene?: { canonicalPrompt: string };
  previousPanelSummary?: string;
  aspectRatio: string;
  mode: TextRenderingMode;
}): string {
  const parts = [
    `Comic panel ${input.index + 1} of ${input.panelCount}, ${input.aspectRatio} aspect ratio, consistent comic art style.`,
    input.scene ? `Scene: ${input.scene.canonicalPrompt}` : "",
    ...input.characters.map(
      (c) =>
        `Character (${c.id}): ${c.canonicalPrompt}${c.outfit ? `, wearing ${c.outfit.name} (${c.outfit.description})` : ""}`
    ),
    input.previousPanelSummary ? `Continuity from previous panel: ${input.previousPanelSummary}` : "",
    `Action/beat: ${input.panel}`,
    input.mode === "native"
      ? "Include Chinese dialogue in speech bubbles exactly as specified, drawn clearly and correctly."
      : "Leave clean empty speech-bubble areas; absolutely NO text, letters or words anywhere in the image.",
  ].filter(Boolean);
  return parts.join("\n");
}
