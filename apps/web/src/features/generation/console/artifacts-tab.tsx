'use client';

import { toApiError } from '@bf/api-client';
import type { GenerationArtifact } from '@bf/contracts';
import { Button } from '@bf/ui/components/button';
import { Skeleton } from '@bf/ui/components/skeleton';
import { DownloadIcon } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { publicEnv } from '@/lib/public-env.ts';
import { getToast } from '@/lib/toast.tsx';
import { useJobArtifacts } from '../api.ts';

// The Artifacts tab (BF-046, `sites:admin`): the job's stored files — workspace bundles, site specs, screenshots,
// transcripts — with their attempt, size and hash, each downloadable (fetched with the session cookie).

async function download(jobId: string, artifact: GenerationArtifact) {
  const response = await fetch(`${publicEnv().apiUrl}/v1/generation-jobs/${jobId}/artifacts/${artifact.id}`, {
    credentials: 'include',
  });
  if (!response.ok) throw toApiError(response.status, await response.json().catch(() => null));
  const name = /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') ?? '')?.[1];
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = name ?? `${artifact.kind}-${artifact.id}`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function ArtifactsTab({ jobId }: { readonly jobId: string }) {
  const t = useTranslations('generation.console.artifacts');
  const format = useFormatter();
  const artifacts = useJobArtifacts(jobId, true);
  if (artifacts.isLoading) return <Skeleton className="h-32 w-full" />;
  if (artifacts.isError) return <p className="text-sm text-destructive">{t('error')}</p>;
  const items = artifacts.data?.items ?? [];
  if (items.length === 0) return <p className="text-sm text-muted-foreground">{t('none')}</p>;
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-left text-sm">
        <thead className="bg-muted/50 text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-normal">{t('kind')}</th>
            <th className="px-3 py-2 font-normal">{t('attempt')}</th>
            <th className="px-3 py-2 font-normal">{t('size')}</th>
            <th className="px-3 py-2 font-normal">{t('hash')}</th>
            <th className="px-3 py-2 font-normal">{t('created')}</th>
            <th className="px-3 py-2 font-normal">
              <span className="sr-only">{t('download')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((artifact) => (
            <tr key={artifact.id} className="border-t">
              <td className="px-3 py-1.5">{t(`kinds.${artifact.kind}`)}</td>
              <td className="px-3 py-1.5 tabular-nums">{artifact.attemptNo ?? '—'}</td>
              <td className="px-3 py-1.5 tabular-nums">
                {format.number(artifact.bytes / 1024, { maximumFractionDigits: 1 })} KB
              </td>
              <td className="px-3 py-1.5 font-mono text-xs" title={artifact.sha256}>
                {artifact.sha256.slice(0, 12)}
              </td>
              <td className="px-3 py-1.5 text-xs">
                {format.dateTime(new Date(artifact.createdAt), { dateStyle: 'short', timeStyle: 'short' })}
              </td>
              <td className="px-3 py-1.5">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={t('downloadOne', {
                    kind: t(`kinds.${artifact.kind}`),
                    attempt: artifact.attemptNo ?? '—',
                  })}
                  onClick={() =>
                    void download(jobId, artifact).catch(async () =>
                      (await getToast()).error(t('downloadFailed')),
                    )
                  }
                >
                  <DownloadIcon aria-hidden />
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
