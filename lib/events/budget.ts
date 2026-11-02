// One accepted event's request budget; duplicates never restart these clocks.
export const DELIVERY_MS = 20_000;
export const NOTICE_MS = 5_000;
export const MAX_ATTEMPTS = 3;
export const CALLBACK_MS = 4_000;
export const SLACK_CALL_MS = 2_000;
export const MIN_ATTEMPT_MS = 250;

export function retryDelay(value: string | null, now: number): number {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}
