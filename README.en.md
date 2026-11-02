# dsh-butler-core · a minimal, runnable ops skeleton

> ### What this is
> **A minimal ops skeleton that actually runs**: a resident scheduler, autonomy gates, notifications, a daily report, and a hash-chained audit log.
>
> ### What it solves
> The risk of letting an agent run unattended is not that it is slow — it is that **it does not know where the line is**. Which actions may it decide on its own, and which must wait for a human? That matrix lives here: every autonomous action carries its actor and reason and lands in a **hash-chained audit trail**, so afterwards you can answer "who did this, why, and when was it allowed".
>
> ### Run it in one command
> ```powershell
> npm i -g @kira905/dsh-butler-core
> ops-autonomy status        # read-only: current autonomy tier (changes nothing)
> ops-tickd                  # the resident scheduler - the only long-running process of the three
> ```
>
> ### Real output
> ```text
> Usage
>   ops-autonomy <status|mode|module|job|auto> [args] [--json]
>
> Autonomy matrix CLI: show the current tier, toggle modules / jobs / autonomous actions.
> Every write action carries --by / --why and records one audit line.
> ```
>
> Install steps and three read-only self-checks are below.

---

> A **zero-dependency** Node.js skeleton: tick scheduler + autonomy gate + queue notifications +
> daily report + hash-chained audit log.
> Built for people who keep agents running on their own machines: make one loop run, leave a
> trail you can read, and only then add automation on top.

**中文说明**: [README.md](./README.md)

---

## 0. Scope first (important)

**This is a distilled skeleton, not a verbatim copy of a production suite.**

- The code was **rewritten from scratch**. It shares no file hashes with any "production butler";
  most files have no same-named source at all. What it keeps is the **discipline** — atomic
  writes, single-holder locks, hash-chained audit, fail-safe gates, idempotency — not the code.
- It does **not** depend on the DSH host package and needs no host process: plain `node`, zero
  `dependencies`.
- It **only** schedules and records. It does not manage sessions, boards, memory, plugins,
  panels, or cross-machine sync.

If you want "install once and take over a whole ecosystem", that is not one package.
If you want a small loop you can read, modify and embed in your own scripts, this is it.

---

## 1. Who it is for

| You | What you use it for |
|---|---|
| Someone running long-lived agents on your own box | a scheduling skeleton for "things that should happen every day": report, notify, clear stale locks |
| Someone who wants to read a framework-free scheduler | 17 runtime `.mjs` files, one concern per file, no hidden dependencies |
| Someone adding accountable automation to a project | hash-chained audit + two-key release gates, copy it as-is |

Not for: turnkey ops platforms, GUI lovers, cross-machine orchestration.

---

## 2. Run it in three minutes

Requires Node.js **>= 20**. No `npm install` (zero dependencies).

### Windows (PowerShell)

```powershell
git clone <repo-url>
cd dsh-butler-core
powershell -ExecutionPolicy Bypass -File .\examples\quickstart.ps1
```

### Linux / macOS

```sh
git clone <repo-url>
cd dsh-butler-core
sh ./examples/quickstart.sh
```

### Or a single command

```sh
node bin/ops-tickd.mjs --once --home ./.ops-demo-home
```

> `quickstart` writes state into **`.ops-demo-home` under the current directory** and **never
> touches your `~/.dsh`**. Change the location with `-StateHome <dir>` (PowerShell) or
> `OPS_CORE_HOME=<dir>` (sh).

A run looks like this:

```
ops-tickd：home=.../.ops-demo-home · 档位=observe · 强制
job            状态  耗时ms  说明
queue-notify   ok    3       ok
self-heal      ok    5       ok
daily-report   ok    8       ok

产物：.../.ops-demo-home/ops-reports/2026-10-20.md
审计：.../.ops-demo-home/ops-audit
```

Run the same command again: the daily report is **not rewritten** (byte-identical content is
skipped). That is the idempotency check.

---

## 3. What one tick leaves behind

| Artifact | Location | In one sentence |
|---|---|---|
| Daily report | `ops-reports/<date>.md` | mode / last job statuses / state-file health / queue stats / alert count |
| Audit trail | `ops-audit/<YYYY-MM>.jsonl` | append-only, one JSON per line, `prev` + `hash` chain |
| Notification output | `ops-notify-outbox.jsonl` | default channel is a local file: one line per "notification that would have been sent" |
| Alerts | `ops-alert.log` | the component's own failures (not business alerts) |
| Scheduler state | `ops-tickd.json` | last 50 ticks + per-job last status |
| Self-heal log | `ops-heal-log.jsonl` | which state files were initialised, which stale locks were cleared |

**To have something to send**, put an item into `ops-queue.json`:

```json
{ "items": [{ "level": "info", "message": "hello" }] }
```

The next tick appends it to `ops-notify-outbox.jsonl` and records its id in
`ops-notify-state.json` (`processed[]`) so it is never sent twice.

---

## 4. State files (and what breaks without them)

Everything lives under one root: `--home` > `OPS_CORE_HOME` > `DSH_HOME` > `~/.dsh`.
Full table (writer / purpose / backup / may leave the machine) in
[docs/状态文件清单.md](./docs/状态文件清单.md) (Chinese).

