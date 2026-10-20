#!/usr/bin/env node
// ops-tickd —— 骨架的最小 tick CLI
//
//   node bin/ops-tickd.mjs --once                 跑一轮（默认；会执行全部 job）
//   node bin/ops-tickd.mjs --once --no-force      跑一轮（只跑到期的 job）
//   node bin/ops-tickd.mjs --once --only daily-report
//   node bin/ops-tickd.mjs --once --json          只输出 JSON（日志走 stderr）
//   node bin/ops-tickd.mjs --interval 60          常驻（每 60 秒一轮；Ctrl+C 退出）
//   node bin/ops-tickd.mjs --state                只读：状态文件健康 + 审计链 + 锁
//   node bin/ops-tickd.mjs --home <dir>           指定状态根（等价 OPS_CORE_HOME / DSH_HOME）
//
// 退出码：0 = 本轮无失败；3 = 有 job 失败；2 = 参数错。
// 注意：本脚本从不调用 process.exit()（发过 fetch / 写盘后强退有概率崩），只设 exitCode。
import { parseArgs, numArg, table } from '../src/cli.mjs';
import { readAutonomy, describe } from '../src/autonomy.mjs';
import { resolveHome, opsPaths } from '../src/paths.mjs';
import { createOpsScheduler } from '../src/registry.mjs';
import { healthSummary } from '../src/state-files.mjs';
import { verifyAuditChain } from '../src/audit.mjs';
import { listLocks } from '../src/store.mjs';

const KNOWN = new Set(['home', 'once', 'interval', 'force', 'no-force', 'only', 'json', 'state', 'help']);
const args = parseArgs(process.argv.slice(2));

function usage() {
  console.log(`用法：
  ops-tickd --once [--no-force] [--only a,b] [--json] [--home <dir>]
  ops-tickd --interval <秒> [--home <dir>]
  ops-tickd --state [--json] [--home <dir>]

选项：
  --once            跑一轮后退出（默认行为）
  --interval <秒>   常驻循环（最小 5 秒；Ctrl+C 退出）
  --no-force        只跑到期 job（默认 --once 强制跑全部）
  --only a,b        只跑指定 job
  --json            stdout 只输出 JSON（进度日志走 stderr）
  --state           只读：打印状态文件健康 / 审计链 / 锁
  --home <dir>      状态根目录（默认 OPS_CORE_HOME > DSH_HOME > ~/.dsh）
  --help            显示本帮助`);
}

const bad = Object.keys(args.values).concat(Object.keys(args.flags)).filter((k) => !KNOWN.has(k));
if (bad.length) { console.error(`未知参数：${bad.map((b) => '--' + b).join(', ')}`); usage(); process.exitCode = 2; }
else if (args.flags.help) { usage(); }
else {
  const home = resolveHome(args.values.home);
  const json = args.flags.json === true;
  const log = (line) => { if (json) process.stderr.write(line + '\n'); else process.stdout.write(line + '\n'); };

  try {
    if (args.flags.state) {
      const h = healthSummary(home);
      const chain = verifyAuditChain({ home });
      const locks = listLocks(home);
      if (json) {
        console.log(JSON.stringify({ home, health: h, auditChain: chain, locks }, null, 2));
      } else {
        console.log(`状态根：${home}`);
        console.log(table(h.rows.map((r) => [r.name, r.exists ? '存在' : '缺失', r.exists ? String(r.size) : '-', r.parse === null ? '—' : r.parse ? 'ok' : '坏']), ['文件', '状态', '字节', '解析']));
        console.log(`\n审计链：${chain.ok ? '完整' : `断 ${chain.breaks.length} 处`}（本月 ${chain.count} 行）`);
        console.log(`锁：${locks.length} 个${locks.length ? '（' + locks.map((l) => `${l.name}${l.expired ? '/过期' : ''}`).join('、') + '）' : ''}`);
      }
      process.exitCode = h.ok && chain.ok ? 0 : 3;
    } else if (args.values.interval !== undefined) {
      const sec = numArg(args, 'interval', { min: 5, max: 86_400 });
      const { scheduler } = createOpsScheduler({ home, logger: log });
      const { state } = readAutonomy({ home, ensure: true });
      log(`ops-tickd 常驻：home=${home} · 档位=${state.mode} · 每 ${sec}s 一轮 · Ctrl+C 退出`);
      let stop = false;
      process.on('SIGINT', () => { stop = true; log('收到 SIGINT，跑完当前轮后退出'); });
      while (!stop) {
        const run = await scheduler.tickOnce({ force: false });
        for (const r of run.results) log(`  ${r.id}: ${r.status}${r.durationMs !== undefined ? ` (${r.durationMs}ms)` : ''}`);
        if (stop) break;
        await new Promise((resolve) => setTimeout(resolve, sec * 1000));
      }
    } else {
      const only = args.values.only ? String(args.values.only).split(',').map((s) => s.trim()).filter(Boolean) : null;
      const force = args.flags['no-force'] !== true;
      const { scheduler } = createOpsScheduler({ home, logger: log });
      const { state } = readAutonomy({ home, ensure: true });
      log(`ops-tickd：home=${home} · 档位=${state.mode} · ${force ? '强制' : '仅到期'}${only ? ` · only=${only.join(',')}` : ''}`);
      const run = await scheduler.tickOnce({ force, only });
      if (json) {
        console.log(JSON.stringify(run, null, 2));
      } else {
        console.log(table(run.results.map((r) => [r.id, r.status, r.durationMs ?? '-', r.error ?? (r.detail?.skipped ? '内容未变' : r.detail?.disabled ? '模块已关' : 'ok')]), ['job', '状态', '耗时ms', '说明']));
        const report = run.results.find((r) => r.id === 'daily-report')?.detail?.file;
        if (report) console.log(`\n产物：${report}`);
        const auditDir = opsPaths(home).auditDir;
        console.log(`审计：${auditDir}`);
      }
      process.exitCode = run.failed > 0 ? 3 : 0;
    }
    // 打印一行档位摘要（人话），让人知道"现在会不会自己动手"
    if (!json && !args.flags.state) {
      const { state } = readAutonomy({ home });
      const d = describe(state);
      console.log(`\n档位：${d.mode}（${d.modeNote}）· 自主动作：${d.auto.filter((a) => a.enabled).map((a) => a.id).join(',') || '全部关闭'}`);
    }
  } catch (e) {
    console.error(`[ops-tickd] 失败：${e?.message ?? e}`);
    process.exitCode = 2;
  }
}
