import fs from 'node:fs';
import path from 'node:path';
import { db, getSetting, logEvent } from './db.js';
import { nowIso, jsonParse, uid } from './utils.js';
import { pollRemoteTasks } from './provider/creativeStudioI2V.js';
import { downloadCandidates, isExistingVideo } from './downloadService.js';
import { runWorker, taskEvents, updateTaskRecord } from './taskService.js';

let cycleRunning = false;
let timer = null;
let stopped = false;

function emit(type, payload = {}) {
  taskEvents.emit('event', { type, at: nowIso(), ...payload });
}

function afterSeconds(seconds) {
  return new Date(Date.now() + Number(seconds) * 1000).toISOString();
}

function pollIntervalSeconds() {
  return Math.max(15, Math.min(600, Number(getSetting('pollIntervalSeconds', 45)) || 45));
}

function downloadRetryLimit() {
  return Math.max(0, Math.min(10, Number(getSetting('downloadRetryLimit', 3)) || 3));
}

function rowById(id) {
  return db.prepare(`SELECT t.*, b.output_directory, b.cookie_profile_id
    FROM generation_tasks t JOIN batches b ON b.id=t.batch_id WHERE t.id=?`).get(id);
}

function activePollRows() {
  const at = nowIso();
  return db.prepare(`SELECT t.*, b.cookie_profile_id, b.output_directory
    FROM generation_tasks t JOIN batches b ON b.id=t.batch_id
    WHERE t.status IN ('submitted','polling')
      AND t.remote_task_id IS NOT NULL
      AND (t.next_poll_at IS NULL OR t.next_poll_at<=?)
    ORDER BY t.submitted_at,t.created_at LIMIT 200`).all(at);
}

function activeDownloadRows() {
  const at = nowIso();
  return db.prepare(`SELECT t.*, b.cookie_profile_id, b.output_directory
    FROM generation_tasks t JOIN batches b ON b.id=t.batch_id
    WHERE t.status IN ('video_ready','download_retry')
      AND t.video_url IS NOT NULL
      AND (t.next_poll_at IS NULL OR t.next_poll_at<=?)
    ORDER BY t.updated_at LIMIT 20`).all(at);
}

function compactRemote(summary) {
  if (!summary?.raw) return null;
  const raw = summary.raw;
  return {
    id: raw.id || null,
    taskId: raw.taskId || raw.task_id || null,
    genDraftId: raw.genDraftId || null,
    status: raw.status ?? null,
    draftTaskStatus: raw.draftTaskStatus ?? null,
    renderTaskStatus: raw.renderTaskStatus ?? null,
    exported: raw.exported ?? null,
    completeTime: raw.completeTime ?? null,
    vid: raw.vid || null,
    watermarkVid: raw.watermarkVid || null,
    previewLink: raw.previewLink || null,
    videoUrls: summary.videoUrls || [],
    error: summary.error || '',
    errorCode: summary.errorCode || ''
  };
}

function isPolicyOrModerationFailure(summary) {
  const text = `${summary?.errorCode || ''} ${summary?.error || ''} ${summary?.status || ''}`;
  return /10043300|policy|community|safety|moderation|review|reject|违规|审核|社区|安全/i.test(text);
}

function isRetryableRemoteFailure(summary) {
  if (isPolicyOrModerationFailure(summary)) return false;
  const text = `${summary?.errorCode || ''} ${summary?.error || ''} ${summary?.status || ''}`;
  return /timeout|temporar|internal|service unavailable|busy|overload|try again|network|system error|服务器|超时|繁忙|稍后重试|系统错误/i.test(text);
}

export function remoteFailureRetryDecision(summary, retryCount = 0, retryLimit = 0) {
  const policyOrModeration = isPolicyOrModerationFailure(summary);
  const technicalRetryable = isRetryableRemoteFailure(summary);
  return {
    policyOrModeration,
    technicalRetryable,
    shouldRetry: technicalRetryable && Number(retryCount || 0) < Number(retryLimit || 0)
  };
}

