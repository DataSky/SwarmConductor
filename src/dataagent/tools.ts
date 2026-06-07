// ─── DataAgent tool definitions ──────────────────────────────────────────────
// OpenAI-compatible tool schemas. The agent uses these to explore the data,
// run queries, generate charts, and write insights.

export interface DataAgentTool {
  type: "function"
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export const DATA_AGENT_TOOLS: DataAgentTool[] = [
  {
    type: "function",
    function: {
      name: "search_wiki",
      description: `Search the uni-wiki knowledge base (1,438 pages covering DataSky's internal data catalog: live streaming, ecommerce, ads, platform tools).
Use this tool FIRST when the user question involves business metrics, SQL patterns, data calibers (口径), table names, or KPI definitions.
Returns ranked wiki pages with S1/S2/S3 stability badges, SQL templates, gotcha warnings, and field-level definitions.
Always search before writing SQL — the wiki contains exact table names, filter conditions (is_field, is_avator etc.), unit conversions (厘→元), and cross-domain conflict warnings.
Examples of when to call: "GMV口径", "主播身份分层", "广告消耗单位", "直播间定义", "达人GMV归因"`,
      parameters: {
        type: "object",
        properties: {
          queries: {
            type: "array",
            items: { type: "string" },
            description: "1-4 search queries. Use different angles: Q1=business concept+metric, Q2=SQL template keywords+table fragment, Q3=exact field name, Q4=filter condition+unit. Example: ['直播GMV口径 营收', '营收多口径SQL kscdm', 'is_field is_avator', '单位 分 元 换算']",
          },
          top: {
            type: "number",
            description: "Max pages to return per query (default 5, max 10)",
          },
          pinPages: {
            type: "array",
            items: { type: "string" },
            description: "Force-include specific wiki page paths regardless of score. Use for known-relevant pages (e.g. 'wiki/sql/营收多口径SQL.md')",
          },
        },
        required: ["queries"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "explore_schema",
      description: "Explore the database schema: list all tables, or get columns/sample rows for a specific table. Always call this first to understand the data before writing SQL.",
      parameters: {
        type: "object",
        properties: {
          table: {
            type: "string",
            description: "Table name to inspect. Omit to list all tables.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_sql",
      description: "Execute a SQL query against the DuckDB database and return results as JSON. Use LIMIT to avoid huge result sets.",
      parameters: {
        type: "object",
        properties: {
          sql: {
            type: "string",
            description: "The SQL query to execute. Always include LIMIT unless aggregating.",
          },
          label: {
            type: "string",
            description: "Short descriptive label for this query (shown in the UI).",
          },
        },
        required: ["sql", "label"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "make_chart",
      description: "Generate an ECharts chart from data. The chart will be rendered live in the browser. Use this after run_sql to visualize results.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Chart title.",
          },
          chartType: {
            type: "string",
            enum: ["bar", "line", "pie", "scatter", "area"],
            description: "Type of chart to generate.",
          },
          data: {
            type: "object",
            description: "Chart data: { categories: string[], series: [{name, data: number[]}] } for bar/line/area; { items: [{name, value}] } for pie; { points: [{x, y, name?}] } for scatter.",
          },
          xLabel: { type: "string", description: "X-axis label (optional)." },
          yLabel: { type: "string", description: "Y-axis label (optional)." },
        },
        required: ["title", "chartType", "data"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_python",
      description: "Execute Python code in an E2B sandbox for advanced analysis, statistical computation, or generating matplotlib/plotly charts. Returns stdout output and base64-encoded PNG images.",
      parameters: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description: "Python code to execute. Use print() for text output. Save figures with plt.savefig('/tmp/chart.png', dpi=100, bbox_inches='tight') then open and base64-encode them.",
          },
          label: {
            type: "string",
            description: "Short label describing what this code does.",
          },
        },
        required: ["code", "label"],
      },
    },
  },
]

// ─── Tool result types ─────────────────────────────────────────────────────────

export interface SchemaResult {
  tables?: string[]
  columns?: Array<{ name: string; type: string }>
  sample?: Record<string, unknown>[]
}

export interface SqlResult {
  rows: Record<string, unknown>[]
  rowCount: number
  truncated: boolean
  error?: string
}

export interface ChartResult {
  title: string
  chartType: string
  echartsOption: Record<string, unknown>
}

export interface PythonResult {
  output: string
  images: string[]  // base64 PNG data URLs
  error?: string
}

export type ToolResult = SchemaResult | SqlResult | ChartResult | PythonResult | { error: string }
