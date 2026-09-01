# 评测输入样例（阶段 0 固定评测集起步）

## 1. 中文知识主题（主样例）

```text
topic: 三分钟看懂量子纠缠
platform: xiaohongshu
aspectRatio: "3:4"
# 图片由模型直接生成中文最终图，不再配置文字渲染模式。
```

要点：概念易混（纠缠 ≠ 超距传信），验证模型是否遵守「禁止出现的断言」与逐字文案。

## 2. 图书推荐

```text
topic: 《置身事内》：看懂中国经济运转的一本入门书
platform: xiaohongshu
aspectRatio: "3:4"
```

要点：书名与摘录必须逐字准确（高风险字段），适合验证预期文案检查与失败重试。

## 3. 商品宣传（缺参数场景）

```text
topic: 保温杯「晨屿」：6 小时保温的通勤水杯
platform: xiaohongshu
aspectRatio: "3:4"
missing: 价格未提供 —— 模型不得编造价格
```

要点：输入不含价格时，页面不得出现任何价格数字（Recipe 输出约束）。
