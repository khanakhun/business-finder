'use client';

import { CopyIcon, RotateCwIcon, TriangleAlertIcon } from 'lucide-react';
import * as React from 'react';
import { cn } from '../lib/utils.ts';
import { Button } from './button.tsx';

/** The fields of an RFC 9457 problem the UI shows (see @bf/contracts ProblemDetails). */
export interface ProblemLike {
  readonly title: string;
  readonly detail?: string | undefined;
  readonly status?: number | undefined;
  readonly traceId?: string | undefined;
}

export interface ErrorStateLabels {
  /** e.g. "Try again" */
  readonly retry: string;
  /** e.g. "Reference" — shown before the trace id, which support uses to find the request. */
  readonly reference: string;
  /** Accessible label for the copy button, e.g. "Copy reference". */
  readonly copyReference: string;
  /** Announced after copying, e.g. "Copied". */
  readonly copied: string;
}

export interface ErrorStateProps {
  readonly problem: ProblemLike;
  readonly labels: ErrorStateLabels;
  readonly onRetry?: () => void;
  readonly className?: string;
}

/** Renders an API error the same way everywhere: what failed, why, and the trace id to quote to support. */
export function ErrorState({ problem, labels, onRetry, className }: ErrorStateProps) {
  const [copied, setCopied] = React.useState(false);
  const copy = async () => {
    if (!problem.traceId) return;
    await navigator.clipboard?.writeText(problem.traceId);
    setCopied(true);
  };
  return (
    <div
      role="alert"
      className={cn('flex gap-3 rounded-lg border border-reef/30 bg-reef-wash px-4 py-4', className)}
    >
      <TriangleAlertIcon aria-hidden className="mt-0.5 size-5 shrink-0 text-reef" />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="space-y-1">
          <p className="font-semibold">{problem.title}</p>
          {problem.detail ? <p className="text-muted-foreground">{problem.detail}</p> : null}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {onRetry ? (
            <Button size="sm" variant="outline" onClick={onRetry}>
              <RotateCwIcon aria-hidden />
              {labels.retry}
            </Button>
          ) : null}
          {problem.traceId ? (
            <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
              {labels.reference}
              <code className="rounded bg-surface px-1.5 py-0.5 text-foreground" data-testid="trace-id">
                {problem.traceId}
              </code>
              <Button
                size="icon"
                variant="ghost"
                className="size-7"
                onClick={copy}
                aria-label={labels.copyReference}
              >
                <CopyIcon aria-hidden />
              </Button>
              <span aria-live="polite" className="sr-only">
                {copied ? labels.copied : ''}
              </span>
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
