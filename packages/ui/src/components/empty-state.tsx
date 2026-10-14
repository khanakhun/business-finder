import type * as React from 'react';
import { cn } from '../lib/utils.ts';

export interface EmptyStateProps {
  readonly icon?: React.ReactNode;
  readonly title: React.ReactNode;
  /** What the person can do next — an empty screen is an invitation to act. */
  readonly description?: React.ReactNode;
  readonly action?: React.ReactNode;
  readonly className?: string;
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-start gap-3 rounded-lg border border-dashed border-line-strong bg-surface px-6 py-10',
        className,
      )}
    >
      {icon ? <div className="text-muted-foreground [&_svg]:size-5">{icon}</div> : null}
      <div className="space-y-1">
        <p className="text-lg font-semibold">{title}</p>
        {description ? <p className="max-w-prose text-muted-foreground">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}
