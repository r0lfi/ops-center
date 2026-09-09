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