function groupByCookie(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.cookie_profile_id)) groups.set(row.cookie_profile_id, []);
    groups.get(row.cookie_profile_id).push(row);
  }
  return groups;
}

function oldestStartTime(rows) {
  const timestamps = rows
    .map(row => Date.parse(row.submitted_at || row.created_at || ''))
    .filter(Number.isFinite);
  const earliest = timestamps.length ? Math.min(...timestamps) : Date.now();
  return Math.floor((earliest - 24 * 60 * 60 * 1000) / 1000);
}

async function pollGroup(cookieProfileId, rows) {
  const taskIds = rows.map(row => String(row.remote_task_id));
  let summaries;
  try {
    summaries = await pollRemoteTasks(cookieProfileId, taskIds, { startTime: oldestStartTime(rows) });
  } catch (error) {
    for (const row of rows) {
      const errors = Number(row.poll_error_count || 0) + 1;
      const delay = Math.min(300, pollIntervalSeconds() * (2 ** Math.min(errors, 3)));
      updateTaskRecord(row.id, {
        status: 'polling',
        poll_error_count: errors,
        poll_count: Number(row.poll_count || 0) + 1,
        last_polled_at: nowIso(),
        next_poll_at: afterSeconds(delay),
        error_code: error.code || 'POLL_REQUEST_FAILED',
        error_message: String(error.message).slice(0, 2000)
      });
      logEvent({ level: 'error', stage: 'poll_request_failed', entityType: 'task', entityId: row.id, message: error.message, payload: { delaySeconds: delay } });
    }
    return;
  }

  for (const row of rows) {
    const summary = summaries.get(String(row.remote_task_id));
    const base = {
      poll_count: Number(row.poll_count || 0) + 1,
      poll_error_count: 0,
      last_polled_at: nowIso(),
      remote_status: summary.status,
      remote_poll_json: JSON.stringify(compactRemote(summary)),
      error_code: null,
      error_message: null
    };

    if (summary.ready && summary.videoUrls.length) {
      updateTaskRecord(row.id, {
        ...base,
        status: 'video_ready',
        video_url: summary.videoUrls[0],
        video_urls_json: JSON.stringify(summary.videoUrls),
        next_poll_at: null
      });
      logEvent({ stage: 'video_url_found', entityType: 'task', entityId: row.id, message: 'Video URL found', payload: { candidateCount: summary.videoUrls.length } });
      continue;
    }

    if (summary.failed) {
      const retryLimit = Number(row.retry_limit || 0);
      const retryCount = Number(row.retry_count || 0);
      const decision = remoteFailureRetryDecision(summary, retryCount, retryLimit);
      const retryable = decision.shouldRetry;
      const failureCode = summary.errorCode || (decision.policyOrModeration ? 'REMOTE_POLICY_FAILED' : 'REMOTE_GENERATION_FAILED');
      const failureMessage = summary.error || `远端任务失败：${summary.status}`;
      if (retryable) {
        updateTaskRecord(row.id, {
          ...base,
          status: 'queued',
          retry_count: retryCount + 1,
          remote_task_id: null,
          remote_status: null,
          remote_poll_json: null,
          remote_response_json: null,
          video_url: null,
          video_urls_json: '[]',
          submitted_at: null,
          failed_at: null,
          next_poll_at: null,
          error_code: failureCode,
          error_message: `${failureMessage}；已进入自动重提 ${retryCount + 1}/${retryLimit}`
        });
        logEvent({ level: 'warn', stage: 'remote_generation_retry', entityType: 'task', entityId: row.id, message: failureMessage, payload: { retryCount: retryCount + 1, retryLimit, errorCode: failureCode } });
        runWorker().catch(() => {});
      } else {
        updateTaskRecord(row.id, {
          ...base,
          status: 'remote_failed',
          failed_at: nowIso(),
          next_poll_at: null,
          error_code: failureCode,
          error_message: failureMessage
        });
        logEvent({ level: 'error', stage: 'remote_generation_failed', entityType: 'task', entityId: row.id, message: failureMessage, payload: { errorCode: failureCode, policyOrModeration: decision.policyOrModeration, retryable } });
      }
      continue;
    }

    updateTaskRecord(row.id, {
      ...base,
      status: 'polling',
      next_poll_at: afterSeconds(pollIntervalSeconds())
    });
  }
}

