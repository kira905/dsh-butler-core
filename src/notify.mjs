// ops-core / src/notify.mjs —— 通知适配器（默认只写本地 outbox）
//
// 刻意的边界：骨架**不带任何私聊 / 群机器人通道**（企业微信、钉钉、Slack…）。
// 原因有两条，都是工程性的：
//   1. 这类通道要凭据 + 外网地址，一旦写进默认路径，骨架就没法"clone 下来直接跑"；
//   2. 通知是"出机器"的动作，必须由使用者显式决定发去哪、发什么。
//
// 默认实现 = file：把通知追加到 <DSH_HOME>/ops-notify-outbox.jsonl。
// 想接自己的通道：在调用方 `createFileNotifier` 之外传一个 async fn，或在运行时
// `addChannel()`（见 alert.mjs 的同一模式）。webhook 适配器只接受调用方显式传入的 URL，
// 仓库里不出现任何默认地址。
import fs from 'node:fs';
import { ensureDir, iso, opsPaths } from './paths.mjs';

/**
 * 文件通知：写本地 outbox（一行一条 JSON）。
 * 返回 { ok, file, error? }。
 */
export function fileNotifier({ home } = {}) {
  const file = opsPaths(home).notifyOutbox;
  return {
    name: 'file',
    async send(entry) {
      try {
        ensureDir(opsPaths(home).home);
        const rec = {
          at: iso(),
          channel: 'file',
          id: entry.id ?? null,
          level: entry.level ?? 'info',
          message: entry.message ?? '',
          source: entry.source ?? 'ops-core',
        };
        fs.appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8');
        return { ok: true, file };
      } catch (e) {
        return { ok: false, file, error: e?.message ?? String(e) };
      }
    },
  };
}

/**
 * Webhook 适配器（可选；必须由调用方传 URL，仓库内零默认地址）。
 * 只发一行 JSON：{ source, level, message, at }。失败不抛，返回 { ok:false }。
 */
export function webhookNotifier({ url, headers = {}, timeoutMs = 10_000 } = {}) {
  if (!url) throw new Error('webhookNotifier: 必须显式传入 url');
  return {
    name: 'webhook',
    async send(entry) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify({ source: entry.source ?? 'ops-core', level: entry.level ?? 'info', message: entry.message ?? '', at: iso() }),
          signal: controller.signal,
        });
        return { ok: res.ok, status: res.status };
      } catch (e) {
        return { ok: false, error: e?.message ?? String(e) };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
