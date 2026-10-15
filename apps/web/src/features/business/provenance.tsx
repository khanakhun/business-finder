'use client';

import type { Provenance } from '@bf/contracts';
import { Badge } from '@bf/ui/components/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@bf/ui/components/tooltip';
import { useFormatter, useTranslations } from 'next-intl';

/** Where a fact came from: the source as a badge, confidence and date on hover/focus. */
export function SourceBadge({ provenance }: { readonly provenance: Provenance | undefined }) {
  const t = useTranslations('business.sources');
  const p = useTranslations('business.provenance');
  const format = useFormatter();
  if (!provenance) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" tabIndex={0} className="cursor-default font-normal text-muted-foreground">
          {t(provenance.source)}
        </Badge>
      </TooltipTrigger>
      <TooltipContent>
        {p('detail', {
          confidence: format.number(provenance.confidence, { style: 'percent' }),
          date: format.dateTime(new Date(provenance.observedAt), { dateStyle: 'medium' }),
        })}
      </TooltipContent>
    </Tooltip>
  );
}
