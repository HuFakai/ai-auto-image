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

/** 各 Recipe 的 Brief 附加指令（默认空：保持 knowledge_cards 行为不变） */
function buildRecipeBriefLines(input: CreateRunInput): string[] {
  switch (input.recipe) {
    case "quote_cards":
      return ["内容类型：金句卡。Brief 需给出围绕主题的 4–6 条金句候选与一条核心判断；金句简短有力、可直接作为大字文案。"];
    case "checklist_cards":
      return ["内容类型：清单卡。Brief 需给出可执行的步骤/要点主清单（供拆成每页 3–5 条编号条目），并明确行动号召。"];
    case "comparison_cards":
      return input.comparisonTarget
        ? [`内容类型：对比卡。对比对象 B 已指定：${input.comparisonTarget}；Brief 需给出 A 与 B 的 3–5 个对比维度框架。`]
        : ["内容类型：对比卡。对比对象 B 未指定；Brief 需从主题语境确定一个合理的对比对象，并给出 3–5 个对比维度框架。"];
    case "product_showcase": {
      const info = input.productInfo;
      const lines = [
        info?.name
          ? `内容类型：产品种草。产品：${info.name}。Brief 需给出产品定位、目标人群、3–5 个卖点与促单行动号召；卖点须有依据，不得夸大功效。`
          : "内容类型：产品种草。Brief 需给出产品定位、目标人群、3–5 个卖点与促单行动号召；卖点须有依据，不得夸大功效。",
      ];
      if (input.sourceText) lines.push("产品资料正文（sourceText）为唯一事实来源，卖点与价格以资料为准。");
      return lines;
    }
    case "book_recommendations": {
      const info = input.bookInfo;
      const head = info
        ? `内容类型：图书推荐。书目：${info.title ?? "书名未指定"}${info.author ? `（作者：${info.author}）` : ""}。`
        : "内容类型：图书推荐。书目由主题推断。";
      return [`${head}Brief 需给出 3–5 条书中最值得分享的金句/观点与推荐理由；金句不得编造，来源不明的观点须标注为概括转述。`];
    }
    case "article_digest":
      return ["内容类型：长文拆解。Brief 需按原文结构提炼核心论点（3–8 页拆解骨架），忠实原文，不得编造。"];
    default:
      return [];
  }
}

