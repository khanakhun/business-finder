import { ApiError } from '@bf/api-client';
import { renderHook } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';
import en from '../../i18n/messages/en.json';
import { toProblemLike, useErrorLabels } from './problem.ts';

describe('problem helpers', () => {
  it('passes API problems through and falls back for anything else', () => {
    const problem = { type: 'x', title: 'Not found', status: 404, code: 'NOT_FOUND', traceId: 't' };
    expect(toProblemLike(new ApiError(problem), 'fallback')).toBe(problem);
    expect(toProblemLike(new Error('boom'), 'Could not load')).toEqual({ title: 'Could not load' });
  });

  it('translates the error labels', () => {
    const { result } = renderHook(() => useErrorLabels(), {
      wrapper: ({ children }) => (
        <NextIntlClientProvider locale="en" messages={en}>
          {children}
        </NextIntlClientProvider>
      ),
    });
    expect(result.current).toEqual({
      retry: 'Try again',
      reference: 'Reference',
      copyReference: 'Copy reference',
      copied: 'Copied',
    });
  });
});
