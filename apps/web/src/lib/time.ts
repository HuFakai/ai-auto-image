import { BEIJING_TIME_ZONE } from "@aai/shared-schemas";

type TimeValue = number | string | Date;

export function formatBeijingDate(value: TimeValue, options: Intl.DateTimeFormatOptions = {}): string {
  return new Date(value).toLocaleDateString("zh-CN", { timeZone: BEIJING_TIME_ZONE, ...options });
}

export function formatBeijingDateTime(value: TimeValue, options: Intl.DateTimeFormatOptions = {}): string {
  return new Date(value).toLocaleString("zh-CN", {
    timeZone: BEIJING_TIME_ZONE,
    hour12: false,
    ...options,
  });
}
