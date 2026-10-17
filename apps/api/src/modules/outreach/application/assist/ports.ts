import type { CallScript } from '@bf/contracts';
import type { OpeningHours } from '../../domain/assist/best-time.ts';

// Ports of the call and WhatsApp assist (BF-057): the read model a call needs (the tracked business, its phone and
// WhatsApp numbers, opening hours, today's call tasks, suggestions) and the script cache.

export interface AssistBusiness {
  readonly id: string;
  readonly name: string;
  readonly tier: string | null;
  readonly categoryPath: string | null;
  readonly doNotContact: boolean;
}

export interface AssistNumber {
  readonly contactId: string;
  readonly type: 'phone' | 'whatsapp';
  readonly e164: string;
  readonly subtype: string;
  readonly source: string;
  readonly sourceUrl: string | null;
}

export interface CallTaskRow {
  readonly taskId: string;
  readonly title: string;
  readonly dueAt: Date | null;
  readonly businessId: string;
}

export interface AssistReader {
  /** The business as the workspace tracks it; undefined when it is not tracked. */
  business(organizationId: string, businessId: string): Promise<AssistBusiness | undefined>;
  businesses(organizationId: string, businessIds: readonly string[]): Promise<AssistBusiness[]>;
  /** Phone and WhatsApp numbers (the workspace's own manual ones included, other workspaces' never). */
  numbers(organizationId: string, businessIds: readonly string[]): Promise<Map<string, AssistNumber[]>>;
  hours(businessIds: readonly string[]): Promise<Map<string, OpeningHours[]>>;
  /** Open call tasks due by `until` for the user (or unassigned). */
  callTasks(organizationId: string, userId: string | null, until: Date): Promise<CallTaskRow[]>;
  /** Tier A/B businesses with a phone, not do-not-contact, without a contact since `since`. */
  suggestions(organizationId: string, since: Date, limit: number): Promise<string[]>;
}
export const ASSIST_READER = Symbol('AssistReader');

export interface CallScriptCache {
  find(key: CallScriptKey): Promise<Omit<CallScript, 'cached'> | undefined>;
  save(key: CallScriptKey, script: Omit<CallScript, 'cached'>): Promise<void>;
}
export interface CallScriptKey {
  readonly organizationId: string;
  readonly businessId: string;
  readonly offer: string;
  readonly locale: 'en' | 'fr';
  readonly factsHash: string;
}
export const CALL_SCRIPT_CACHE = Symbol('CallScriptCache');
