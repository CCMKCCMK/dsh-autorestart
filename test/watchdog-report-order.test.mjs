/**
 * 救援报告必须**先**落盘，清理动作**后**发生。
 *
 * 为什么单开这个文件（2026-11-01 回归，由 14e9a6b 引入）：
 *
 *   1. `runWatchdogFlow` 的 finally 原来是「先 removeSchedule()，后 writeReport()」；
 *   2. 14e9a6b 把 cleanupSystemdUnit 从「只 reset-failed」改成「先真正 stop」；
 *   3. CLI 注入的 removeSchedule 在 systemd-run 档位执行的是
 *      `systemctl --user stop dsh-autorestart-watchdog.service` —— 那正是承载
 *      这个 CLI 自己的 service。
 *
 * 于是 service 一停，systemd 给进程发 SIGTERM，进程在 writeReport() 之前就没了：
 * 守夜人成功把 profile 还原了（70 字节 → 691、端口重新监听、pending 被清掉），
 * 报告却还停在启动那一刻的 `result: armed`。客户看到的是「武装好了，什么也没
 * 发生」——这比没有守夜人更糟：下一次出问题，没人知道上一次是被救回来的。
 *
 * 两层的修法都在这里被测试守住：
 *   - 顺序：写报告 → 清 pending → 清理调度项（本文件第 1、2 组）；
 *   - 自清理不停自己：systemd-run 档位下 `includeService: false`（第 3 组）。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildPending,
  readPending,
  readReport,
  reportPath,
  runWatchdogFlow,
  writePending,
  writeReport as writeReportToDisk,
} from '../lib/watchdog.js';
import { cleanupSystemdUnit, removeScheduleItem } from '../lib/watchdog-schedule.js';

/** 这份 marker 声称可以还原的副本（测试里不需要真实存在：runRestore 是注入的）。 */
const TARGET_DIR = '/tmp/dsh-ar-report-order-target';
/** systemd-run 档位的单元基名。 */
const UNIT = 'dsh-autorestart-watchdog';
const TIMER = UNIT + '.timer';
const SERVICE = UNIT + '.service';

/** 每个测试自建目录，失败也不留垃圾。 */
const createdDirs = [];

function tempDir(name) {
  const dir = path.join(os.tmpdir(), 'dsh-wd-order-' + name + '-' + process.pid + '-' + Date.now());
  fs.mkdirSync(dir, { recursive: true });
  createdDirs.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of createdDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // 删不掉的临时目录不算测试失败。
    }
  }
});

/**
 * 一份「守夜人成功救回来」的运行所需依赖：先等不到 ready、没有活着的实例、
 * 健康路问不到，于是一次还原 + 一次重启，重启之后 ready 出现 → `recovered`。
 *
 * @returns {object}
 */
function rescueDeps() {
  const state = { restored: 0, relaunched: 0, removed: 0 };
  let ready = false;
  const deps = {
    state,
    // 时钟与 sleep 都是假的：不靠真实时间，测试也不慢。
    sleep: async () => {},
    now: () => 0,
    pollMs: 1000,
    readReady: () => ready,
    isWithdrawn: () => false,
    probeAlive: async () => false,
    askHealth: () => 'unknown',
    runRestore: () => {
      state.restored += 1;
      return { ok: true, dir: TARGET_DIR };
    },
    runRelaunch: () => {
      state.relaunched += 1;
      ready = true;
      return { ok: true };
    },
    clearCookies: () => ({ ok: true, removed: 0, error: null }),
    acquireLock: () => true,
    releaseLock: () => {},
    removeSchedule: () => {
      state.removed += 1;
    },
    writeReport: (report) => writeReportToDisk(state.dir, report),
  };
  return deps;
}

/** 一份「这次重启可以还原某个副本」的 pending marker。 */
function armedPending() {
  return buildPending({
    tier: 'systemd-run',
    tierReason: 'systemd-run was chosen',
    unitId: UNIT,
    restoreTargetDir: TARGET_DIR,
    timeoutMs: 0,
    recheckMs: 0,
    readyTimeoutMs: 0,
    maxAttempts: 1,
  });
}