async function processPolling() {
  const rows = activePollRows();
  for (const [cookieProfileId, group] of groupByCookie(rows)) {
    await pollGroup(cookieProfileId, group);
  }
}

function upsertResult(task, downloaded) {
  const at = nowIso();
  db.prepare(`INSERT INTO result_assets(id,task_id,video_url,local_path,byte_size,sha256,metadata_json,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(task_id) DO UPDATE SET video_url=excluded.video_url,local_path=excluded.local_path,
      byte_size=excluded.byte_size,sha256=excluded.sha256,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at`)
    .run(
      uid('result'), task.id, downloaded.url, downloaded.localPath, downloaded.byteSize, downloaded.sha256,
      JSON.stringify({ sourceCandidates: jsonParse(task.video_urls_json, []), downloadAttempts: downloaded.attempts }), at, at
    );
}

async function processDownload(task) {
  const attempt = Number(task.download_attempts || 0) + 1;
  updateTaskRecord(task.id, {
    status: 'downloading',
    download_attempts: attempt,
    download_error: null,
    error_code: null,
    error_message: null,
    next_poll_at: null
  });
  try {
    const urls = jsonParse(task.video_urls_json, []).length ? jsonParse(task.video_urls_json, []) : [task.video_url];
    const downloaded = await downloadCandidates({
      urls,
      outputDirectory: task.output_directory,
      filename: task.output_filename,
      preferredPath: task.download_path || ''
    });
    upsertResult(task, downloaded);
    const at = nowIso();
    updateTaskRecord(task.id, {
      status: 'completed',
      video_url: downloaded.url,
      failed_at: null,
      download_path: downloaded.localPath,
      downloaded_at: at,
      completed_at: at,
      result_metadata_json: JSON.stringify({ byteSize: downloaded.byteSize, sha256: downloaded.sha256 }),
      download_error: null,
      next_poll_at: null
    });
    logEvent({ stage: 'video_downloaded', entityType: 'task', entityId: task.id, message: 'Video downloaded', payload: { path: downloaded.localPath, byteSize: downloaded.byteSize } });
    emit('result_created', { taskId: task.id });
  } catch (error) {
    const maxAttempts = downloadRetryLimit();
    const willRetry = attempt <= maxAttempts;
    updateTaskRecord(task.id, {
      status: willRetry ? 'download_retry' : 'download_failed',
      failed_at: willRetry ? null : nowIso(),
      download_error: String(error.message).slice(0, 2000),
      error_code: error.code || 'DOWNLOAD_FAILED',
      error_message: String(error.message).slice(0, 2000),
      next_poll_at: willRetry ? afterSeconds(Math.min(300, 30 * attempt)) : null
    });
    logEvent({ level: 'error', stage: 'video_download_failed', entityType: 'task', entityId: task.id, message: error.message, payload: { attempt, maxAttempts, willRetry, details: error.details || null } });
  }
}

async function processDownloads() {
  for (const task of activeDownloadRows()) await processDownload(task);
}

