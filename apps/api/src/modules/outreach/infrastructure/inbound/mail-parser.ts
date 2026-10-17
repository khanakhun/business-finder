import { Injectable } from '@nestjs/common';
import { type AddressObject, simpleParser } from 'mailparser';
import type { MailParser, ParsedMail } from '../../application/inbound/ports.ts';

// Raw RFC 822 → the fields ingestion needs (BF-054), in memory. DSN parts (`message/delivery-status`, the original
// headers) are kept as text for the bounce parser; other attachments only as metadata.

const TEXT_PARTS =
  /^(message\/(global-)?delivery-status|text\/rfc822-headers|message\/(global-)?rfc822|text\/plain)/i;
const MAX_PART = 64 * 1024;

const addresses = (value: AddressObject | AddressObject[] | undefined): string[] =>
  (Array.isArray(value) ? value : value ? [value] : [])
    .flatMap((object) => object.value)
    .map((entry) => entry.address?.toLowerCase())
    .filter((address): address is string => !!address);

@Injectable()
export class MailparserAdapter implements MailParser {
  async parse(raw: Buffer): Promise<ParsedMail> {
    const mail = await simpleParser(raw, { skipImageLinks: true, skipTextLinks: true });
    const headers: Record<string, string[]> = {};
    for (const line of mail.headerLines) {
      const list = headers[line.key] ?? [];
      list.push(line.line.slice(line.line.indexOf(':') + 1).trim());
      headers[line.key] = list;
    }
    const from = mail.from?.value[0];
    const references = Array.isArray(mail.references)
      ? mail.references
      : mail.references
        ? mail.references.split(/\s+/)
        : [];
    return {
      contentType: headers['content-type']?.[0] ?? 'text/plain',
      headers,
      from: from?.address ? { email: from.address.toLowerCase(), name: from.name || null } : null,
      to: addresses(mail.to),
      cc: addresses(mail.cc),
      subject: mail.subject ?? '',
      date: mail.date ?? null,
      messageId: mail.messageId ?? null,
      inReplyTo: mail.inReplyTo ?? null,
      references,
      text: mail.text ?? '',
      html: mail.html || null,
      parts: mail.attachments.map((attachment) => ({
        contentType: attachment.contentType,
        content: TEXT_PARTS.test(attachment.contentType)
          ? attachment.content.subarray(0, MAX_PART).toString('utf8')
          : '',
        filename: attachment.filename ?? null,
        size: attachment.size,
      })),
    };
  }
}
