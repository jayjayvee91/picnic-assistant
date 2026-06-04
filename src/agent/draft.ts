/**
 * Draft cart helpers.
 *
 * In the **hybrid (b′)** commit mode agreed during grilling, the weekly-draft
 * conversation builds an internal list of items (the "draft") and only writes
 * to Picnic when the user explicitly approves. Ad-hoc adds skip the draft and
 * go straight to Picnic. This file is the draft side of that split — see
 * `tools.ts` for how the agent uses it.
 *
 * Storage is the SQLite `draft_cart` table from Step 3 — drafts survive bot
 * restarts (which matters when a Thursday-night conversation outlives a
 * deploy).
 */

import {
  upsertDraftCart,
  getDraftCart,
  clearDraftCart,
  type DB,
  type DraftCart,
} from '../memory/index.js';

export interface DraftItem {
  articleId: string;
  articleName: string;
  quantity: number;
}

/**
 * Load the current draft for a conversation. Returns an empty list if no
 * draft exists yet — callers don't need to special-case "first add."
 */
export function loadDraft(db: DB, conversationKey: string): DraftItem[] {
  const stored = getDraftCart(db, conversationKey);
  return stored?.items ?? [];
}

/**
 * Add an article to the draft. If the article is already present, its
 * quantity is incremented by `quantityToAdd` (defaults to 1).
 */
export function addToDraft(
  db: DB,
  conversationKey: string,
  articleId: string,
  articleName: string,
  quantityToAdd = 1,
): DraftItem[] {
  const items = loadDraft(db, conversationKey);
  const existing = items.find((i) => i.articleId === articleId);
  if (existing) {
    existing.quantity += quantityToAdd;
  } else {
    items.push({ articleId, articleName, quantity: quantityToAdd });
  }
  upsertDraftCart(db, conversationKey, items);
  return items;
}

/**
 * Remove (or decrement) an article from the draft. If the resulting quantity
 * is zero or negative, the article is removed entirely.
 */
export function removeFromDraft(
  db: DB,
  conversationKey: string,
  articleId: string,
  quantityToRemove?: number,
): DraftItem[] {
  const items = loadDraft(db, conversationKey);
  const idx = items.findIndex((i) => i.articleId === articleId);
  if (idx === -1) return items;

  if (quantityToRemove === undefined) {
    items.splice(idx, 1);
  } else {
    const item = items[idx];
    if (item) {
      item.quantity -= quantityToRemove;
      if (item.quantity <= 0) items.splice(idx, 1);
    }
  }
  upsertDraftCart(db, conversationKey, items);
  return items;
}

/** Wipe the draft for a conversation. Used after a successful commit. */
export function emptyDraft(db: DB, conversationKey: string): void {
  clearDraftCart(db, conversationKey);
}

/** Convenience: load the full DraftCart record (including `updatedAt`). */
export function loadDraftRecord(db: DB, conversationKey: string): DraftCart | null {
  return getDraftCart(db, conversationKey);
}