/** 节点统一用「字段：值」的行格式拼 Prompt，Provider 与测试都可以稳定解析 */
export function buildBriefPrompt(input: CreateRunInput): string {
  const lines = [
    `主题：${input.topic}`,
    `目标平台：${input.platform}`,
    "任务：为这套图文生成 Content Brief。",
    "要求：提炼目标受众、核心判断与证据；列出该主题下的表达禁区。",
    ...buildRecipeBriefLines(input),
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

/** 长文拆解专用拆页约束（article_digest）：忠实原文结构，不编造 */
const ARTICLE_DIGEST_RULES = [
  "拆解约束（长文拆解专用）：",
  "- 全套 3–8 页（含封面）。",
  "- 按原文的论点顺序拆页，覆盖全部核心论点，不得遗漏。",
  "- 忠实原文结构与事实：不得编造、不得曲解、不得增删原文内容；观点、数据与结论必须来自原文。",
].join("\n");

/** 各 Recipe 的 Storyboard 结构指令（默认空：保持 knowledge_cards 行为不变） */
function buildRecipeStoryboardLines(input: CreateRunInput): string[] {
  switch (input.recipe) {
    case "quote_cards":
      return [
        "内容类型：金句卡。围绕主题提炼 4–6 句金句，每页一句金句 + 一句短注解；封面页为主题大字。",
        "页数：全套 5–7 页（封面 1 页 + 金句页 4–6 页）。",
        "约束：金句简短有力、适合大字直出；短注解每句不超过 20 字；每页只放一句金句，画面留白充足。",
      ];
    case "checklist_cards":
      return [
        "内容类型：清单卡。把主题拆成可执行的步骤/要点清单，每页 3–5 条编号条目。",
        "页数：全套 4–6 页（封面 1 页 + 清单页 2–4 页 + 行动号召尾页 1 页）。",
        "约束：编号条目短小精炼（每条不超过 20 字）、彼此独立、可照做；尾页给出明确的行动号召。",
      ];
    case "comparison_cards":
      return [
        "内容类型：对比卡。对比对象 A（主题）与对象 B。",
        input.comparisonTarget
          ? `对比对象 B：${input.comparisonTarget}。`
          : "对比对象 B：用户未指定；请从主题语境确定一个合理、常见的对比对象，并在封面标注 A vs B。",
        "页数：全套 5–7 页（封面「A vs B」1 页 + 对比维度页 3–5 页 + 结论页 1 页）。",
        "约束：每页只对比一个维度，同时列出 A 与 B 在该维度上的差异，信息对仗；结论页给出选型/判断建议。",
      ];
    case "product_showcase": {
      const info = input.productInfo;
      const lines = [
        "内容类型：产品种草。首图放产品主视觉，正文逐页拆卖点，尾页促单。",
        info
          ? `产品资料：${info.name ?? "产品名称未指定"}${info.audience ? `；目标人群：${info.audience}` : ""}${info.priceNote ? `；价格说明：${info.priceNote}` : ""}${info.sellingPoints?.length ? `；卖点：${info.sellingPoints.join("、")}` : ""}。`
          : "产品资料：用户未提供结构化资料；以主题中的产品为对象，卖点只写可佐证的，不得编造具体参数、价格与功效。",
      ];
      if (input.sourceText) lines.push("补充：sourceText 即为产品资料正文，产品名称、卖点与价格一律以资料为准。");
      lines.push(
        "页数：全套 5–7 页（产品主图 1 页 + 卖点页 3–5 页 + 促单尾页 1 页）。",
        "约束：每页只讲一个卖点，卖点要落到用户场景；尾页给出明确的促单行动号召，不夸大功效。",
      );
      return lines;
    }
    case "book_recommendations": {
      const info = input.bookInfo;
      const head = info
        ? `书目信息：${info.title ?? "书名未指定"}${info.author ? `（作者：${info.author}）` : ""}。`
        : "书目信息：用户未指定；书名与作者由主题推断。";
      return [
        "内容类型：图书推荐。每页提炼一条书中金句或核心观点，并给出推荐理由。",
        head,
        "页数：全套 4–6 页（封面带书名 1 页 + 推荐页 3–5 页）。",
        "约束：每页一条金句/观点 + 一句推荐理由；封面大字写书名与作者；金句引用须与资料一致，不得虚构书中原文。",
      ];
    }
    case "article_digest":
      return [
        "内容类型：长文拆解。忠实原文结构与事实，把长文提炼为 3–8 页要点拆解。",
        "页数：全套 3–8 页。",
        "与知识卡片的差异：知识卡片围绕主题自由创作；拆解是提炼原文——按原文论点顺序拆页，只讲原文已有的内容，不得编造、不得偏离原文结论。",
      ];
    default:
      return [];
  }
}

export function buildStoryboardPrompt(input: CreateRunInput, brief: ContentBrief): string {
  const lines = [
    `主题：${input.topic}`,
    `目标平台：${input.platform}`,
    `画布比例：${input.aspectRatio}`,
    `核心判断：${brief.coreMessage}`,
  ];
  const recipeLines = buildRecipeStoryboardLines(input);
  if (recipeLines.length > 0) {
    lines.push(...recipeLines);
  } else {
    lines.push(
      "任务：生成 Storyboard（封面、正文、总结/CTA）。",
      "约束：封面只有一个主标题和一个辅助信息区；单页只表达一个核心观点；正文每页不超过 3 条要点；最后一页是总结或 CTA。",
    );
  }
  if (input.sourceText) {
    // 密度驱动拆页：长文按要点密度拆为 6–10 页；article_digest 走忠实原文的 3–8 页拆解
    lines.push(input.recipe === "article_digest" ? ARTICLE_DIGEST_RULES : DENSITY_RULES);
    lines.push(
      "参考资料正文（拆页依据：按资料的自然论点顺序拆页，覆盖全部要点，不得遗漏核心论点）：",
      "<<<资料开始>>>",
      input.sourceText.slice(0, 12000),
      "<<<资料结束>>>",
    );
  } else if (input.recipe === "article_digest") {
    lines.push("注意：长文拆解必须基于参考资料正文；本次未提供正文，请在 Storyboard 中标注素材不足，只做主题性概述。");
  } else if (recipeLines.length === 0) {
    lines.push("任务：生成 4–6 页。");
  }
  return lines.join("\n");
}

export interface SlidePromptPlan {
  imagePrompt: string;
  expectedCopy: string[];
}

/** 单页图片 Prompt 的 Recipe 附加指令（native 模式；默认空） */
function buildSlideRecipeLines(input: CreateRunInput): string[] {
  switch (input.recipe) {
    case "quote_cards":
      return ["版式：金句为画面绝对主角，粗体大字居中，注解小字为辅，留白充足。"];
    default:
      return [];
  }
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
      ...buildSlideRecipeLines(input),
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

/**
 * 科普漫画分镜 Prompt（comic 管线 generate-comic-storyboard 节点）：
 * comic_story 保持原有指令；strip_comic 为四格漫画变体（1–2 页、每页四格起承转合、对白精简）。
 */
export function buildComicStoryboardPrompt(
  input: CreateRunInput,
  brief: Pick<ContentBrief, "coreMessage">,
  castText: string,
): string {
  const base = [
    `主题：${input.topic}`,
    "核心结论：" + brief.coreMessage,
    "角色锚点（分镜必须使用这些角色，不得新增有对白的角色）：",
    castText,
  ];
  if (input.recipe === "strip_comic") {
    return [
      ...base,
      "内容类型：四格漫画（strip_comic）。",
      "任务：生成 1–2 页四格漫画分镜（每页是一个完整四格故事，节奏为起承转合）。",
      "要求：每页在 scene 与 visualPrompt 中描述四格布局与节奏（起/承/转/合），同一页内四格串联讲完一个小情节；对白精简，每格 0–1 条对白（dialogues，speaker 必须是角色名，type=speech）或整页一条旁白（type=narration）；最后一页收在核心结论上。",
      input.sourceText ? `参考资料：\n<<<资料>>>\n${input.sourceText.slice(0, 6000)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }
  return [
    ...base,
    "任务：生成 3–6 页科普漫画分镜。",
    "要求：每页一个场景（scene）与画面描述（visualPrompt）；出场角色（cast）标注本页出现的角色名；每页 1–3 条对白（dialogues，speaker 必须是角色名，type=speech）或一条旁白（type=narration）；最后一页传递核心结论。",
    input.sourceText ? `参考资料：\n<<<资料>>>\n${input.sourceText.slice(0, 6000)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
