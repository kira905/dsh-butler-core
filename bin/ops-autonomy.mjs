#!/usr/bin/env node
// ops-autonomy —— 自主矩阵 CLI（读档位 / 开关模块 / 开关自动动作）
//
//   node bin/ops-autonomy.mjs status
//   node bin/ops-autonomy.mjs mode observe|report|act
//   node bin/ops-autonomy.mjs module on|off <id>
//   node bin/ops-autonomy.mjs job on|off <id>
//   node bin/ops-autonomy.mjs auto on|off <id>
//   node bin/ops-autonomy.mjs status --json
//
// 所有写动作都带 --by / --why，并落一行审计。参数错 = rc 2。
import { parseArgs } from '../src/cli.mjs';
import { describe, readAutonomy, setAuto, setJob, setMode, setModule, MODULES, AUTO_ACTIONS, MODES } from '../src/autonomy.mjs';
import { resolveHome } from '../src/paths.mjs';

const args = parseArgs(process.argv.slice(2));
const [cmd = 'status', verb, id] = args._;
const home = resolveHome(args.values.home);
const by = String(args.values.by ?? process.env.USERNAME ?? 'cli');
const why = args.values.why ?? null;
const json = args.flags.json === true;

function printStatus() {
  const { state, file, created } = readAutonomy({ home, ensure: true });
  const d = describe(state);
  if (json) { console.log(JSON.stringify({ file, created, ...d }, null, 2)); return 0; }
  console.log(`状态根：${home}`);
  console.log(`自主矩阵：${file}${created ? '（本次新建）' : ''}`);
  console.log(`\n档位：${d.mode} —— ${d.modeNote}`);
  console.log('\n模块（job）：');
  for (const m of d.modules) console.log(`  ${m.enabled ? '[开]' : '[关]'} ${m.id.padEnd(14)} ${m.label}`);
  console.log('\n自动动作（需 mode=act 且本项为开）：');
  for (const a of d.auto) console.log(`  ${a.enabled ? '[开]' : '[关]'} ${a.id.padEnd(14)} ${a.label}`);
  if (d.jobs.length) console.log(`\njob 级覆盖：${d.jobs.join('、')}`);
  console.log(`\n最近修改：${d.updatedAt ?? '-'} by ${d.updatedBy ?? '-'}`);
  console.log('\n提示：默认全部关闭。要清过期锁（真正修复）需 mode=act + auto on selfHeal。');
  return 0;
}

let rc = 0;
try {
  if (cmd === 'status') rc = printStatus();
  else if (cmd === 'mode') {
    if (!verb || !MODES.includes(verb)) throw new Error(`用法：mode ${MODES.join('|')}（收到 ${verb ?? '空'}）`);
    const r = setMode(verb, { home, by, why });
    if (!r.ok) throw new Error(r.error);
    console.log(`档位已切到 ${verb}（by ${by}${why ? `，why: ${why}` : ''}）`);
  } else if (cmd === 'module' || cmd === 'job' || cmd === 'auto') {
    if (!['on', 'off'].includes(verb) || !id) throw new Error(`用法：${cmd} on|off <id>`);
    const enabled = verb === 'on';
    const r = cmd === 'module' ? setModule(id, enabled, { home, by, why })
      : cmd === 'job' ? setJob(id, enabled, { home, by, why })
        : setAuto(id, enabled, { home, by, why });
    if (!r.ok) throw new Error(r.error);
    console.log(`${cmd} ${id} → ${enabled ? '开' : '关'}（by ${by}${why ? `，why: ${why}` : ''}）`);
  } else {
    throw new Error(`未知子命令：${cmd}`);
  }
} catch (e) {
  console.error(`[ops-autonomy] ${e.message}`);
  console.error(`可用：status | mode ${MODES.join('|')} | module on|off <${Object.keys(MODULES).join('|')}> | job on|off <id> | auto on|off <${Object.keys(AUTO_ACTIONS).join('|')}>`);
  rc = 2;
}
process.exitCode = rc;
