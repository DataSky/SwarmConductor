#!/usr/bin/env bash
# 本地快速验证：T1 冒烟 + T2 单元测试 + T5 TUI 布局
# 无需 LLM / CodeWhale，2-3 分钟跑完
set -uo pipefail
cd "$(dirname "$0")/.."

PASS=0; FAIL=0
ok()   { echo "  ✓ $1"; ((PASS++)); }
fail() { echo "  ✗ $1"; ((FAIL++)); }

echo ""
echo "══════════════════════════════════════"
echo "  T1  冒烟测试"
echo "══════════════════════════════════════"

# T1-1 demo
if bun run src/cli/index.ts demo 2>&1 | grep -q "Deadlock check"; then
  ok "T1-1  swarm demo"
else
  fail "T1-1  swarm demo"
fi

# T1-2 tsc
if output=$(bun tsc --noEmit 2>&1) && [ -z "$output" ]; then
  ok "T1-2  bun tsc --noEmit"
else
  fail "T1-2  bun tsc --noEmit"
  echo "$output" | head -10
fi

# T1-3 help 包含 --no-ai-plan
if bun run src/cli/index.ts help 2>&1 | grep -q "\-\-no-ai-plan"; then
  ok "T1-3  help 含 --no-ai-plan"
else
  fail "T1-3  help 含 --no-ai-plan"
fi

# T1-4 count:ts 验证输出为 33
if output=$(bun run count:ts -- --summary 2>&1) && echo "$output" | grep -q "33"; then
  ok "T1-4  bun run count:ts --summary → 33"
else
  fail "T1-4  bun run count:ts --summary → 33 (got: $output)"
fi

echo ""
echo "══════════════════════════════════════"
echo "  T2  单元测试"
echo "══════════════════════════════════════"

result=$(bun test 2>&1)
passed=$(echo "$result" | grep -oE '[0-9]+ pass' | grep -oE '[0-9]+' || echo 0)
failed=$(echo "$result" | grep -oE '[0-9]+ fail' | grep -oE '[0-9]+' || echo 0)
# integration.test.ts 需要 CodeWhale，允许其 fail
non_integration_fail=$(echo "$result" | grep "✗" | grep -v "integration" | wc -l | tr -d ' ')

echo "  passed: $passed  failed: $failed"
if [ "$non_integration_fail" -eq 0 ] && [ "$passed" -ge 60 ]; then
  ok "T2    bun test (非 integration 全 pass)"
else
  fail "T2    bun test ($non_integration_fail 个非 integration 失败)"
  echo "$result" | grep "✗" | grep -v "integration" | head -10
fi

echo ""
echo "══════════════════════════════════════"
echo "  T7  指令协议结构检查"
echo "══════════════════════════════════════"

src_file="src/conductor/index.ts"
checks=(
  "buildAgentPrompt"
  "<agent_role>"
  "<task_instruction>"
  "<scope>"
  "<inherited_context>"
  "<output_contract>"
  "MAX_CONTEXT_CHARS = 8_000"
  "MAX_OUTPUT_CHARS  = 80_000"
)
all_ok=true
for term in "${checks[@]}"; do
  if grep -q "$term" "$src_file"; then
    : # silent pass
  else
    fail "T7  缺少: $term"
    all_ok=false
  fi
done
if $all_ok; then ok "T7    buildAgentPrompt 结构完整（8 项）"; fi

echo ""
echo "══════════════════════════════════════"
echo "  T5  TUI 布局（160 列三栏）"
echo "══════════════════════════════════════"

COLUMNS=160 LINES=40 bun -e "
process.stdout.columns = 160
process.stdout.rows = 40
Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
import { LiveView } from './src/cli/live-view.ts'
import { Conductor } from './src/conductor/index.ts'
import { defaultConfig } from './src/dag/types.ts'
import { createTaskNode } from './src/dag/engine.ts'
const c = new Conductor(defaultConfig({ projectPath: process.cwd() }))
await c.initialize()
const t1 = createTaskNode({ type:'explore',   title:'Explore codebase', prompt:'p', scope:['.'], priority:100 })
const t2 = createTaskNode({ type:'implement', title:'Refactor module',   prompt:'p', scope:['src'], priority:80, dependsOn:[t1.id] })
c.taskDag.addTasks([t1,t2])
c.taskDag.assign(t1.id,'agent-aaa')
c.taskDag.complete(t1.id,{summary:'Done.',changes:[],evidence:[],risks:['HIGH: no validation'],blockers:[],rawText:''})
c.taskDag.assign(t2.id,'agent-bbb')
const lv = new LiveView(c,'summary')
// Inject risk signal directly (simulates what handleEvent does on task.done)
;(lv as any).riskCount = 1
;(lv as any).lastRisk  = 'no input validation'
const slots = (lv as any).slots
slots.set('agent-bbb',{taskId:t2.id,title:t2.title,type:t2.type,scope:t2.scope,startedAt:Date.now()-30000,lastLine:'Working on auth...',tokenUsage:null})
lv.start()
await new Promise(r=>setTimeout(r,600))
lv.stop()
await c.shutdown()
" 2>/dev/null > /tmp/_tui_check.bin

python3 - /tmp/_tui_check.bin << 'PYEOF'
import sys
with open(sys.argv[1],'rb') as f: data=f.read().decode('utf-8',errors='replace')
W,H=160,40
grid=[[' ']*W for _ in range(H)]
row=col=i=0
while i<len(data):
    ch=data[i]
    if ch=='\x1b' and i+1<len(data) and data[i+1]=='[':
        j=i+2
        while j<len(data) and data[j] not in 'ABCDEFGHJKSTfmhlsu': j+=1
        seq=data[i+2:j]; e=data[j] if j<len(data) else ''
        if e in('H','f'):
            p=seq.split(';'); row=max(0,min(int(p[0])-1,H-1)) if p[0] else 0; col=max(0,min(int(p[1])-1,W-1)) if len(p)>1 and p[1] else 0
        elif e=='J':
            for r in range(H): grid[r]=[' ']*W
        i=j+1
    elif ch=='\n': row=min(row+1,H-1); col=0; i+=1
    elif ch=='\r': col=0; i+=1
    elif ord(ch)<32: i+=1
    else:
        if 0<=row<H and 0<=col<W: grid[row][col]=ch
        col=min(col+1,W-1); i+=1
lines=[''.join(r) for r in grid]
checks = {
    'TASKS 标题':   any('TASKS'  in l for l in lines[3:6]),
    'AGENTS 标题':  any('AGENTS' in l for l in lines[3:6]),
    'LOG 标题':     any('LOG'    in l for l in lines[3:6]),
    '分割线存在':   sum(1 for l in lines[3:25] if '│' in l) >= 10,
    '风险信号灯':   any('HIGH'   in l for l in lines[:3]),
    'Phase 时间线': any('phases' in l for l in lines[:3]),
    'Agent 卡片':   any('Working on auth' in l for l in lines),
}
fails=[]
for name,ok in checks.items():
    if ok: print(f"  ✓ TUI {name}")
    else:  fails.append(name); print(f"  ✗ TUI {name}")
sys.exit(0 if not fails else 1)
PYEOF
tui_exit=$?
if [ $tui_exit -eq 0 ]; then
  ((PASS++))
else
  ((FAIL++))
fi

echo ""
echo "══════════════════════════════════════"
printf "  结果  ✓ %d pass   %s%d fail\033[0m\n" \
  "$PASS" "$([ $FAIL -gt 0 ] && echo $'\033[31m' || echo '')" "$FAIL"
echo "══════════════════════════════════════"
echo ""
[ $FAIL -eq 0 ]
