#!/usr/bin/env node
/**
 * 校验「磁盘上的 .ps1」和「server.mjs 里的内嵌常量」是否一致。
 *
 * 为什么需要：客户端打成 exe 之后，运行时用的是**内嵌常量**，
 * 磁盘文件根本不参与。改磁盘文件而不重新生成常量，等于没改——
 * 真机上为此白跑了四轮：加了 DPI 没效果、改了 Scale 分辨率没变、
 * 补了 READY 参数 meta 里还是 null，全都是这个原因。
 *
 * 这个检查挂到构建流程里（package.json 的 build 脚本 / CI），
 * 不一致就直接失败，别再让「改了一份」的事发生。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcFile = path.join(here, 'server.mjs');
const src = fs.readFileSync(srcFile, 'utf8');

/** 从 server.mjs 里取出某个内嵌常量的字符串值 */
function embedded(name) {
  const re = new RegExp(`const ${name} = ("(?:[^"\\\\]|\\\\.)*")`, 's');
  const m = src.match(re);
  if (!m) throw new Error(`server.mjs 里找不到 ${name}`);
  return JSON.parse(m[1]);
}

const PAIRS = [
  ['EMBEDDED_SCREEN_PS1', 'screen.ps1'],
  ['EMBEDDED_INPUT_PS1', 'input.ps1'],
];

let bad = 0;
for (const [constName, fileName] of PAIRS) {
  const file = path.join(here, fileName);
  if (!fs.existsSync(file)) {
    console.log(`⚠ ${fileName} 不存在，跳过`);
    continue;
  }
  // 统一去掉 \r：Windows 上 checkout 出来的文件可能是 CRLF，
  // 而常量是 LF。比的是「内容」，不是「行为什么换行符」。
  const disk = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const emb = embedded(constName).replace(/\r\n/g, '\n');

  if (disk === emb) {
    console.log(`✓ ${constName} 与 ${fileName} 一致（${disk.length} 字符）`);
    continue;
  }

  bad += 1;
  console.error(`✗ ${constName} 与 ${fileName} 不一致！`);
  console.error(`  磁盘 ${disk.length} 字符 / 内嵌 ${emb.length} 字符`);
  // 找出第一个差异位置，指出具体差在哪，而不是只说「不一样」
  const n = Math.min(disk.length, emb.length);
  let i = 0;
  while (i < n && disk[i] === emb[i]) i += 1;
  console.error(`  首个差异在第 ${i} 字符：`);
  console.error(`    磁盘: ${JSON.stringify(disk.slice(i, i + 60))}`);
  console.error(`    内嵌: ${JSON.stringify(emb.slice(i, i + 60))}`);
}

if (bad > 0) {
  console.error('');
  console.error('修法：node win-client/sync-embedded.mjs   （从磁盘文件重新生成常量）');
  process.exit(1);
}
console.log('内嵌常量全部同步。');
