/**
 * In-memory job store for async export/scan tasks.
 * Each job has: id, status, progress, result, errors, abort controller.
 */

import crypto from "crypto";

const jobs = new Map();

/** @returns {string} new jobId */
export function createJob(type) {
  const id = crypto.randomUUID();
  jobs.set(id, {
    id,
    type,
    status: "pending",   // pending | running | done | cancelled | error
    progress: 0,
    total: 0,
    message: "",
    result: null,
    errors: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    _sseListeners: new Set(),
    _abortController: new AbortController(),
  });
  return id;
}

export function getJob(id) {
  return jobs.get(id) || null;
}

export function updateJob(id, patch) {
  const job = jobs.get(id);
  if (!job) return;
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  // Broadcast SSE event to all listeners
  const event = {
    type: "progress",
    job_id: id,
    status: job.status,
    progress: job.progress,
    total: job.total,
    message: job.message,
  };
  for (const send of job._sseListeners) {
    try { send(event); } catch { /* ignore closed connections */ }
  }
}

export function finishJob(id, result) {
  updateJob(id, { status: "done", progress: 100, result });
  const job = jobs.get(id);
  if (job) {
    const event = { type: "done", job_id: id, result };
    for (const send of job._sseListeners) {
      try { send(event); } catch { /* ignore closed connections */ }
    }
    job._sseListeners.clear();
  }
}

export function failJob(id, error) {
  const msg = error?.message || String(error);
  updateJob(id, { status: "error", message: msg, errors: [msg] });
}

export function cancelJob(id) {
  const job = jobs.get(id);
  if (!job) return false;
  job._abortController.abort();
  updateJob(id, { status: "cancelled" });
  return true;
}

export function addSseListener(id, sendFn) {
  const job = jobs.get(id);
  if (!job) return false;
  job._sseListeners.add(sendFn);
  return true;
}

export function removeSseListener(id, sendFn) {
  jobs.get(id)?._sseListeners.delete(sendFn);
}

export function getAbortSignal(id) {
  return jobs.get(id)?._abortController.signal;
}

/** Prune completed jobs older than 1 hour */
export function pruneJobs() {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, job] of jobs) {
    if (["done", "error", "cancelled"].includes(job.status)) {
      if (new Date(job.updatedAt).getTime() < cutoff) jobs.delete(id);
    }
  }
}
// Auto-prune every 15 minutes
setInterval(pruneJobs, 15 * 60 * 1000).unref();
