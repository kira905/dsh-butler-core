// ops-core / src/index.mjs —— 对外的程序化入口
//
// 想在自己的脚本里跑一轮：
//   import { createOpsScheduler } from '@kira905/dsh-butler-core';
//   const { scheduler } = createOpsScheduler({ home: process.env.DSH_HOME });
//   await scheduler.tickOnce({ force: true });
export { resolveHome, opsPaths, COMPONENT_ROOT } from './paths.mjs';
export { readJson, writeJsonAtomic, writeTextAtomic, updateJson, acquireLock, releaseLock, listLocks, fingerprint } from './store.mjs';
export { appendAudit, tailAudit, verifyAuditChain } from './audit.mjs';
export { alert, addChannel, tailAlerts } from './alert.mjs';
export { readAutonomy, isModuleEnabled, isJobEnabled, isAutoAllowed, setModule, setJob, setAuto, setMode, describe, MODULES, AUTO_ACTIONS, MODES } from './autonomy.mjs';
export { createScheduler } from './scheduler.mjs';
export { inspectStateFiles, healthSummary, STATE_FILES } from './state-files.mjs';
export { fileNotifier, webhookNotifier } from './notify.mjs';
export { makeDailyReportJob } from './jobs/daily-report.mjs';
export { makeQueueNotifyJob, stableQueueId } from './jobs/queue-notify.mjs';
export { makeSelfHealJob } from './jobs/self-heal.mjs';
export { createOpsScheduler } from './registry.mjs';
