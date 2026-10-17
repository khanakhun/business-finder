'use client';

import {
  type ChangeRequest,
  type CreateChangeRequest,
  CreateChangeRequestSchema,
  type DecideApproval,
  DecideApprovalSchema,
  type PortalAttachmentUpload,
  type PortalLead,
  type PortalSite,
  type PortalStats,
  type SiteApproval,
} from '@bf/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient, queryKeys } from '@/lib/api.ts';

// The client portal (BF-062): a business owner's sites, their stats and leads, change requests and approvals.

const unwrap = <T>({ data, error }: { data?: unknown; error?: unknown }): T => {
  if (error || data === undefined) throw error ?? new Error('No data');
  return data as T;
};

export function usePortalSites() {
  return useQuery({
    queryKey: queryKeys.portal.sites(),
    queryFn: async () => unwrap<{ items: PortalSite[] }>(await apiClient().GET('/v1/portal/sites')).items,
  });
}

const site = (siteId: string) => ({ params: { path: { siteId } } });

export function usePortalSite(siteId: string) {
  return useQuery({
    queryKey: queryKeys.portal.site(siteId),
    queryFn: async () => unwrap<PortalSite>(await apiClient().GET('/v1/portal/sites/{siteId}', site(siteId))),
  });
}

export function usePortalStats(siteId: string) {
  return useQuery({
    queryKey: queryKeys.portal.stats(siteId),
    queryFn: async () =>
      unwrap<PortalStats>(await apiClient().GET('/v1/portal/sites/{siteId}/stats', site(siteId))),
  });
}

export function usePortalLeads(siteId: string) {
  return useQuery({
    queryKey: queryKeys.portal.leads(siteId),
    queryFn: async () =>
      unwrap<{ items: PortalLead[] }>(await apiClient().GET('/v1/portal/sites/{siteId}/leads', site(siteId)))
        .items,
  });
}

export function usePortalChangeRequests(siteId: string) {
  return useQuery({
    queryKey: queryKeys.portal.changeRequests(siteId),
    queryFn: async () =>
      unwrap<{ items: ChangeRequest[] }>(
        await apiClient().GET('/v1/portal/sites/{siteId}/change-requests', site(siteId)),
      ).items,
  });
}

export function usePortalApprovals(siteId: string) {
  return useQuery({
    queryKey: queryKeys.portal.approvals(siteId),
    queryFn: async () =>
      unwrap<{ items: SiteApproval[] }>(
        await apiClient().GET('/v1/portal/sites/{siteId}/approvals', site(siteId)),
      ).items,
  });
}

/** Uploads a screenshot straight to storage (presigned PUT); returns its id for the change request. */
async function uploadScreenshot(siteId: string, file: File): Promise<string> {
  const upload = unwrap<PortalAttachmentUpload>(
    await apiClient().POST('/v1/portal/sites/{siteId}/attachments', {
      ...site(siteId),
      body: { contentType: file.type as 'image/png' | 'image/jpeg' | 'image/webp', bytes: file.size },
    }),
  );
  const response = await fetch(upload.uploadUrl, { method: 'PUT', headers: upload.headers, body: file });
  if (!response.ok) throw new Error(`Upload failed (${response.status})`);
  return upload.id;
}

export function usePortalActions(siteId: string) {
  const client = useQueryClient();
  const settle = () => void client.invalidateQueries({ queryKey: ['portal'] });
  return {
    changeRequest: useMutation({
      mutationFn: async ({ request, files }: { request: CreateChangeRequest; files: readonly File[] }) => {
        const attachmentIds: string[] = [];
        for (const file of files) attachmentIds.push(await uploadScreenshot(siteId, file));
        return unwrap<ChangeRequest>(
          await apiClient().POST('/v1/portal/sites/{siteId}/change-requests', {
            ...site(siteId),
            body: CreateChangeRequestSchema.parse({ ...request, attachmentIds }),
          }),
        );
      },
      onSuccess: settle,
    }),
    decide: useMutation({
      mutationFn: async ({ approvalId, decision }: { approvalId: string; decision: DecideApproval }) =>
        unwrap<SiteApproval>(
          await apiClient().POST('/v1/portal/sites/{siteId}/approvals/{approvalId}/decision', {
            params: { path: { siteId, approvalId } },
            body: DecideApprovalSchema.parse(decision),
          }),
        ),
      onSuccess: settle,
    }),
  };
}