function recalculateBatches() {
  const batches = db.prepare('SELECT id FROM batches ORDER BY created_at DESC LIMIT 200').all();
  for (const batch of batches) {
    const rows = db.prepare('SELECT status FROM generation_tasks WHERE batch_id=?').all(batch.id);
    if (!rows.length) continue;
    const statuses = rows.map(row => row.status);
    const completed = statuses.filter(status => status === 'completed').length;
    const terminalFailures = statuses.filter(status => ['submit_failed','remote_failed','download_failed'].includes(status)).length;
    const active = statuses.some(status => ['queued','retry_wait','uploading_media','submitting','submitted','polling','video_ready','downloading','download_retry'].includes(status));
    const next = active ? 'processing'
      : completed === rows.length ? 'completed'
        : completed > 0 || terminalFailures > 0 ? 'completed_with_errors'
          : 'failed';
    const current = db.prepare('SELECT status FROM batches WHERE id=?').get(batch.id)?.status;
    if (current !== next) {
      db.prepare('UPDATE batches SET status=?,updated_at=? WHERE id=?').run(next, nowIso(), batch.id);
      emit('batch_updated', { batchId: batch.id });
    }
  }
}

export async function runLifecycleCycle() {
  if (cycleRunning) return { ok: true, skipped: true };
  cycleRunning = true;
  try {
    await processPolling();
    await processDownloads();
    recalculateBatches();
    return { ok: true, skipped: false };
  } finally {
    cycleRunning = false;
  }
}

function scheduleNext() {
  if (stopped) return;
  clearTimeout(timer);
  timer = setTimeout(async () => {
    try { await runLifecycleCycle(); }
    catch (error) { logEvent({ level: 'error', stage: 'lifecycle_cycle_crash', message: error.message }); }
    scheduleNext();
  }, 5000);
  timer.unref?.();
}

export function startLifecycleWorker() {
  stopped = false;
  runLifecycleCycle().catch(error => logEvent({ level: 'error', stage: 'lifecycle_start_failed', message: error.message }));
  scheduleNext();
}

export function stopLifecycleWorker() {
  stopped = true;
  clearTimeout(timer);
  timer = null;
}

export function recoverLifecycleTasks() {
  const at = nowIso();
  db.prepare(`UPDATE generation_tasks SET status='polling',next_poll_at=?,updated_at=?
    WHERE status IN ('submitted','polling') AND remote_task_id IS NOT NULL`).run(at, at);
  db.prepare(`UPDATE generation_tasks SET status='video_ready',next_poll_at=?,updated_at=?
    WHERE status IN ('video_ready','downloading','download_retry') AND video_url IS NOT NULL`).run(at, at);

  const completed = db.prepare(`SELECT id,download_path,video_url FROM generation_tasks WHERE status='completed'`).all();
  for (const task of completed) {
    if (task.download_path && isExistingVideo(task.download_path)) continue;
    updateTaskRecord(task.id, {
      status: 'download_failed',
      error_code: 'LOCAL_RESULT_MISSING',
      error_message: '已完成记录对应的本地视频文件不存在或已损坏。',
      download_error: '本地结果文件不存在或已损坏。'
    });
  }
}

export function requestPollNow(taskId) {
  const task = rowById(taskId);
  if (!task || !task.remote_task_id) throw Object.assign(new Error('该任务没有可轮询的 taskId。'), { statusCode: 422 });
  if (['completed','remote_failed','submit_failed'].includes(task.status)) throw Object.assign(new Error('该任务已处于终态。'), { statusCode: 409 });
  updateTaskRecord(task.id, { status: 'polling', next_poll_at: nowIso(), error_code: null, error_message: null });
  runLifecycleCycle().catch(() => {});
  return { ok: true };
}

export function retryDownload(taskId) {
  const task = rowById(taskId);
  if (!task || !task.video_url) throw Object.assign(new Error('该任务没有可下载的视频链接。'), { statusCode: 422 });
  updateTaskRecord(task.id, {
    status: 'video_ready',
    download_attempts: 0,
    download_error: null,
    error_code: null,
    error_message: null,
    next_poll_at: nowIso()
  });
  runLifecycleCycle().catch(() => {});
  return { ok: true };
}

export function lifecycleStatus() {
  const counts = db.prepare(`SELECT status,COUNT(*) AS count FROM generation_tasks GROUP BY status`).all();
  return { running: !stopped, cycleRunning, counts };
}
