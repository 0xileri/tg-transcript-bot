// Bounded, fair job scheduler.
//
// Extracted from the poll loop so the concurrency rules can be tested directly:
// importing bot.js starts a real bot, which makes the logic there unreachable from
// a test. This module has no Telegram or yt-dlp knowledge at all.

export function createScheduler({ maxConcurrent = 3, maxPerUser = 2 } = {}) {
  const pending = [];         // FIFO of { chatId, run }
  const inFlight = new Map(); // chatId -> running job count
  let active = 0;

  const queuedFor = (id) => pending.reduce((n, j) => n + (j.chatId === id ? 1 : 0), 0);

  /** Queued plus running: a cap on outstanding work, not on links sent over time. */
  const outstandingFor = (id) => queuedFor(id) + (inFlight.get(id) ?? 0);

  /**
   * Start whatever can start.
   *
   * Prefers the first queued job belonging to somebody with nothing already running,
   * so one person pasting ten links cannot hold every slot while others wait behind
   * them. Falls back to plain FIFO once everyone waiting already has a job in flight.
   */
  function pump() {
    while (active < maxConcurrent && pending.length) {
      let idx = pending.findIndex((j) => !inFlight.has(j.chatId));
      if (idx === -1) idx = 0;

      const [job] = pending.splice(idx, 1);
      job.started = true;
      active++;
      inFlight.set(job.chatId, (inFlight.get(job.chatId) ?? 0) + 1);

      Promise.resolve()
        .then(job.run)
        .catch((e) => console.error(`[${job.chatId}] job failed: ${e?.message ?? e}`))
        .finally(() => {
          active--;
          const left = (inFlight.get(job.chatId) ?? 1) - 1;
          if (left > 0) inFlight.set(job.chatId, left);
          else inFlight.delete(job.chatId);
          pump();
        });
    }
  }

  return {
    /**
     * Queue a job. Returns true if it began immediately.
     *
     * pump() can dequeue synchronously, so the caller cannot predict this beforehand:
     * deciding from isBusy() alone told users "queued" for jobs that had already
     * started. Reporting it from here is the only account that matches reality.
     */
    submit(chatId, run) {
      const job = { chatId, run, started: false };
      pending.push(job);
      pump();
      return job.started;
    },
    outstandingFor,
    hasRunning: (id) => inFlight.has(id),
    isBusy: () => active >= maxConcurrent,
    get active() { return active; },
    get waiting() { return pending.length; },
    maxConcurrent,
    maxPerUser,
  };
}
