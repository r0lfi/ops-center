import { STATUS_LABEL, type FloorStatus } from "@/lib/opsFloor/model";

/** Each status has its own shape, so color is never the only signal. */
export function StatusGlyph({ status, size = 12 }: { status: FloorStatus; size?: number }) {
  return (
    <svg className={`of-glyph of-glyph-${status}`} width={size} height={size} viewBox="0 0 12 12" aria-hidden="true">
      {status === "paused" && <rect x="1" y="5" width="10" height="2" fill="currentColor" />}
      {status === "idle" && <circle cx="6" cy="6" r="4" fill="none" stroke="currentColor" strokeWidth="2" />}
      {status === "working" && <circle cx="6" cy="6" r="5" fill="currentColor" />}
      {status === "approval" && <path d="M6 0 12 6 6 12 0 6Z" fill="currentColor" />}
      {status === "error" && <path d="M6 1 12 11H0Z" fill="currentColor" />}
    </svg>
  );
}

export function StatusLabel({ status }: { status: FloorStatus }) {
  return <span className={`of-status of-tx-${status}`}><StatusGlyph status={status} />{STATUS_LABEL[status]}</span>;
}
