#!/usr/bin/env node
/**
 * 从磁盘上的 .ps1 文件重新生成 server.mjs 里的内嵌常量。
 *
 * 改完 screen.ps1 / input.ps1 之后跑一次这个，再构建。
 * 也可以直接跑 check-embedded.mjs 看有没有忘。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcFile = path.join(here, 'server.mjs');
let src = fs.readFileSync(srcFile, 'utf8');

const PAIRS = [
  ['EMBEDDED_SCREEN_PS1', 'screen.ps1'],
  ['EMBEDDED_INPUT_PS1', 'input.ps1'],
];

for (const [constName, fileName] of PAIRS) {
  const file = path.join(here, fileName);
  if (!fs.existsSync(file)) continue;
  const disk = fs.readFileSync(file, 'utf8');
  const marker = `const ${constName} = `;
  const start = src.indexOf(marker);
  if (start < 0) throw new Error(`找不到 ${constName}`);
  const end = src.indexOf(';\n', start);
  if (end < 0) throw new Error(`${constName} 的赋值没有以 ;\\n 结尾`);

  src = src.slice(0, start) + marker + JSON.stringify(disk) + src.slice(end);
  console.log(`已同步 ${constName} ← ${fileName}（${disk.length} 字符）`);
}

fs.writeFileSync(srcFile, src);
