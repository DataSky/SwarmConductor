/**
 * count-ts-files.ts — 统计 src/ 下所有 TypeScript 文件，按顶级子目录分组输出。
 *
 * 用法:
 *   bun run scripts/count-ts-files.ts             # 默认：分组列表
 *   bun run scripts/count-ts-files.ts --summary   # 仅输出总数
 *   bun run scripts/count-ts-files.ts --json      # JSON 格式输出
 *
 * 通过 package.json 快捷入口:
 *   bun run count:ts
 *   bun run count:ts -- --summary
 */

import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";

const SRC_DIR = join(import.meta.dir, "..", "src");
const EXTENSIONS = new Set([".ts", ".tsx"]);

interface GroupedFiles {
  [dir: string]: string[];
}

async function scanDir(dir: string): Promise<GroupedFiles> {
  const result: GroupedFiles = {};

  async function walk(currentDir: string, topDir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);

      // 跳过隐藏文件和 node_modules
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

      if (entry.isDirectory()) {
        await walk(fullPath, topDir);
      } else if (entry.isFile()) {
        const ext = entry.name.slice(entry.name.lastIndexOf("."));
        if (EXTENSIONS.has(ext)) {
          const relPath = relative(SRC_DIR, fullPath);
          if (!result[topDir]) result[topDir] = [];
          result[topDir].push(relPath);
        }
      }
    }
  }

  // 读取 src/ 的顶级目录并递归
  let topEntries;
  try {
    topEntries = await readdir(SRC_DIR, { withFileTypes: true });
  } catch {
    return result;
  }

  for (const entry of topEntries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    await walk(join(SRC_DIR, entry.name), entry.name);
  }

  // 排序：组内文件按路径排序，组之间按键排序
  for (const dir of Object.keys(result)) {
    result[dir].sort();
  }

  return result;
}

function computeTotal(grouped: GroupedFiles): number {
  return Object.values(grouped).reduce((sum, files) => sum + files.length, 0);
}

// ── 主入口 ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const useJson = args.includes("--json");
const useSummary = args.includes("--summary");

const grouped = await scanDir(SRC_DIR);
const sortedDirs = Object.keys(grouped).sort();
const total = computeTotal(grouped);

if (useJson) {
  // 重建按字母序排列的对象
  const ordered: GroupedFiles = {};
  for (const dir of sortedDirs) {
    ordered[dir] = grouped[dir];
  }
  console.log(
    JSON.stringify({ total, directories: ordered }, null, 2),
  );
} else if (useSummary) {
  console.log(`${total}`);
} else {
  // 默认：分组列表
  console.log(`TypeScript 文件统计 (src/)\n`);
  for (const dir of sortedDirs) {
    const files = grouped[dir];
    console.log(`  ${dir}/  (${files.length} file${files.length !== 1 ? "s" : ""})`);
    for (const f of files) {
      console.log(`    ${f}`);
    }
  }
  console.log(`\n总计: ${total} 个 TypeScript 文件`);
}
