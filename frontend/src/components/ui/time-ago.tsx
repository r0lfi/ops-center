import { formatDateTime, formatRelativeTime } from "@/lib/format";

/** Relative time with the full 24-hour timestamp on hover. */
export function TimeAgo({ value, fallback = "never", className }: { value: string | null | undefined; fallback?: string; className?: string }) {
  if (!value) return <span className={className}>{fallback}</span>;
  return <time dateTime={value} title={formatDateTime(value)} className={className}>{formatRelativeTime(value)}</time>;
}
