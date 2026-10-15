import type * as React from 'react';

/** A titled settings panel. */
export function SettingsSection({
  id,
  title,
  description,
  action,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly description?: string | undefined;
  readonly action?: React.ReactNode;
  readonly children?: React.ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="max-w-3xl rounded-lg border bg-surface">
      <div className="flex flex-col gap-3 border-b px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 id={id} className="font-semibold">
            {title}
          </h2>
          {description ? <p className="text-muted-foreground">{description}</p> : null}
        </div>
        {action}
      </div>
      {children ? <div className="px-5 py-4">{children}</div> : null}
    </section>
  );
}
