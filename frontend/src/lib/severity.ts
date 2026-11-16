export type SeverityVariant = "ok" | "warning" | "critical" | "unknown";

const VARIANTS: Record<string, SeverityVariant> = {
  critical: "critical", high: "critical", important: "critical",
  medium: "warning", moderate: "warning", warning: "warning",
  low: "ok",
  info: "unknown", unknown: "unknown",
};

/** One color for each severity word, on every page. */
export function severityVariant(severity: string | null | undefined): SeverityVariant {
  return VARIANTS[(severity ?? "").toLowerCase()] ?? "unknown";
}
