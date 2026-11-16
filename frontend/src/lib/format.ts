type DateInput = string | number | Date | null | undefined;

const LOCALE = "en-GB";
const CLOCK = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } as const;
const dateTimeFormat = new Intl.DateTimeFormat(LOCALE, { day: "numeric", month: "short", year: "numeric", ...CLOCK, second: "2-digit" });
const dateFormat = new Intl.DateTimeFormat(LOCALE, { day: "numeric", month: "short", year: "numeric" });
const timeFormat = new Intl.DateTimeFormat(LOCALE, { ...CLOCK, second: "2-digit" });
const dayTimeFormat = new Intl.DateTimeFormat(LOCALE, { day: "numeric", month: "short", ...CLOCK, second: "2-digit" });
const clockFormat = new Intl.DateTimeFormat(LOCALE, CLOCK);
const numberFormat = new Intl.NumberFormat(LOCALE);

function using(format: Intl.DateTimeFormat, value: DateInput) {
  if (value === null || value === undefined || value === "") return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : format.format(date);
}

/** 6 Nov 2026, 16:20:15. The one full timestamp format in the app. */
export const formatDateTime = (value: DateInput) => using(dateTimeFormat, value);
/** 6 Nov 2026 */
export const formatDate = (value: DateInput) => using(dateFormat, value);
/** 6 Nov, 16:20:15. For lists that span days. */
export const formatDayTime = (value: DateInput) => using(dayTimeFormat, value);
/** 16:20:15 */
export const formatTime = (value: DateInput) => using(timeFormat, value);
/** 16:20 */
export const formatClock = (value: DateInput) => using(clockFormat, value);
/** 12,345 */
export const formatNumber = (value: number | null | undefined) => (value === null || value === undefined ? "—" : numberFormat.format(value));

export function formatRelativeTime(iso: string | null): string {
  if (!iso) return "never";
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${Math.floor(seconds)}s ago`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.floor(minutes)}m ago`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.floor(hours)}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatBytes(value: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = Math.max(value, 0);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 ? v.toFixed(1) : v.toFixed(0)} ${units[i]}`;
}

export function formatBytesPerSec(value: number): string {
  const units = ["B/s", "KB/s", "MB/s", "GB/s"];
  let v = Math.max(value, 0);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 ? v.toFixed(1) : v.toFixed(0)} ${units[i]}`;
}
