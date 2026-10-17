import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';

/** A string tagged with a brand, so a `BusinessId` cannot be passed where a `SiteId` is expected. */
export type Id<B extends string> = string & z.$brand<B>;

/** Schema for a branded UUID id. Accepts any RFC 9562 UUID (ids minted elsewhere may not be v7). */
export function idSchema<B extends string>(brand: B) {
  // `.brand()` is type-only and must come last: methods called after it return the unbranded type.
  return z.uuid().describe(`${brand} (UUID)`).brand<B>();
}

/**
 * New RFC 9562 UUIDv7: time-ordered, and monotonic within a millisecond (the library keeps a sequence counter),
 * so ids sort by creation. Uses `crypto.getRandomValues` — works in Node, browsers and edge runtimes.
 */
export function newId<B extends string = string>(): Id<B> {
  // Safe: a freshly generated UUID satisfies every id brand; the brand only exists at compile time.
  return uuidv7() as Id<B>;
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuidV7(value: string): boolean {
  return UUID_V7.test(value);
}

export const OrgId = idSchema('OrgId');
export type OrgId = Id<'OrgId'>;
export const UserId = idSchema('UserId');
export type UserId = Id<'UserId'>;
export const BusinessId = idSchema('BusinessId');
export type BusinessId = Id<'BusinessId'>;
export const SiteId = idSchema('SiteId');
export type SiteId = Id<'SiteId'>;
export const EventId = idSchema('EventId');
export type EventId = Id<'EventId'>;

/**
 * A persisted compliance decision (BF-049). Branded: the outbound message constructor (BF-052) requires one, so a
 * message cannot be queued without the gate having decided.
 */
export const ComplianceDecisionId = idSchema('ComplianceDecisionId');
export type ComplianceDecisionId = Id<'ComplianceDecisionId'>;
