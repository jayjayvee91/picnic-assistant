/**
 * Public surface of the scheduler.
 *
 * For v1 there's exactly one scheduled job — the Thursday-20:00 weekly nudge.
 * Future jobs (incremental order-history sync, diff observation polling, etc.)
 * would land alongside, but we keep the surface minimal until they exist.
 */

export {
  startWeeklyNudge,
  fireWeeklyNudge,
  WEEKLY_NUDGE_PATTERN,
  WEEKLY_NUDGE_TIMEZONE,
  type WeeklyNudgeOptions,
} from './cron.js';
export { buildWeeklyNudge, formatRelativeDays } from './nudge.js';
