'use client';

import { ApiError } from '@bf/api-client';
import type { ErrorStateLabels, ProblemLike } from '@bf/ui/components/error-state';
import { useTranslations } from 'next-intl';

/** What ErrorState shows for any thrown value: the API's problem, or a generic one. */
export function toProblemLike(error: unknown, fallbackTitle: string): ProblemLike {
  if (error instanceof ApiError) return error.problem;
  return { title: fallbackTitle };
}

export function useErrorLabels(): ErrorStateLabels {
  const t = useTranslations('errors');
  return {
    retry: t('retry'),
    reference: t('reference'),
    copyReference: t('copyReference'),
    copied: t('copied'),
  };
}
