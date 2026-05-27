// ─── UI HTML asset loader ─────────────────────────────────────────────────────
// This static import is embedded at compile time by `bun build --compile`.
// Run `bun run build:ui` (in web-ui/) before starting the backend in dev mode.
import DIST_UI_HTML from "./dist-ui/index.html" with { type: "text" }

export const UI_HTML: string = DIST_UI_HTML as unknown as string
