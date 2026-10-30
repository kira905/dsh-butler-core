/**
 * `dsh --profile <p> --dump-config` 输出 + stderr 的解析，以及「挂载生效没」的四格判定。
 *
 * 全是纯函数（输入字符串 / 布尔，输出对象），**不读盘、不起进程** —— 这样四格的每一条
 * 判定都能被夹具逐个证红（把判据改反，夹具必须红）。
 *
 * 两个必须先讲清的口径（都是实测出来的，写错就出假红）：
 *
 * ① 段头（`# == <X>`）有两种：
 *    · `<X>` 是**包名**（`dsh-memory` / `@kira905/xxx`）⇒ 这是真正的组合层（bundle）
 *    · `<X>` 是**绝对文件路径**（profile 自己的 cordis.patch.yml）⇒ 这是用户 patch 层，
 *      它 patch 的条目属于别的 bundle，**不能算作一个 bundle 段**
 *    带 `, patched by <来源>` 后缀的是同一层的重复打印（每个 patch 打一次）。
 *
 * ② 「同一个 id / name 出现几次」**不能按全文字面数**：同一个 bundle 被 patch 几次，
 *    就会把同一批条目重打几遍。实测生产 profile（71 段 / 215 个 id）里 `ids` 字面重复 0 次、
 *    但 `names` 里有 `@deepseek-ai/dsh-agent-preset` 出现 8 次 —— 全在它自己的段里。
 *    真正的"撞车 / 双挂"判据是：**同一个 id（或 name）落在两个不同的 bundle 段头下**。
 *    这条口径同时覆盖方案 §2.4-③ 的场景（两个 bundle 各 insert 一个 `id: memory`）。
 */

/** 段头是不是"绝对文件路径"（= profile 用户 patch 层，不是 bundle 段） */
export function isPathLikeHead(head) {
  const s = String(head ?? '').trim();
  if (!s) return false;
  if (/^[A-Za-z]:[\\/]/.test(s)) return true;
  if (s.startsWith('/') || s.startsWith('\\\\')) return true;
  return s.includes('\\');
}

/**
 * 把 dump 文本切成段。
 * @returns {{head:string, patchedBy:string|null, isPathLayer:boolean, ids:string[], names:string[]}[]}
 */
