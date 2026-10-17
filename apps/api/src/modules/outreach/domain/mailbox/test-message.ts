// The test message a person sends to their own address (BF-050): plain RFC 5322, no tracking, no outreach content.
// Real outreach MIME (compliance headers, unsubscribe) is composed by the outbound pipeline (BF-052).

const encodeHeader = (value: string) =>
  /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;

const formatAddress = (name: string, email: string) =>
  `${encodeHeader(name.replace(/["\r\n]/g, ''))} <${email}>`;

export function buildTestMessage(input: {
  readonly from: { readonly name: string; readonly email: string };
  readonly to: string;
  readonly messageId: string;
  readonly date: Date;
  readonly locale: 'en' | 'fr';
}): Buffer {
  const subject =
    input.locale === 'fr' ? 'Business Finder : test de votre boîte d’envoi' : 'Business Finder: mailbox test';
  const body =
    input.locale === 'fr'
      ? 'Ce message confirme que Business Finder peut envoyer depuis cette boîte.\r\n'
      : 'This message confirms Business Finder can send from this mailbox.\r\n';
  const headers = [
    `From: ${formatAddress(input.from.name, input.from.email)}`,
    `To: <${input.to}>`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${input.date.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: ${input.messageId}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
  ];
  return Buffer.from(
    `${headers.join('\r\n')}\r\n\r\n${Buffer.from(body, 'utf8')
      .toString('base64')
      .replace(/(.{76})/g, '$1\r\n')}\r\n`,
    'utf8',
  );
}
