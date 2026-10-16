import { type APIRequestContext, expect } from '@playwright/test';
import { env } from './env.ts';

const mailpit = () => `http://127.0.0.1:${env.BF_MAILPIT_UI_PORT ?? '8025'}`;

interface MailpitMessage {
  readonly ID: string;
  readonly Subject: string;
}

/**
 * The newest link in the newest email to `to` whose URL contains `contains` (Mailpit's API; the API sends system
 * mail there locally and in CI). Polls: emails are sent asynchronously.
 */
export async function linkFromEmail(
  request: APIRequestContext,
  to: string,
  contains: string,
): Promise<string> {
  let link: string | undefined;
  await expect
    .poll(
      async () => {
        const search = await request.get(`${mailpit()}/api/v1/search`, { params: { query: `to:"${to}"` } });
        const { messages } = (await search.json()) as { messages: MailpitMessage[] };
        for (const message of messages) {
          const body = (await (await request.get(`${mailpit()}/api/v1/message/${message.ID}`)).json()) as {
            Text: string;
          };
          link = body.Text.match(/https?:\/\/\S+/g)?.find((url) => url.includes(contains));
          if (link) return true;
        }
        return false;
      },
      { timeout: 15_000, intervals: [250, 500, 1_000] },
    )
    .toBe(true);
  return (link ?? '').replace(/[)\]>.,]+$/, '');
}