export function parseDump(text) {
  const segs = [];
  let cur = null;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const head = /^# == (.+)$/.exec(line);
    if (head) {
      const raw = head[1].trim();
      const at = raw.indexOf(', patched by ');
      const name = (at >= 0 ? raw.slice(0, at) : raw).trim();
      const patchedBy = at >= 0 ? raw.slice(at + ', patched by '.length).trim() : null;
      cur = { head: name, patchedBy, isPathLayer: isPathLikeHead(name), ids: [], names: [] };
      segs.push(cur);
      continue;
    }
    if (!cur) continue;
    let m = /^- id: (.+)$/.exec(line);
    if (m) {
      cur.ids.push(m[1].trim().replace(/^['"]|['"]$/g, ''));
      continue;
    }
    m = /^ {2}name: (.+)$/.exec(line);
    if (m) cur.names.push(m[1].trim().replace(/^['"]|['"]$/g, ''));
  }
  return segs;
}

/**
 * 汇总一次 dump 的可用事实。
 * @returns {{
 *   segments: Array, bundleHeads: string[], pathLayers: string[],
 *   hasBundle: (name:string)=>boolean,
 *   ids: Map<string, Set<string>>, names: Map<string, Set<string>>,
 *   lineCount: number
 * }}
 */
export function summarizeDump(text) {
  const segments = parseDump(text);
  const bundleHeads = [];
  const pathLayers = [];
  const ids = new Map();
  const names = new Map();
  for (const seg of segments) {
    if (seg.isPathLayer) {
      if (!pathLayers.includes(seg.head)) pathLayers.push(seg.head);
      // 用户 patch 层里的条目属于它 patch 的那个 bundle，不计入撞车统计
      continue;
    }
    if (!bundleHeads.includes(seg.head)) bundleHeads.push(seg.head);
    for (const id of seg.ids) {
      if (!ids.has(id)) ids.set(id, new Set());
      ids.get(id).add(seg.head);
    }
    for (const n of seg.names) {
      if (!names.has(n)) names.set(n, new Set());
      names.get(n).add(seg.head);
    }
  }
  return {
    segments,
    bundleHeads,
    pathLayers,
    hasBundle: (name) => bundleHeads.includes(String(name)),
    ids,
    names,
    lineCount: String(text ?? '').split(/\r?\n/).length,
  };
}

/**
 * 撞车 / 双挂：同一个 id（或 name）落在 >1 个 bundle 段头下。
 * @returns {{id: string, heads: string[]}[]}
 */
export function findCollisions(summary) {
  const out = [];
  for (const [key, heads] of summary.ids) {
    if (heads.size > 1) out.push({ kind: 'id', key, heads: [...heads] });
  }
  for (const [key, heads] of summary.names) {
    if (heads.size > 1) out.push({ kind: 'name', key, heads: [...heads] });
  }
  return out;
}

/**
 * 从 stderr 里抠 `skipping profile bundle "<包名>": <原因>`（主包 reportSkippedBundles 的原文格式）。
 * @returns {{packageName:string, reason:string, kind:'no-bundle'|'missing-entity'|'compat'|'other'}[]}
 */
export function parseSkipLines(text) {
  const out = [];
  const re = /skipping profile bundle\s+("(?:[^"\\]|\\.)*"|[^\s:]+)\s*:\s*(.*)$/gm;
  let m;
  while ((m = re.exec(String(text ?? '')))) {
    let packageName = m[1].trim();
    if (packageName.startsWith('"')) {
      try {
        packageName = JSON.parse(packageName);
      } catch {
        packageName = packageName.replace(/^"|"$/g, '');
      }
    }
    const reason = m[2].trim();
    out.push({ packageName, reason, kind: classifySkipReason(reason) });
  }
  return out;
}

/**
 * 把跳过原因归到方案要求的三种之一。
 * 三处文案出自主包 dsh-app-boot 的 loadProfileDirectory（三处 throw）：
 *   实体不在      → `cannot resolve profile bundle "<x>" from ...`
 *   声明缺失      → `profile bundle "<x>" declares no dsh.bundle in its package.json`
 *   主包版本兼容闸 → `Plugin <x>@<v> is incompatible with dsh <v>: peerDependencies ...`
 * 归因顺序固定：先排"声明缺失 / 实体不在"（这两种改包或重装能解），最后才写兼容闸。
 */
export function classifySkipReason(reason) {
  const s = String(reason ?? '');
  if (/declares no dsh\.bundle/i.test(s)) return 'no-bundle';
  if (/cannot resolve profile bundle/i.test(s)) return 'missing-entity';
  if (/is incompatible with dsh/i.test(s) || /peerDependencies/i.test(s)) return 'compat';
  return 'other';
}

export const SKIP_ATTRIBUTION = {
  'no-bundle': '① 声明缺失 / 放错层（包根 package.json 里没有 dsh.bundle，例如声明被挪进了子包）',
  'missing-entity': '② 实体不在（卸载残留 / 降级回旧版 / 装在了别的 node_modules 根下）',
  compat: '③ 主包版本兼容闸（peerDependencies 与当前 dsh 不匹配，未领 exact-version 豁免）',
  other: '⑤ 跳过原因是别的（未能归入三类，原文见 detail）',
};

/**
 * 第 12 项的核心：四格 + 四格之外那一格。
 *
 * 两个词在这里**定死**（方案 R2-B1）：
 *   · 「声明」= 包实体 `node_modules/<包>/package.json#dsh.bundle`
 *   · 「登记」= profile `package.json#dsh.profile.bundles` 里有这个包名
 *
 * @param {{
 *   name: string,
 *   hasBundle: boolean,        // 包实体自己有没有 dsh.bundle
 *   registered: boolean,       // profile 的 bundles 里登记了没
 *   treeKnown: boolean,        // 组合树能不能判（跑到了 dump / 给了离线 dump）
 *   inTree: boolean,           // dump 里有没有这个包名的段
 *   skipped: {kind:string, reason:string}|null,  // stderr 里这个包的跳过记录
 * }} input
 * @returns {{verdict:'PASS'|'PASS-NOTE'|'FAIL'|'SKIP', cell:string, message:string, attribution:string|null}}
 */
export function judgeMount(input) {
  const name = String(input?.name ?? '');
  const hasBundle = input?.hasBundle === true;
  const registered = input?.registered === true;
  const treeKnown = input?.treeKnown === true;
  const inTree = input?.inTree === true;
  const skipped = input?.skipped ?? null;

  // 四格之外：登记了但包没声明
  if (registered && !hasBundle) {
    return {
      verdict: 'FAIL',
      cell: 'registered-without-bundle',
      message: '登记了但包没声明（多半降级/换包了）：要么装回带 dsh.bundle 的版本，要么摘掉这条登记',
      attribution: null,
    };
  }

  // 第 ④ 格：无 dsh.bundle、也没登记、树里也没有 ⇒ CLI 类，正确状态
  if (!hasBundle && !registered) {
    if (inTree) {
      return {
        verdict: 'PASS-NOTE',
        cell: 'no-bundle-but-in-tree',
        message: '包没声明 dsh.bundle，但组合树里出现了它的条目（多半由别的 bundle 带进来，不是它自己挂的）',
        attribution: null,
      };
    }
    return {
      verdict: 'PASS-NOTE',
      cell: 'cli-class',
      message: '这是 CLI 类，正确状态（没声明 dsh.bundle、也没进组合列表）',
      attribution: null,
    };
  }

  // 第 ② 格：声明了但没登记 —— 最危险的一格，stderr 一个字都不给
  if (hasBundle && !registered) {
    return {
      verdict: 'FAIL',
      cell: 'declared-not-registered',
      message: `包声明了 bundle 但没登记，补跑 \`dsh plugin add ${name}\``,
      attribution: null,
    };
  }

  // 有声明 + 已登记
  if (!treeKnown) {
    return {
      verdict: 'SKIP',
      cell: 'tree-unknown',
      message: '文件层面正常（声明 + 登记都在），但组合树维度没判（没跑到 --dump-config / 用了 --no-dump）',
      attribution: null,
    };
  }
  if (inTree) {
    return { verdict: 'PASS', cell: 'all-three', message: '', attribution: null };
  }
  // 第 ③ 格：声明了、登记了、树里没有
  const attr = skipped ? SKIP_ATTRIBUTION[skipped.kind] ?? SKIP_ATTRIBUTION.other : null;
  return {
    verdict: 'FAIL',
    cell: 'registered-not-in-tree',
    message: '声明了但组合树里没有',
    attribution: attr ?? '跳过清单里没有它 ⇒ 原因未查证（不是 compatibility.json 那一种，别默认往那儿归）',
  };
}
