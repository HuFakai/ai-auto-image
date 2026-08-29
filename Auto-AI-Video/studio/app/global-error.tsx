"use client";

export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <html lang="zh-CN">
      <body>
        <main className="shell">
          <div className="notice" role="alert">
            <div><strong>创作台加载失败</strong><span>请确认 API 与前端服务都已启动。</span></div>
            <button className="icon-button" onClick={reset}>重试</button>
          </div>
        </main>
      </body>
    </html>
  );
}
