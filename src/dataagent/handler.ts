import { DuckDBInstance } from "@duckdb/node-api"
import { DATA_AGENT_TOOLS } from "./tools"
import {
  execExploreSchema, execRunSql, execMakeChart, execRunPython, execSearchWiki,
} from "./executor"

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DataAgentRequest {
  question: string
  dbPath?: string       // DuckDB file path; omitted = in-memory (no data)
  model?: string        // override model
  maxRounds?: number    // tool-call rounds cap (default 12)
}

// SSE event types pushed to the frontend
export type AgentSseEvent =
  | { type: "thinking";   text: string }
  | { type: "tool_call";  name: string; input: Record<string, unknown>; callId: string }
  | { type: "tool_result"; callId: string; name: string; result: unknown }
  | { type: "wiki_result"; callId: string; pages: Array<{ path: string; title: string; stability: string; score: number }>; warnings: string[]; checklist: string }
  | { type: "chart";      callId: string; echartsOption: Record<string, unknown>; title: string }
  | { type: "python_img"; callId: string; images: string[]; output: string }
  | { type: "answer";     markdown: string }
  | { type: "error";      message: string }
  | { type: "done" }

// ─── DMXAPI client ────────────────────────────────────────────────────────────

interface Message {
  role: "system" | "user" | "assistant" | "tool"
  content: string | null
  tool_calls?: ToolCallBlock[]
  tool_call_id?: string
  name?: string
}

interface ToolCallBlock {
  id: string
  type: "function"
  function: { name: string; arguments: string }
}

const DMXAPI_URL = process.env.DMXAPI_URL ?? "https://www.dmxapi.cn/v1/chat/completions"
const DEFAULT_MODEL = process.env.DATAAGENT_MODEL ?? "claude-opus-4-8"
const FALLBACK_MODEL = "claude-opus-4-7"

const SYSTEM_PROMPT = `You are DataAgent, an expert data analyst for DataSky (a short-video platform company) with access to a comprehensive knowledge base and data tools.

## Knowledge Base (uni-wiki, 1,438 pages)
You have access to a BM25 knowledge base covering DataSky's internal data catalog:
- Business metrics, SQL templates, data calibers (口径), table definitions
- 17 domains: live streaming, ecommerce (eco), ads (mp), platform tools, growth, social, etc.
- Stability tiers: 🟢S1 (production-safe) / 🟡S2 (may change) / 🔴S3 (volatile) / ❌deprecated (forbidden)

**CRITICAL RULE**: Call search_wiki FIRST for any question involving:
- Business metrics (GMV, DAU, 营收, 付费率, etc.)
- SQL patterns for specific tables
- Data caliber definitions (口径)
- Field names, filter conditions, unit conversions
- Cross-domain conflicts (eco vs mp vs live)

## Workflow
1. **search_wiki** — Find relevant calibers, SQL templates, gotchas, table names from the knowledge base
2. **explore_schema** — Inspect the actual database structure (if a DuckDB file is provided)
3. **run_sql** — Execute queries (always reference wiki calibers in your SQL comments)
4. **make_chart** — Visualize results with ECharts
5. **run_python** — Advanced analysis in E2B sandbox when needed
6. **Final answer** — Comprehensive Markdown report citing wiki sources

## Output Format
- Always cite wiki sources: 📚 来源：uni-wiki / wiki/xxx.md [🟢 S1-Stable]
- Include stability warnings for S2/S3 pages
- SQL comments should reference the caliber definition used
- Final report: Executive summary → Key findings (numbered with data) → SQL used → Recommendations`

async function callDmxApi(
  messages: Message[],
  model: string,
  useTools: boolean,
): Promise<{ content: string | null; toolCalls: ToolCallBlock[] }> {
  const apiKey = process.env.DMXAPI_KEY
  if (!apiKey) throw new Error("DMXAPI_KEY not set")

  const tryCall = async (m: string) => {
    const body: Record<string, unknown> = {
      model: m,
      messages,
      temperature: 0.1,
      max_tokens: 4000,
    }
    if (useTools) {
      body.tools = DATA_AGENT_TOOLS
      body.tool_choice = "auto"
    }

    const resp = await fetch(DMXAPI_URL, {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    })

    if (!resp.ok) {
      const text = await resp.text()
      throw new Error(`DMXAPI HTTP ${resp.status}: ${text.slice(0, 300)}`)
    }

    const data = await resp.json() as {
      choices: Array<{ message: { content: string | null; tool_calls?: ToolCallBlock[] } }>
    }
    const msg = data.choices[0]?.message
    return { content: msg?.content ?? null, toolCalls: msg?.tool_calls ?? [] }
  }

  try {
    return await tryCall(model)
  } catch (primaryErr) {
    // Fallback to previous model on any error (timeout, 5xx, unavailable channel)
    if (model !== FALLBACK_MODEL) {
      console.warn(`[dataagent] ${model} failed (${(primaryErr as Error).message.slice(0, 80)}), falling back to ${FALLBACK_MODEL}`)
      return await tryCall(FALLBACK_MODEL)
    }
    throw primaryErr
  }
}

// ─── Agent run ────────────────────────────────────────────────────────────────

