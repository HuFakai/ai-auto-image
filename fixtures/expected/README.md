# 视觉快照基线

确定性渲染的「可重复」验证目前采用**字节级一致性测试**（同输入同字体两次渲染逐字节相等），
强于 pixelmatch 差异阈值，因此阶段 0 不存放 PNG 基线。

若后续引入会破坏字节级确定性的能力（如渐变随机种子、字体渲染引擎升级），
再在此目录存放 `cover.png / content.png / summary.png` 基线，并用 pixelmatch 做阈值对比：

```bash
pnpm --filter @aai/render-engine test
```
