/**
 * Public surface of the memory layer. Higher layers import only from here.
 */

export { openDatabase, type DB } from './db.js';
export {
  recordOrder,
  getRecentOrders,
  searchOrderHistory,
  logSuggestion,
  getLatestSuggestion,
  upsertDraftCart,
  getDraftCart,
  clearDraftCart,
  recordApiSpend,
  getTodayApiSpend,
  getMeta,
  setMeta,
  appendChatTurn,
  type OrderRecord,
  type OrderItemRecord,
  type OrderHistorySearchHit,
  type SuggestionLogRecord,
  type DraftCart,
  type ChatTurnInput,
} from './repository.js';
export {
  recomputeAndStoreSummary,
  loadStoredSummary,
  type PurchaseSummary,
  type TypicalBasketEntry,
} from './summary.js';
export { runBootstrap, type BootstrapOptions, type BootstrapResult } from './bootstrap.js';
export { backupDatabase, type BackupOptions, type BackupResult } from './backup.js';
