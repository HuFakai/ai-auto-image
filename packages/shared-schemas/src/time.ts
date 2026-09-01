/** 项目统一业务时区：北京时间。数据库仍保存 Unix 毫秒时间戳。 */
export const BEIJING_TIME_ZONE = "Asia/Shanghai";

/** 生成带 +08:00 偏移的 ISO 时间，供日志、清单和 API 时间字段使用。 */
export function toBeijingIsoString(value: number | Date = Date.now()): string {
  const timestamp = value instanceof Date ? value.getTime() : value;
  return new Date(timestamp + 8 * 60 * 60 * 1000).toISOString().replace("Z", "+08:00");
}

/** 北京时间自然日键。 */
export function beijingDateKey(value: number | Date = Date.now()): string {
  return toBeijingIsoString(value).slice(0, 10);
}

/** 指定时刻所在北京时间自然日的起点。 */
export function beijingStartOfDay(value: number | Date = Date.now()): number {
  return Date.parse(`${beijingDateKey(value)}T00:00:00+08:00`);
}
