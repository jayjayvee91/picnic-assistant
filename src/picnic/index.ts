/**
 * Public surface of the Picnic adapter.
 *
 * Downstream code (memory, agent, Telegram) imports from here and from here
 * only — never from `./client` directly, and never from `picnic-api`. This
 * keeps the surface small and a future wrapper swap to a single-file change.
 */

export { PicnicClient } from './client.js';
export type {
  Cart,
  Delivery,
  DeliveryDetail,
  FusionPage,
  GetDeliverySlotsResult,
  PicnicClientOptions,
  PicnicCountryCode,
  SellingUnit,
} from './client.js';
export { AuthRequiredError, PicnicCallError, TwoFactorRequiredError } from './errors.js';