export async function runDataAgent(
  req: DataAgentRequest,
  emit: (event: AgentSseEvent) => void,
): Promise<void> {
  const model = req.model ?? DEFAULT_MODEL
  const maxRounds = req.maxRounds ?? 12

  // Open DuckDB instance
  let instance: DuckDBInstance | null = null
  try {
    if (req.dbPath) {
      instance = await DuckDBInstance.create(req.dbPath, { access_mode: "READ_ONLY" })
    } else {
      instance = await DuckDBInstance.create(":memory:")
    }
  } catch (err) {
    emit({ type: "error", message: `Failed to open database: ${(err as Error).message}` })
    emit({ type: "done" })
    return
  }

  const messages: Message[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: req.question },
  ]

  try {
    for (let round = 0; round < maxRounds; round++) {
      const useTools = round < maxRounds - 1  // last round: no tools, just answer

      const { content, toolCalls } = await callDmxApi(messages, model, useTools)

      // Push any text content as "thinking" (intermediate reasoning)
      if (content) {
        if (toolCalls.length === 0) {
          // Final answer — no more tool calls
          emit({ type: "answer", markdown: content })
          break
        } else {
          emit({ type: "thinking", text: content })
        }
      }

      if (toolCalls.length === 0) {
        // No tool calls and no content — model is done
        if (!content) emit({ type: "answer", markdown: "*(No response generated)*" })
        break
      }

      // Append assistant message with tool calls
      messages.push({ role: "assistant", content, tool_calls: toolCalls })

      // Execute each tool call
      for (const tc of toolCalls) {
        const { id, function: fn } = tc
        let input: Record<string, unknown> = {}
        try { input = JSON.parse(fn.arguments) as Record<string, unknown> } catch { /* ok */ }

        emit({ type: "tool_call", name: fn.name, input, callId: id })

        let resultStr: string
        try {
          const result = await executeTool(fn.name, input, instance)

          // Special handling for wiki/chart/python — emit dedicated events
          if (fn.name === "search_wiki" && "pages" in result) {
            const r = result as import("./executor").WikiSearchResult
            emit({
              type: "wiki_result",
              callId: id,
              pages: r.pages.map(p => ({ path: p.path, title: p.title, stability: p.stability, score: p.score })),
              warnings: r.warnings,
              checklist: r.checklist,
            })
          }
          if (fn.name === "make_chart" && "echartsOption" in result) {
            const r = result as { echartsOption: Record<string, unknown>; title: string; chartType: string }
            emit({ type: "chart", callId: id, echartsOption: r.echartsOption, title: r.title })
          }
          if (fn.name === "run_python" && "images" in result) {
            const r = result as { images: string[]; output: string; error?: string }
            if (r.images.length > 0 || r.output) {
              emit({ type: "python_img", callId: id, images: r.images, output: r.output })
            }
          }

          emit({ type: "tool_result", callId: id, name: fn.name, result })

          // What goes into the LLM context must be compact — strip rawOutput and
          // truncate page content so wiki results don't bloat the context window.
          let llmResult: unknown = result
          if (fn.name === "search_wiki" && "pages" in (result as object)) {
            const r = result as import("./executor").WikiSearchResult
            llmResult = {
              pages: r.pages.map(p => ({
                path: p.path,
                title: p.title,
                stability: p.stability,
                // Keep only first 800 chars of content per page — enough for SQL hints
                content: p.content.slice(0, 800),
              })),
              checklist: r.checklist,
              warnings: r.warnings,
            }
          }
          resultStr = JSON.stringify(llmResult)
        } catch (err) {
          const errMsg = (err as Error).message
          emit({ type: "tool_result", callId: id, name: fn.name, result: { error: errMsg } })
          resultStr = JSON.stringify({ error: errMsg })
        }

        messages.push({
          role: "tool",
          content: resultStr,
          tool_call_id: id,
          name: fn.name,
        })
      }
    }
  } catch (err) {
    emit({ type: "error", message: (err as Error).message })
  } finally {
    instance?.closeSync?.()
    emit({ type: "done" })
  }
}

// ─── Tool dispatcher ──────────────────────────────────────────────────────────

async function executeTool(
  name: string,
  input: Record<string, unknown>,
  instance: DuckDBInstance,
) {
  switch (name) {
    case "search_wiki":
      return execSearchWiki({
        queries: input.queries as string[],
        top: input.top as number | undefined,
        pinPages: input.pinPages as string[] | undefined,
      })

    case "explore_schema":
      return execExploreSchema(instance, input.table as string | undefined)

    case "run_sql":
      return execRunSql(instance, input.sql as string)

    case "make_chart": {
      return execMakeChart({
        title: input.title as string,
        chartType: input.chartType as string,
        data: input.data as Record<string, unknown>,
        xLabel: input.xLabel as string | undefined,
        yLabel: input.yLabel as string | undefined,
      })
    }

    case "run_python":
      return execRunPython(input.code as string)

    default:
      return { error: `Unknown tool: ${name}` }
  }
}

// ─── HTTP SSE handler ─────────────────────────────────────────────────────────

export async function handleDataAgentRun(req: Request, apiToken: string): Promise<Response> {
  // Auth
  const auth = req.headers.get("authorization") ?? ""
  const presented = auth.startsWith("Bearer ") ? auth.slice(7) : ""
  if (presented !== apiToken) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401, headers: { "Content-Type": "application/json" },
    })
  }

  let body: DataAgentRequest
  try {
    body = await req.json() as DataAgentRequest
  } catch {
    return new Response(JSON.stringify({ error: "invalid JSON body" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    })
  }

  if (!body.question?.trim()) {
    return new Response(JSON.stringify({ error: "question is required" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    })
  }

  // Stream SSE
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  const writer = writable.getWriter()
  const enc = new TextEncoder()

  const emit = (event: AgentSseEvent) => {
    const line = `data: ${JSON.stringify(event)}\n\n`
    writer.write(enc.encode(line)).catch(() => {})
  }

  // Run agent asynchronously
  runDataAgent(body, emit).finally(() => {
    writer.close().catch(() => {})
  })

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  })
}
