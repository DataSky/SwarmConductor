export function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

export function fmtTimeAgo(ms: number): string {
  const d = Date.now() - ms
  if (d < 60_000)    return "just now"
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`
  return `${Math.floor(d / 86_400_000)}d ago`
}

export function fmtElapsed(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}

export function fmtEta(ms: number): string {
  if (ms < 60_000) return `~${Math.round(ms / 1000)}s`
  return `~${Math.ceil(ms / 60_000)}m`
}

export function fmtNum(n: number): string {
  return Number(n).toLocaleString()
}

export const STATUS_ICON: Record<string, string> = {
  done: "✓", running: "⟳", ready: "○", blocked: "·",
  failed: "✗", interrupted: "!", pending: "·",
}

export const STATUS_COLOR: Record<string, string> = {
  done: "var(--green)", running: "var(--cyan)", ready: "var(--cyan)",
  blocked: "var(--dim)", failed: "var(--red)", interrupted: "var(--yellow)",
  pending: "var(--dim)",
}

export const TYPE_SHORT: Record<string, string> = {
  explore: "exp", plan: "pln", implement: "imp",
  review: "rev", verify: "vfy", merge: "mrg",
}

const MODEL_SHORT: Record<string, string> = {
  "deepseek-v4-pro": "dv4p", "deepseek-v4-flash": "dv4f",
  "deepseek-v3": "dv3",      "deepseek-reasoner": "r1",
  "claude-opus-4-7": "opus", "claude-sonnet-4-6": "son",
  "gpt-4.1": "g41",          "gpt-4.1-mini": "g4m",
  "gpt-4o": "4o",            "gemini-2.5-pro": "g25p",
}

export function shortModel(m: string | null): string {
  if (!m) return ""
  return MODEL_SHORT[m] ?? m.split(/[-/]/).at(-1)?.slice(0, 5) ?? m.slice(0, 5)
}
