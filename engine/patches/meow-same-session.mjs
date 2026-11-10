#!/usr/bin/env node
/**
 * 让「本会话刚写下的记忆」能在后续轮次自动注入。
 *
 * 原实现（meow-memory/lib/index.js hitQuery）：
 *
 *   .filter(r => ... && r.source_session !== sessionId && !seenState.injected.includes(r.id))
 *
 * 这条 `source_session !== sessionId` 的意思是「排除本会话自己写的记忆」。
 * 设计初衷是避免模型自我引用，但副作用很严重：
 *
 *   模型踩了坑 → 写一条 lesson → 下一轮读不到这条 lesson → 又踩同一个坑。
 *
 * 真机日志里「框里面的文字都超出框了」被用户连续指出 3 次，就是这个原因。
 * 学习闭环是断的。
 *
 * 改法：去掉 source_session 判断，保留 `!seenState.injected.includes(r.id)`。
 * 后者保证同一条记忆只注入一次，不会每轮重复刷屏——所以放开是安全的。
 *
 * 注意：**不动 memory_find_similar** 那处。主动「找相似记忆」时排除本会话
 * 是合理的（避免找到自己刚写的、没有参考价值的条目）。
 */
import fs from 'node:fs';
import path from 'node:path';

const target = process.argv[2];
if (!target) {
  console.error('用法：meow-same-session.mjs <engine-out-dir>');
  process.exit(2);
}

const file = path.join(target, 'node_modules/meow-memory/lib/index.js');
if (!fs.existsSync(file)) {
  console.log('meow-patch: 没找到 meow-memory（跳过）');
  process.exit(0);
}

let src = fs.readFileSync(file, 'utf8');

const OLD = "&& r.source_session !== sessionId && !seenState.injected.includes(r.id)";
const NEW = "&& !seenState.injected.includes(r.id)";

if (!src.includes(OLD)) {
  if (src.includes(NEW) && !src.includes(OLD)) {
    console.log('meow-patch: 已经是改过的版本（跳过）');
    process.exit(0);
  }
  console.error('meow-patch: 没找到目标字符串，meow-memory 可能升级了，请复查');
  process.exit(1);
}

const count = src.split(OLD).length - 1;
if (count !== 1) {
  console.error(`meow-patch: 目标字符串出现 ${count} 次（预期 1 次），拒绝盲改`);
  process.exit(1);
}

src = src.replace(OLD, NEW);

// 留一条注释，方便以后排查「为什么这条代码和上游不一样」
src = src.replace(
  NEW,
  "/* patched: 允许本会话写入的记忆在后续轮次注入，否则学到的教训当轮用不上 */ " + NEW
);

fs.writeFileSync(file, src);
console.log('meow-patch: 已放开「本会话记忆」的注入限制');