| File | Written by | If missing |
|---|---|---|
| `ops-autonomy.json` | `ops-autonomy` / `ops-tickd` | auto-created with defaults (`observe`, all gates off); deleting it loses your release records |
| `ops-tickd.json` | `ops-tickd` | auto-created empty; only affects "where the last tick got to" |
| `ops-queue.json` | **you** (the only caller-fed file) | auto-created empty; nothing to notify |
| `ops-notify-state.json` | `queue-notify` job | auto-created empty; deleting it re-sends history |
| `ops-notify-outbox.jsonl` | `queue-notify` job | created on first send; an artifact, not state |
| `ops-audit/<YYYY-MM>.jsonl` | every write action | created on first audit; **do not delete** — it is the only evidence |
| `ops-alert.log` | the component itself | created on first alert; an artifact |
| `ops-reports/<date>.md` | `daily-report` job | regenerated on the next tick |
| `ops-locks/*.lock` | scheduler | created on first lock; a crash leaves a stale one (cleared by self-heal) |
| `ops-heal-log.jsonl` | `self-heal` job | created on first repair action; an artifact |
| `ops-changelog/<YYYY-MM>.md` | `ops-changelog add` | created on first entry |

> This package **never reads or writes credential files** (such as the host home's
> `.credentials.yaml`), and ships **no default outbound address**.

---

## 5. The autonomy matrix: who may act on its own

Defaults are deliberately conservative: it may write artifacts, it may not repair anything.

| Item | Default | Meaning |
|---|---|---|
| `mode` | `observe` | observe only: report / audit / local outbox |
| `mode=act` | explicit | allows real repair actions (still governed by the next row) |
| `auto.selfHeal` | `false` | even in `act`, repairs need this flag to be `true` |

So a repair needs **two keys**: `mode=act` **and** `auto.selfHeal=true`.
Fail-safe: missing file, unparseable JSON, or any value that is not literally `true` counts as
"off".

```sh
node bin/ops-autonomy.mjs status
node bin/ops-autonomy.mjs mode act --why "clear stale locks once"
node bin/ops-autonomy.mjs auto on selfHeal --why "same as above"
node bin/ops-autonomy.mjs module off daily-report
```

Every toggle is persisted with `by` / `why` and appends one audit record.

---

## 6. Plug in your own notification channel

The default channel writes a local outbox. To send somewhere real, **pass the URL explicitly**
(the repository contains no default address):

```js
import { makeQueueNotifyJob, webhookNotifier } from '@kira905/dsh-butler-core';

const job = makeQueueNotifyJob({
  home: '/path/to/home',
  notifier: webhookNotifier({
    url: process.env.MY_HOOK_URL,
    headers: { authorization: `Bearer ${process.env.MY_HOOK_TOKEN}` },
  }),
});
```

`webhookNotifier` posts one JSON line (`source` / `level` / `message` / `at`); on failure it
returns `{ ok: false }` and **never throws**. A failed send is not marked as processed, so the
next tick retries it (and one alert is recorded).

---

## 7. Three engineering rules

1. **Atomic writes**: temp file in the same directory → `fsync` → `rename`. Retried 3 times;
   on final failure the `.tmp` is kept and an error is raised — it never degrades into writing
   the target directly.
2. **Hash-chained audit**: every record carries `prev` (previous hash) and its own `hash`; any
   deletion or edit shows up in the chain check of `ops-tickd --state`.
3. **Single-holder locks + idempotency**: each job claims a lock with `wx`; not getting it means
   "skip this round", not "fail". The report is not rewritten when the content is identical,
   and each queue item is notified once.

---

## 8. Layout

```
.
├── bin/            # ops-tickd / ops-autonomy / ops-changelog
├── src/            # paths, store, audit, alert, autonomy, scheduler,
│                   # registry, state-files, notify, cli, index
├── src/jobs/       # queue-notify, self-heal, daily-report
├── docs/           # one-page architecture + state-file list (Chinese)
├── examples/       # quickstart.ps1 / quickstart.sh
└── scripts/        # verify-source.mjs (self-check)
```

Programmatic use:

```js
import { createOpsScheduler } from '@kira905/dsh-butler-core';

const { scheduler } = createOpsScheduler({ home: process.env.OPS_CORE_HOME });
const run = await scheduler.tickOnce({ force: true });
console.log(run.executed, run.failed);
```

---

## 9. Self-check

```sh
node scripts/verify-source.mjs
```

Four checks; any failure gives a non-zero exit code:

1. every `.mjs` passes `node --check`;
2. no hard-coded absolute paths (drive letters / user home / temp directory);
3. no private dependencies: `dependencies` is empty and every `import` targets a `node:`
   builtin or a relative path in this repository;
4. `package.json` agrees with the file list: everything referenced by `files` / `bin` / `main` /
   `exports` exists.

---

## 10. What it deliberately does not do

- no default outbound channels (no WeCom / DingTalk / Slack adapter — only an explicit webhook);
- no timer watchdog: `--interval` runs a loop, but keeping it alive is your scheduler's job;
- no host lifecycle management (never starts, restarts or kills services);
- no cross-machine sync, no data migration;
- it never scans, reads or uploads your files — it writes only its own `ops-*` files.

---

## 11. License

**AGPL-3.0-only + commercial license (dual licensing)**, see [LICENSE](./LICENSE).

- Personal, educational and open-source use: free under **AGPL-3.0** (derivatives must also be
  released under AGPL).
- Closed-source / commercial use (where AGPL's copyleft obligations do not apply): a
  **commercial license** is available. This repository has no public contact address yet —
  **please open an issue**.

> Note: **AGPL, MIT and Apache do not forbid commercial use by themselves.** "Dual licensing"
> here means "either release your derivative under AGPL, or buy a commercial license".

---

<sub>This repository is the smallest loop that runs and leaves a readable trail. Add the rest on top.</sub>
