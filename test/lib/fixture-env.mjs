// 夹具环境构造：假 home / 假 profile / 假包 / 假 dump。
// 一切输入都落在**夹具自己的临时目录**里 —— 不读、不写任何真实安装。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir, rmTree, writeJson, writeText } from './harness.mjs';

export { makeTempDir, rmTree } from './harness.mjs';
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SELFCHECK = path.join(REPO_ROOT, 'scripts', 'selfcheck-replica.mjs');

/**
 * 造一个夹具 home：
 *   <root>/.dsh/profiles/<profile>/package.json      ← 假 profile（dependencies + dsh.profile.bundles）
 *   <root>/.dsh/profiles/<profile>/node_modules/<包>/ ← 假包（package.json 决定有没有 dsh.bundle）
 *
 * @param {{profile?:string}} [opts]
 */
export function makeFixtureHome(opts = {}) {
  const root = makeTempDir('butler-core-selfcheck');
  const profileName = opts.profile || 'web';
  const home = path.join(root, '.dsh');
  const profileDir = path.join(home, 'profiles', profileName);
  const modulesDir = path.join(profileDir, 'node_modules');
  fs.mkdirSync(modulesDir, { recursive: true });

  const dependencies = {};
  const bundles = [];
  const pkgPath = path.join(profileDir, 'package.json');

  const flush = () => {
    writeJson(pkgPath, {
      name: `dsh-profile-${profileName}`,
      private: true,
      dependencies,
      dsh: { profile: { bundles } },
    });
  };
  flush();

  return {
    root,
    home,
    profileName,
    profileDir,
    modulesDir,
    pkgPath,

    /** 加一个假包。dshBundle=false ⇒ 它是 CLI 类（装成普通依赖） */
    addPackage({ name, version = '1.0.0', dshBundle = true, registered = null, entry = true, bin = null }) {
      const dir = path.join(modulesDir, ...name.split('/'));
      const pkg = { name, version, main: entry ? 'lib/index.js' : 'lib/missing.js' };
      if (dshBundle) pkg.dsh = { bundle: { patch: 'cordis.patch.yml' } };
      if (bin) pkg.bin = bin;
      writeJson(path.join(dir, 'package.json'), pkg);
      if (entry) writeText(path.join(dir, 'lib', 'index.js'), 'export default {};\n');
      dependencies[name] = version;
      const shouldRegister = registered === null ? dshBundle : registered === true;
      if (shouldRegister && !bundles.includes(name)) bundles.push(name);
      flush();
      return dir;
    },

    /** 直接改 bundles 数组（造"位置互斥""登记了但包没声明"这类格子） */
    setBundles(list) {
      bundles.length = 0;
      for (const n of list) bundles.push(n);
      flush();
    },

    writeDump(text) {
      const file = path.join(root, 'dump-config.txt');
      writeText(file, text);
      return file;
    },

    writeManifest(objOrText) {
      const file = path.join(root, 'suite-manifest.json');
      if (typeof objOrText === 'string') writeText(file, objOrText);
      else writeJson(file, objOrText);
      return file;
    },

    cleanup() {
      rmTree(root);
    },
  };
}

/**
 * 造 dump 文本。段 = `# == <head>[, patched by <来源>]` + `- id: x` / `  name: 'y'`。
 * @param {{head:string, patchedBy?:string, ids?:string[], names?:string[]}[]} segments
 * @param {{skipLines?:string[], stderr?:string[]}} [extra] 也可以塞宿主的跳过行（离线 dump 常是 stdout+stderr 合一）
 */
export function dumpText(segments, extra = {}) {
  const out = [];
  for (const seg of segments) {
    const head = seg.patchedBy ? `# == ${seg.head}, patched by ${seg.patchedBy}` : `# == ${seg.head}`;
    out.push(head);
    for (const id of seg.ids || []) out.push(`- id: ${id}`);
    for (const n of seg.names || []) out.push(`  name: '${n}'`);
  }
  for (const line of extra.stderr || []) out.push(line);
  for (const line of extra.skipLines || []) out.push(line);
  return `${out.join('\n')}\n`;
}

/** 造一份最小可用的清单（每项都能过清单校验） */
export function makeManifest(items, extra = {}) {
  return {
    schemaVersion: 1,
    suite: 'fixture',
    description: '夹具清单',
    items,
    excluded: [],
    ...extra,
  };
}

/** 造一个会睡很久的假命令包（测探针超时 / 整批墙钟） */
export function addSlowCommand(home, { name, cmd, sleepMs = 5000, exitCode = 0, writes = null }) {
  const dir = path.join(home.modulesDir, ...name.split('/'));
  const script = path.join(dir, 'slow.mjs');
  const lines = [
    "import fs from 'node:fs';",
    `const sleepMs = ${Number(sleepMs)};`,
    "const until = Date.now() + sleepMs;",
    'while (Date.now() < until) { /* busy-ish wait, but yield occasionally */ }',
  ];
  if (writes) {
    lines.push(`try { fs.writeFileSync(${JSON.stringify(writes)}, 'ran\\n'); } catch {}`);
  }
  lines.push(`process.exitCode = ${Number(exitCode)};`);
  writeText(script, `${lines.join('\n')}\n`);
  writeJson(path.join(dir, 'package.json'), { name, version: '1.0.0', bin: { [cmd]: 'slow.mjs' } });
  return { dir, script };
}

/**
 * 造一个"没实现 --help、被 --help 一戳就干活"的假命令：
 * 一旦被执行就写一个标记文件 —— 夹具据此断言"它到底有没有被跑"。
 */
export function addNoHelpCommand(home, { name, cmd, marker }) {
  const dir = path.join(home.modulesDir, ...name.split('/'));
  const script = path.join(dir, 'real-action.mjs');
  writeText(
    script,
    [
      "import fs from 'node:fs';",
      'const args = process.argv.slice(2);',
      `fs.writeFileSync(${JSON.stringify(marker)}, 'ran:' + args.join(',') + '\\n');`,
      'process.exitCode = 0;',
      '',
    ].join('\n'),
  );
  writeJson(path.join(dir, 'package.json'), { name, version: '1.0.0', bin: { [cmd]: 'real-action.mjs' } });
  return { dir, script, marker };
}
