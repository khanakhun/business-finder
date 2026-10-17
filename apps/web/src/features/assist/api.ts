'use client';

import type {
  CallList,
  CallScript,
  CallScriptRequest,
  CallWorkspace,
  LogOutcomeRequest,
  LogOutcomeResult,
  WhatsAppDraft,
  WhatsAppDraftRequest,
} from '@bf/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient, queryKeys } from '@/lib/api.ts';

// Call and WhatsApp assist (BF-057): the call workspace, scripts, WhatsApp drafts, outcomes and the call list.

const unwrap = <T>({ data, error }: { data?: unknown; error?: unknown }): T => {
  if (error || data === undefined) throw error ?? new Error('No data');
  return data as T;
};

export function useCallWorkspace(businessId: string) {
  return useQuery({
    queryKey: queryKeys.assist.workspace(businessId),
    queryFn: async () =>
      unwrap<CallWorkspace>(
        await apiClient().GET('/v1/outreach/assist/businesses/{businessId}', {
          params: { path: { businessId } },
        }),
      ),
  });
}

const fetchScript = async (businessId: string, body: CallScriptRequest) =>
  unwrap<CallScript>(
    await apiClient().POST('/v1/outreach/assist/businesses/{businessId}/script', {
      params: { path: { businessId } },
      body: body as never,
    }),
  );

// The last script per business is also kept in this browser so the call list can be read offline.
const LOCAL = 'bf-call-script:';

const readLocal = (key: readonly unknown[]): CallScript | undefined => {
  try {
    const raw = window.localStorage.getItem(LOCAL + JSON.stringify(key));
    return raw ? (JSON.parse(raw) as CallScript) : undefined;
  } catch {
    return undefined;
  }
};

const writeLocal = (key: readonly unknown[], script: CallScript) => {
  try {
    window.localStorage.setItem(LOCAL + JSON.stringify(key), JSON.stringify(script));
  } catch {
    // Storage full or refused: the script is only kept in memory.
  }
};

/** The cached script (generated on first open); `regenerate` writes a new one in its place. */
export function useCallScript(
  businessId: string,
  offer: string,
  locale: 'en' | 'fr' | 'auto',
  enabled: boolean,
) {
  const client = useQueryClient();
  const key = queryKeys.assist.script(businessId, offer, locale);
  const body = { offer: offer as never, ...(locale !== 'auto' ? { locale } : {}) };
  const query = useQuery({
    queryKey: key,
    queryFn: async () => {
      const script = await fetchScript(businessId, body);
      writeLocal(key, script);
      return script;
    },
    initialData: () => (typeof window === 'undefined' ? undefined : readLocal(key)),
    // A kept script shows at once and is refreshed when online.
    initialDataUpdatedAt: 0,
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const regenerate = useMutation({
    mutationFn: () => fetchScript(businessId, { ...body, regenerate: true }),
    onSuccess: (script) => {
      writeLocal(key, script);
      client.setQueryData(key, script);
    },
  });
  return { query, regenerate };
}

export function useWhatsAppDraft(businessId: string) {
  return useMutation({
    mutationFn: async (body: WhatsAppDraftRequest) =>
      unwrap<WhatsAppDraft>(
        await apiClient().POST('/v1/outreach/assist/businesses/{businessId}/whatsapp', {
          params: { path: { businessId } },
          body: body as never,
        }),
      ),
  });
}

export async function postOutcome(businessId: string, body: LogOutcomeRequest): Promise<LogOutcomeResult> {
  return unwrap<LogOutcomeResult>(
    await apiClient().POST('/v1/outreach/assist/businesses/{businessId}/outcomes', {
      params: { path: { businessId } },
      body: body as never,
    }),
  );
}

export function useCallList() {
  return useQuery({
    queryKey: queryKeys.assist.calls(),
    queryFn: async () => unwrap<CallList>(await apiClient().GET('/v1/outreach/assist/calls')),
    refetchInterval: 5 * 60_000,
  });
}

/** Refreshes what an outcome changes: the call views, the CRM (pipeline, tasks), the business and its history. */
export function useOutcomeSettled() {
  const client = useQueryClient();
  return (businessId?: string) => {
    void client.invalidateQueries({ queryKey: ['assist'] });
    void client.invalidateQueries({ queryKey: ['crm'] });
    if (businessId) {
      void client.invalidateQueries({ queryKey: ['business', businessId] });
      void client.invalidateQueries({ queryKey: queryKeys.outreach.history(businessId) });
    }
  };
}
