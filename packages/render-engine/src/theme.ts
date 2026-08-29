/** 知识卡片主题：暗房工作室风格（与 Studio UI 同一视觉语言） */
export interface CardTheme {
  name: string;
  version: number;
  colors: {
    background: string;
    surface: string;
    ink: string;
    accent: string;
    muted: string;
    line: string;
  };
  fontFamily: string;
  templateVersion: string;
}

export const knowledgeCardTheme: CardTheme = {
  name: "darkroom-knowledge",
  version: 1,
  colors: {
    background: "#0e0e10",
    surface: "#17171b",
    ink: "#f4f1ea",
    accent: "#f5a524",
    muted: "#9b97a0",
    line: "#2c2c33",
  },
  fontFamily: "Noto Sans SC",
  templateVersion: "darkroom-knowledge@1",
};
