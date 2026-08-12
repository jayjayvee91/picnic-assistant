/**
 * Public surface of the scheduler.
 *
 * Two scheduled jobs today: the Thursday-20:00 weekly nudge, and the daily
 * incremental order-history sync. Both run inside the bot's own process.
 */

export {
  startWeeklyNudge,
  fireWeeklyNudge,
  WEEKLY_NUDGE_PATTERN,
  WEEKLY_NUDGE_TIMEZONE,
  type WeeklyNudgeOptions,
} from './cron.js';
export { buildWeeklyNudge, formatRelativeDays } from './nudge.js';
export {
  startOrderSync,
  fireOrderSync,
  ORDER_SYNC_PATTERN,
  ORDER_SYNC_TIMEZONE,
  type OrderSyncOptions,
  type OrderSyncHandle,
} from './order-sync.js';