// ---------------------------------------------------------------------------
// 1. 顺序：清理动作发生的那一刻，盘上必须已经是本次救援结果
//
// 这一条就是回归本身。注入的 removeSchedule **会抛错**（模拟 CLI 里那条
// `systemctl --user stop`：它一执行，进程就被 SIGTERM 带走）。因为报告在它之前
// 已经落盘，测试读到的才是救援结果；如果顺序被改回去，这里读到的只会是启动时
// 留下的 `armed`，断言立刻失败。
// ---------------------------------------------------------------------------

test('清理会杀掉本进程时，报告仍然早已写成：写报告 → 清 pending → 清调度项', async () => {
  const dir = tempDir('order');
  const deps = rescueDeps();
  deps.state.dir = dir;
  // pending 一开始就在盘上：这样「清 pending」发生在哪一步是可观测的。
  writePending(dir, armedPending());
  // 启动那一刻的报告先写进去（真机上它由武装方写入），顺序错了就会停在它上面。
  writeReportToDisk(dir, { at: new Date(0).toISOString(), result: 'armed', tier: 'systemd-run' });

  const events = [];
  deps.writeReport = (report) => {
    events.push({
      step: 'writeReport',
      reportOnDisk: fs.existsSync(reportPath(dir)),
      pendingStillThere: readPending(dir) !== null,
    });
    writeReportToDisk(dir, report);
  };
  deps.removeSchedule = () => {
    deps.state.removed += 1;
    events.push({
      step: 'removeSchedule',
      reportOnDisk: fs.existsSync(reportPath(dir)),
      pendingStillThere: readPending(dir) !== null,
      // 清理动作那一刻盘上的报告内容——回归时这里会是 `armed`。
      onDiskReport: readReport(dir),
    });
    // 模拟「这条清理把承载本进程的 service 停了」：systemd 随后发 SIGTERM。
    throw new Error('terminated: systemctl --user stop ' + SERVICE);
  };

  const report = await runWatchdogFlow({ pending: armedPending(), stateDir: dir, deps });

  assert.deepEqual(
    events.map((event) => event.step),
    ['writeReport', 'removeSchedule'],
    '收尾顺序必须是：写报告 → 清 pending → 清理调度项；清理不许跑到写报告前面',
  );
  assert.equal(events[0].reportOnDisk, true, '写报告那一步，报告文件必须真的在盘上（不是刚打开）');
  assert.equal(
    events[1].reportOnDisk,
    true,
    '清理动作发生时报告必须已经在盘上：否则进程一被杀，这次救援就没有任何记录',
  );
  assert.equal(
    events[1].pendingStillThere,
    false,
    '清 pending 发生在写报告之后、清理调度项之前（顺序：报告 → pending → 调度项）',
  );

  const atCleanup = events[1].onDiskReport;
  assert.ok(atCleanup, '清理发生时报告文件是可读的');
  assert.equal(atCleanup.result, 'recovered', '清理发生时盘上已经是本次结果，而不是启动时的 armed');
  assert.notEqual(atCleanup.result, 'armed', '不许停在启动那一刻的 armed');
  assert.equal(atCleanup.restored, true, '报告里有「确实还原过」');
  assert.equal(atCleanup.restoredFrom, TARGET_DIR, '报告里有「还原的是哪一份」');
  assert.equal(atCleanup.attemptLog.length, 1, '报告里有这次尝试的流水');
  assert.equal(atCleanup.attemptLog[0].restored, true);

  // 清理虽然抛了（进程本该被杀），调度项**确实被尝试清理过**——不许用「不清理」绕过。
  assert.equal(deps.state.removed, 1, '调度项必须仍然被清理（即使它会把进程杀掉）');

  // 运行结束后盘上的报告同样是本次结果（异常被 finally 吞掉，报告不被覆盖回 armed）。
  const finalReport = readReport(dir);
  assert.equal(finalReport.result, 'recovered');
  assert.equal(report.result, 'recovered');
});

