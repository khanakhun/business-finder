'use client';

import {
  type AddSiteDomainRequest,
  AddSiteDomainRequestSchema,
  type ChangeRequest,
  type GoLiveReadiness,
  type InvitePortalClientRequest,
  InvitePortalClientRequestSchema,
  type PortalGrant,
  type PublishLiveResult,
  type RequestApproval,
  RequestApprovalSchema,
  type SaveSiteLegalProfileRequest,
  SaveSiteLegalProfileRequestSchema,
  type SetContactRoutingRequest,
  SetContactRoutingRequestSchema,
  type SiteApproval,
  type SiteContactRouting,
  type SiteDomain,
  type SiteLegalProfile,
} from '@bf/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient, queryKeys } from '@/lib/api.ts';

// Going live (BF-062): the readiness checks, the legal profile, the contact routing address, the custom domains and
// the live publication. Every change re-reads the readiness (it depends on all of them).

const unwrap = <T>({ data, error }: { data?: unknown; error?: unknown }): T => {
  if (error || data === undefined) throw error ?? new Error('No data');
  return data as T;
};

export function useReadiness(siteId: string) {
  return useQuery({
    queryKey: queryKeys.goLive.readiness(siteId),
    queryFn: async () =>
      unwrap<GoLiveReadiness>(
        await apiClient().GET('/v1/sites/{id}/go-live/readiness', { params: { path: { id: siteId } } }),
      ),
  });
}

export function useLegalProfile(siteId: string) {
  return useQuery({
    queryKey: queryKeys.goLive.legal(siteId),
    queryFn: async () =>
      unwrap<{ profile: SiteLegalProfile | null }>(
        await apiClient().GET('/v1/sites/{id}/legal-profile', { params: { path: { id: siteId } } }),
      ).profile,
  });
}

export function useContactRouting(siteId: string) {
  return useQuery({
    queryKey: queryKeys.goLive.routing(siteId),
    queryFn: async () =>
      unwrap<SiteContactRouting>(
        await apiClient().GET('/v1/sites/{id}/contact-routing', { params: { path: { id: siteId } } }),
      ),
  });
}

export function useDomains(siteId: string) {
  return useQuery({
    queryKey: queryKeys.goLive.domains(siteId),
    queryFn: async () =>
      unwrap<{ items: SiteDomain[] }>(
        await apiClient().GET('/v1/sites/{id}/domains', { params: { path: { id: siteId } } }),
      ).items,
  });
}

export function useGoLiveActions(siteId: string) {
  const client = useQueryClient();
  const settle = () => void client.invalidateQueries({ queryKey: ['goLive'] });
  const path = { path: { id: siteId } };
  return {
    saveLegal: useMutation({
      mutationFn: async (body: SaveSiteLegalProfileRequest) =>
        unwrap<SiteLegalProfile>(
          await apiClient().PUT('/v1/sites/{id}/legal-profile', {
            params: path,
            body: SaveSiteLegalProfileRequestSchema.parse(body),
          }),
        ),
      onSuccess: settle,
    }),
    setRouting: useMutation({
      mutationFn: async (body: SetContactRoutingRequest) =>
        unwrap<SiteContactRouting>(
          await apiClient().PUT('/v1/sites/{id}/contact-routing', {
            params: path,
            body: SetContactRoutingRequestSchema.parse(body),
          }),
        ),
      onSuccess: settle,
    }),
    addDomain: useMutation({
      mutationFn: async (body: AddSiteDomainRequest) =>
        unwrap<{ items: SiteDomain[] }>(
          await apiClient().POST('/v1/sites/{id}/domains', {
            params: path,
            body: AddSiteDomainRequestSchema.parse(body),
          }),
        ),
      onSuccess: settle,
    }),
    checkDomain: useMutation({
      mutationFn: async (domainId: string) =>
        unwrap<SiteDomain>(
          await apiClient().POST('/v1/sites/{id}/domains/{domainId}/check', {
            params: { path: { id: siteId, domainId } },
          }),
        ),
      onSuccess: settle,
    }),
    removeDomain: useMutation({
      mutationFn: async (domainId: string) => {
        const { error } = await apiClient().DELETE('/v1/sites/{id}/domains/{domainId}', {
          params: { path: { id: siteId, domainId } },
        });
        if (error) throw error;
      },
      onSuccess: settle,
    }),
    publishLive: useMutation({
      mutationFn: async (body: { versionId: string; overrideReason?: string }) =>
        unwrap<PublishLiveResult>(await apiClient().POST('/v1/sites/{id}/go-live', { params: path, body })),
      onSuccess: settle,
    }),
  };
}

/** The contact routing confirmation link's landing: the emailed token is the proof (no session). */
export async function confirmContactRouting(token: string): Promise<boolean> {
  return unwrap<{ confirmed: boolean }>(
    await apiClient().POST('/v1/public/sites/contact-routing/confirm', { body: { token } }),
  ).confirmed;
}

// ── Handover: the client portal (BF-062) ─────────────────────────────────────────────────────────────────────────

export function usePortalGrants(siteId: string) {
  return useQuery({
    queryKey: queryKeys.goLive.grants(siteId),
    queryFn: async () =>
      unwrap<{ items: PortalGrant[] }>(
        await apiClient().GET('/v1/sites/{id}/portal/grants', { params: { path: { id: siteId } } }),
      ).items,
  });
}

export function useSiteApprovals(siteId: string) {
  return useQuery({
    queryKey: queryKeys.goLive.approvals(siteId),
    queryFn: async () =>
      unwrap<{ items: SiteApproval[] }>(
        await apiClient().GET('/v1/sites/{id}/portal/approvals', { params: { path: { id: siteId } } }),
      ).items,
  });
}

export function useSiteChangeRequests(siteId: string) {
  return useQuery({
    queryKey: queryKeys.goLive.changeRequests(siteId),
    queryFn: async () =>
      unwrap<{ items: ChangeRequest[] }>(
        await apiClient().GET('/v1/sites/{id}/portal/change-requests', { params: { path: { id: siteId } } }),
      ).items,
  });
}

export function useHandoverActions(siteId: string) {
  const client = useQueryClient();
  const settle = () => void client.invalidateQueries({ queryKey: ['goLive'] });
  const path = { path: { id: siteId } };
  return {
    invite: useMutation({
      mutationFn: async (body: InvitePortalClientRequest) =>
        unwrap<{ items: PortalGrant[] }>(
          await apiClient().POST('/v1/sites/{id}/portal/grants', {
            params: path,
            body: InvitePortalClientRequestSchema.parse(body),
          }),
        ),
      onSuccess: settle,
    }),
    revoke: useMutation({
      mutationFn: async (grantId: string) => {
        const { error } = await apiClient().DELETE('/v1/sites/{id}/portal/grants/{grantId}', {
          params: { path: { id: siteId, grantId } },
        });
        if (error) throw error;
      },
      onSuccess: settle,
    }),
    requestApproval: useMutation({
      mutationFn: async (body: RequestApproval) =>
        unwrap<{ items: SiteApproval[] }>(
          await apiClient().POST('/v1/sites/{id}/portal/approvals', {
            params: path,
            body: RequestApprovalSchema.parse(body),
          }),
        ),
      onSuccess: settle,
    }),
  };
}
