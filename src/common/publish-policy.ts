import { Channel } from './enums';

export interface PublishPolicyParams {
  channel: Channel;
  sku: string;
  available: number;
  velocityPerMin: number;
  buffer?: number;
  cap?: number;
  floor?: number;
}

/**
 * Standard blind window constants (W_c in seconds):
 * - Website: 0 s (instant direct sync)
 * - Nykaa: ~60 s (5 req/s queue drain delay)
 * - Blinkit: ~90 s (timeout retries)
 * - Flipkart: ~180 s (120 s polling interval + processing/push lag)
 */
export const DEFAULT_BLIND_WINDOWS: Record<Channel, number> = {
  [Channel.WEBSITE]: 0,
  [Channel.NYKAA]: 60,
  [Channel.BLINKIT]: 90,
  [Channel.FLIPKART]: 180,
};

export const DEFAULT_FLOORS: Record<Channel, number> = {
  [Channel.WEBSITE]: 0,
  [Channel.NYKAA]: 2,
  [Channel.BLINKIT]: 3,
  [Channel.FLIPKART]: 5,
};

/**
 * Velocity-Based Publish Policy
 * Prevents overselling on asynchronous / polling channels by calculating
 * the threshold below which slow channels cease advertising inventory.
 *
 * velocity(sku)     = max(units reserved in last 15 min / 15, planned sale velocity)
 * threshold(c, sku) = max(floor_c, ceil(velocity * W_c * 1.5))
 * publish(c, sku)   = available <= threshold ? 0 : min(available - buffer_c, cap_c)
 */
export function calculatePublishableStock(params: PublishPolicyParams): number {
  const {
    channel,
    available,
    velocityPerMin,
    buffer = 0,
    cap = null,
    floor = DEFAULT_FLOORS[channel] ?? 0,
  } = params;

  if (available <= 0) {
    return 0;
  }

  // Velocity converted to units per second
  const velocityPerSec = Math.max(0, velocityPerMin) / 60;
  const blindWindowSec = DEFAULT_BLIND_WINDOWS[channel] ?? 60;

  // Threshold: how much stock could be sold across all channels during the blind window
  const rawThreshold = Math.ceil(velocityPerSec * blindWindowSec * 1.5);
  const threshold = Math.max(floor, rawThreshold);

  if (available <= threshold) {
    return 0; // Cut off slow channels to let fast channels/website safely sell tail units
  }

  const effectiveStock = available - buffer;
  if (effectiveStock <= 0) {
    return 0;
  }

  return cap !== null && cap !== undefined ? Math.min(effectiveStock, cap) : effectiveStock;
}
