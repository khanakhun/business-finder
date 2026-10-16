import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@bf/ui/components/card';
import type * as React from 'react';

/** The single card every auth page renders into (inside the (auth) layout). */
export function AuthCard({
  title,
  description,
  children,
  footer,
}: {
  readonly title: string;
  readonly description?: string | undefined;
  readonly children: React.ReactNode;
  readonly footer?: React.ReactNode | undefined;
}) {
  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>
          <h1 className="text-xl">{title}</h1>
        </CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent className="grid gap-4">
        {children}
        {footer ? <div className="text-center text-sm text-muted-foreground">{footer}</div> : null}
      </CardContent>
    </Card>
  );
}
