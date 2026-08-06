const cron = require('node-cron');
const ScannerService = require('./scanner.service');

/**
 * Wakes the scanner on a schedule.
 *
 * Deliberately runs at 04:00 rather than midnight: fares posted overnight have
 * settled, and it keeps the daily provider spend away from the hours when real
 * users are triggering on-demand searches (which warm the same cache).
 *
 * A single overlap guard is enough because this is one process. If the API is
 * ever scaled to multiple instances, this must become a Postgres advisory lock
 * or every instance will scan the same searches.
 */

const SCHEDULE = process.env.SCAN_CRON || '0 4 * * *';

let task = null;
let running = false;

function start(scanner = new ScannerService()) {
  if (process.env.DISABLE_SCHEDULER === 'true') {
    console.log('[scheduler] disabled via DISABLE_SCHEDULER');
    return null;
  }
  if (task) return task;

  task = cron.schedule(SCHEDULE, async () => {
    if (running) {
      console.warn('[scheduler] previous run still in progress, skipping');
      return;
    }
    running = true;
    try {
      console.log('[scheduler] starting scheduled scan');
      await scanner.runDueScans();
    } catch (err) {
      console.error('[scheduler] run failed:', err.message);
    } finally {
      running = false;
    }
  });

  console.log(`[scheduler] scheduled with "${SCHEDULE}"`);
  return task;
}

function stop() {
  if (task) {
    task.stop();
    task = null;
  }
}

module.exports = { start, stop };
