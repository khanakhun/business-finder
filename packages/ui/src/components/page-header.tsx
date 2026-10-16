import type * as React from 'react';
import { cn } from '../lib/utils.ts';

export interface PageHeaderProps {
  readonly title: React.ReactNode;
  /** One sentence on what this page is for. */
  readonly description?: React.ReactNode;
  /** Primary actions, right-aligned on wide screens. */
  readonly actions?: React.ReactNode;
  readonly className?: string;
}

/** Page title block. Exactly one per page; the title is the page's <h1>. */
export function PageHeader({ title, description, actions, className }: PageHeaderProps) {
  return (
    <header className={cn('flex flex-col gap-3 pb-6 sm:flex-row sm:items-end sm:justify-between', className)}>
      <div className="min-w-0 space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
        {description ? <p className="max-w-prose text-base text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}
