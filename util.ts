// Small shared helpers: the trial's fixed now, deterministic request ids, and JSON plumbing.
// Nothing here reads the wall clock or Math.random: every value a response carries derives from
// MAKEFUN_TRIAL_NOW / MAKEFUN_TRIAL_SEED or from a counter, so a replay answers byte-identically.

/** The scenario's day one, 2025-01-01T00:00:00Z: the fallback when MAKEFUN_TRIAL_NOW is unset. */
export const FALLBACK_NOW_MS = 1_735_689_600_000;

/** MAKEFUN_TRIAL_NOW as epoch milliseconds (an RFC 3339 instant, or epoch ms/seconds). */
export function trialNowMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.MAKEFUN_TRIAL_NOW ?? '').trim();
  if (raw === '') return FALLBACK_NOW_MS;
  if (/^\d+$/.test(raw)) {
    const value = Number(raw);
    if (Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
    return FALLBACK_NOW_MS;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : FALLBACK_NOW_MS;
}

/** MAKEFUN_TRIAL_NOW as epoch seconds. */
export function trialNowSec(env: NodeJS.ProcessEnv = process.env): number {
  return Math.floor(trialNowMs(env) / 1000);
}

/** An ISO-8601 timestamp from epoch milliseconds. */
export function isoOf(ms: number): string {
  return new Date(ms).toISOString();
}

let requestCounter = 0;

/**
 * A deterministic request id: `req-` plus a zero-padded counter. No randomness, so two runs that
 * serve the same requests in the same order hand out the same ids.
 */
export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(16).padStart(12, '0')}`;
}

/** True for a lowercase 40-hex object id. */
export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** The all-zero object id: an unborn branch's old/new value. */
export const ZERO_OID = '0'.repeat(40);

/** Base64url-encode a string (no padding): the opaque part of a GraphQL global id. */
export function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

/** Decode a base64url string, or null when it is not one. */
export function unb64url(text: string): string | null {
  try {
    const decoded = Buffer.from(text, 'base64url').toString('utf8');
    return decoded === '' ? null : decoded;
  } catch {
    return null;
  }
}

/** A JSON value, for request bodies and responses. */
export type Json = Record<string, unknown>;

/** Read a record's string field, or '' when it is absent or not a string. */
export function str(value: unknown, field: string): string {
  if (typeof value !== 'object' || value === null) return '';
  const found = (value as Record<string, unknown>)[field];
  return typeof found === 'string' ? found : '';
}

/** Read a record's boolean field, or the fallback when it is absent or not a boolean. */
export function bool(value: unknown, field: string, fallback: boolean): boolean {
  if (typeof value !== 'object' || value === null) return fallback;
  const found = (value as Record<string, unknown>)[field];
  return typeof found === 'boolean' ? found : fallback;
}

/** Read a record's integer field, or the fallback when it is absent or not an integer. */
export function int(value: unknown, field: string, fallback: number): number {
  if (typeof value !== 'object' || value === null) return fallback;
  const found = (value as Record<string, unknown>)[field];
  return typeof found === 'number' && Number.isInteger(found) ? found : fallback;
}

/** Clamp a pagination value into [min, max], falling back when it is not a finite number. */
export function clampPage(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}