test('成功救援后 last-watchdog-report.json 就是本次结果（restored / restoredFrom / attemptLog）', async () => {
  const dir = tempDir('result-on-disk');
  const deps = rescueDeps();
  deps.state.dir = dir;
  writePending(dir, armedPending());
  // 武装那一刻留下的旧报告：旧版本就是被它盖住后永远停在这里。
  writeReportToDisk(dir, { at: new Date(0).toISOString(), result: 'armed', tier: 'systemd-run' });

  const report = await runWatchdogFlow({ pending: armedPending(), stateDir: dir, deps });
  const onDisk = readReport(dir);

  assert.equal(report.result, 'recovered');
  assert.ok(onDisk, '报告必须在盘上');
  assert.equal(onDisk.result, 'recovered', '盘上的报告必须是本次救援结果');
  assert.equal(onDisk.restored, true);
  assert.equal(onDisk.restoredFrom, TARGET_DIR);
  assert.ok(Array.isArray(onDisk.attemptLog) && onDisk.attemptLog.length > 0, 'attemptLog 必须在报告里');
  assert.equal(onDisk.attemptLog[0].restoredFrom, TARGET_DIR, '流水里写明还原的是哪一份');
  assert.equal(deps.state.removed, 1, '调度项被清理（不是「干脆不清理」）');
  assert.equal(readPending(dir), null, 'pending 被清掉');
});

// ---------------------------------------------------------------------------
// 2. 写报告失败必须看得见：stderr 一行 + 返回值字段（CLI 用它决定退出码），
//    而且清理仍然发生。
// ---------------------------------------------------------------------------

test('报告写不出去时：stderr 点名原因，返回值带 reportWriteError，清理照旧发生', async () => {
  const dir = tempDir('write-fails');
  const deps = rescueDeps();
  deps.state.dir = dir;
  writePending(dir, armedPending());
  deps.writeReport = () => {
    throw new Error('EACCES: the state directory is read-only');
  };

  const logged = [];
  const originalError = console.error;
  console.error = (...args) => { logged.push(args.map(String).join(' ')); };
  let report = null;
  try {
    report = await runWatchdogFlow({ pending: armedPending(), stateDir: dir, deps });
  } finally {
    console.error = originalError;
  }

  assert.equal(report.reportWritten, false, '返回值必须明说报告没写成');
  assert.match(String(report.reportWriteError), /EACCES/, '返回值带原始原因');
  assert.ok(
    logged.some((line) => /could not be written/.test(line) && /EACCES/.test(line)),
    '失败必须打到 stderr，不许静默：' + JSON.stringify(logged),
  );
  // 报告失败不是跳过清理的借口。
  assert.equal(deps.state.removed, 1, '调度项仍然被清理');
  assert.equal(readPending(dir), null, 'pending 仍然被清掉');
  // 救援本身的结果仍然在返回值里（供 CLI 汇总）。
  assert.equal(report.result, 'recovered');
});

// ---------------------------------------------------------------------------
// 3. 自清理不许停掉承载自己的 service
//
// CLI 跑在 `systemd-run --on-active` 起的 one-shot service 里：`stop` 那个
// service 等于给自己发 SIGTERM。所以 systemd-run 档位要能「只停 timer」。
// 宿主进程（index.js / disarm）那条路照旧停 service —— 它不在那个 service 里跑。
// ---------------------------------------------------------------------------

/** 一个只记录调用、永远成功的假 systemctl。 */
function fakeExec() {
  const calls = [];
  const exec = (file, args) => {
    calls.push([file, ...args].join(' '));
    return { ok: true, stdout: '', error: null };
  };
  return { exec, calls };
}

