#!/usr/bin/env bash
# Self-service demo: prove the data-flow HTTP API end to end, including auth.
#
#   bash scripts/dataflow-api-demo.sh
#
# It: (1) generates a synthetic DuckDB dataset, (2) starts `serve` bound to
# localhost with an API token, (3) shows the auth gate rejecting an unauthorized
# call, (4) submits a real sql→validate→compare analysis with the token and
# prints the results, (5) cleans up.
#
# No LLM is used (sql/validate/compare workers only) → no codewhale, no tokens.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-9777}"
TOKEN="${SWARM_API_TOKEN:-demo-secret-$$}"
DB="$(mktemp -d)/demo.duckdb"
URL="http://127.0.0.1:${PORT}/api/dataflow/run"

echo "==> 1. generating synthetic DuckDB dataset at $DB"
bun --eval "
import { DuckDBInstance } from '@duckdb/node-api'
const w = await DuckDBInstance.create('$DB')
const c = await w.connect()
await c.run(\`CREATE TABLE orders (id INTEGER, region VARCHAR, category VARCHAR, amount DECIMAL(10,2))\`)
await c.run(\`INSERT INTO orders SELECT i, ['EU','US','APAC','LATAM'][1+(i%4)], ['hw','sw','svc'][1+(i%3)], round(10+random()*990,2)::DECIMAL(10,2) FROM range(1,2001) t(i)\`)
c.closeSync?.(); w.closeSync?.()
console.log('   dataset ready (2000 rows)')
"

echo "==> 2. starting serve on 127.0.0.1:${PORT} (token gated)"
SWARM_API_TOKEN="$TOKEN" bun run src/cli/index.ts serve --port "$PORT" --project "$(dirname "$DB")" &
SERVER_PID=$!
cleanup() { kill "$SERVER_PID" 2>/dev/null || true; rm -rf "$(dirname "$DB")"; }
trap cleanup EXIT
# wait for the port to accept connections
for i in $(seq 1 30); do curl -s -o /dev/null "http://127.0.0.1:${PORT}/" && break || sleep 0.5; done

echo "==> 3. auth gate: request WITHOUT token (expect 401)"
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$URL" -H "Content-Type: application/json" -d '{"tasks":[]}')
echo "    HTTP $code  $([ "$code" = "401" ] && echo '✅ rejected' || echo '⚠️ unexpected')"

echo "==> 4. submit a real sql → validate → compare analysis WITH token"
curl -s -X POST "$URL" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{
    \"db\": \"${DB}\",
    \"tasks\": [
      {\"key\":\"byRegion\",\"kind\":\"sql\",\"title\":\"revenue by region\",
       \"sql\":\"SELECT region, COUNT(*) orders, SUM(amount) revenue FROM orders GROUP BY region ORDER BY revenue DESC\"},
      {\"key\":\"check\",\"kind\":\"validate\",\"title\":\"sanity\",\"dependsOn\":[\"byRegion\"],
       \"rules\":[{\"type\":\"rowCount\",\"min\":1},{\"type\":\"noNulls\",\"column\":\"region\"}]},
      {\"key\":\"allRegions\",\"kind\":\"sql\",\"sql\":\"SELECT DISTINCT region FROM orders\"},
      {\"key\":\"bigRegions\",\"kind\":\"sql\",\"sql\":\"SELECT DISTINCT region FROM orders WHERE amount > 500\"},
      {\"key\":\"diff\",\"kind\":\"compare\",\"dependsOn\":[\"allRegions\",\"bigRegions\"],\"keyColumn\":\"region\"}
    ]
  }" | (command -v jq >/dev/null && jq . || cat)

echo ""
echo "==> done. (server stops on exit)"
