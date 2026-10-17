import { Injectable } from '@nestjs/common';

// Preview views attributed to an email (BF-053, Registry): when a counted view carries the outreach token of the
// email it came from (`?r=`), the modules that registered a handler hear about it — the outbound pipeline records it
// on its message. Only the token, the site and the time travel: nothing about the visitor.

export type ViewAttributionHandler = (input: {
  readonly outreachToken: string;
  readonly siteId: string;
  readonly at: Date;
}) => Promise<void>;

@Injectable()
export class SiteViewAttribution {
  private readonly handlers: ViewAttributionHandler[] = [];

  register(handler: ViewAttributionHandler): void {
    this.handlers.push(handler);
  }

  /** Best effort: an attribution failure never fails the view. */
  async attribute(input: Parameters<ViewAttributionHandler>[0]): Promise<void> {
    for (const handler of this.handlers) await handler(input).catch(() => undefined);
  }
}