test('includeService:false 时只停 timer，绝不下 stop <service> 这条命令', () => {
  const systemd = fakeExec();
  const result = cleanupSystemdUnit({ unitId: UNIT, exec: systemd.exec, includeService: false });

  assert.equal(
    systemd.calls.includes('systemctl --user stop ' + SERVICE),
    false,
    '自清理不许 stop 承载自己的 service：' + JSON.stringify(systemd.calls),
  );
  assert.ok(
    systemd.calls.includes('systemctl --user stop ' + TIMER),
    '但 timer 必须真的被停掉（调度项不许留下来）',
  );
  assert.deepEqual(result.stopped, [TIMER], '报告里只承认 timer 被停了');
  assert.equal(result.serviceStopSkipped, true, '跳过 service 是有意的，报告要说得出来');
  assert.equal(result.ok, true, '跳过不是失败：' + String(result.error));

  const skipStep = result.steps.find((step) => step.unit === SERVICE && step.action === 'stop');
  assert.ok(skipStep, 'service 的那一步仍然出现在步骤里（不许悄悄消失）');
  assert.equal(skipStep.outcome, 'skipped');
  assert.equal(skipStep.executed, false);
  assert.match(String(skipStep.reason), /includeService=false/, '步骤里写明为什么跳过');
});

test('removeScheduleItem 把 includeService 透传到 systemd-run 档位', () => {
  const systemd = fakeExec();
  const removed = removeScheduleItem({
    tier: 'systemd-run',
    unitId: UNIT,
    exec: systemd.exec,
    includeService: false,
  });
  assert.equal(removed.ok, true, String(removed.error));
  assert.equal(systemd.calls.includes('systemctl --user stop ' + SERVICE), false);
  assert.ok(systemd.calls.includes('systemctl --user stop ' + TIMER));
});

test('宿主进程那条路仍然停 service（默认 includeService:true，没有被削弱）', () => {
  const systemd = fakeExec();
  const result = cleanupSystemdUnit({ unitId: UNIT, exec: systemd.exec });
  assert.deepEqual(systemd.calls, [
    'systemctl --user stop ' + TIMER,
    'systemctl --user stop ' + SERVICE,
    'systemctl --user reset-failed ' + TIMER,
    'systemctl --user reset-failed ' + SERVICE,
  ], '默认行为一个字都不许变：宿主不在那个 service 里跑，停掉残留的 service 才是对的');
  assert.equal(result.serviceStopSkipped, false);
});

test('reset-failed 保留：它只清失败状态，不停单元，所以对「自己」安全', () => {
  const systemd = fakeExec();
  cleanupSystemdUnit({ unitId: UNIT, exec: systemd.exec, includeService: false });
  assert.ok(
    systemd.calls.includes('systemctl --user reset-failed ' + SERVICE),
    'reset-failed service 不会终止进程，而且能让下一次武装重新用上同一个单元名',
  );
});

// ---------------------------------------------------------------------------
// 4. CLI 的接线（scripts/watchdog.mjs 很难在测试里以 systemd 服务身份运行，
//    所以对它的接线做源码断言：改回去就红）
// ---------------------------------------------------------------------------

const cliPath = new URL('../scripts/watchdog.mjs', import.meta.url);
const cliSource = fs.readFileSync(cliPath, 'utf8');

test('CLI 注入的 removeSchedule 带 includeService:false（自清理不停自己）', () => {
  assert.match(
    cliSource,
    /removeSchedule:\s*\(\)\s*=>\s*\{[\s\S]*?includeService:\s*false[\s\S]*?\}/,
    'CLI 的 removeSchedule 必须传 includeService:false —— 否则 systemctl stop 会把自己杀掉',
  );
});

test('CLI 的「没有 pending」这条路也是先写报告、再清理', () => {
  const start = cliSource.indexOf('if (!pending) {');
  assert.ok(start >= 0, '找不到「没有 pending」那段代码');
  const block = cliSource.slice(start, start + 3000);
  const reported = block.indexOf('reportAndWarn(stateDir, {');
  const cleaned = block.indexOf('schedule.removeScheduleItem(');
  assert.ok(reported >= 0, '这一段必须先留下报告');
  assert.ok(cleaned >= 0, '这一段仍然要清理调度项');
  assert.ok(
    reported < cleaned,
    '顺序错了：清理会把承载本进程的 service 停掉，报告必须写在它之前（report@' + reported
      + ' cleanup@' + cleaned + '）',
  );
  assert.match(
    block,
    /removeScheduleItem\(\{\s*tier:\s*'systemd-run',\s*unitId:\s*UNIT_ID,\s*includeService:\s*false\s*\}\)/,
    '这一段的 systemd-run 清理同样不许 stop 自己的 service',
  );
});
