import { Resolver } from 'node:dns/promises';
import { Inject, Injectable } from '@nestjs/common';
import type { DnsLookups } from '../../domain/deliverability/domain-check.ts';

// DNS for the authentication checks (BF-056): the system resolver with a short timeout and two tries. "No such
// record" is an empty answer; a timeout or a server failure is `null` (the check then says `unknown`, never `pass`).

const NO_DATA = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN', 'ENONAME']);

export const DNSBL_KEY = Symbol('DnsblKey');

@Injectable()
export class NodeDnsLookups implements DnsLookups {
  private readonly resolver = new Resolver({ timeout: 3_000, tries: 2 });

  /** Spamhaus DBL through the Data Query Service: only with a key (its terms forbid public-resolver queries). */
  readonly listed: DnsLookups['listed'];

  constructor(@Inject(DNSBL_KEY) dqsKey: string | null) {
    this.listed = dqsKey
      ? async (domain: string) => {
          try {
            const answers = await this.resolver.resolve4(`${domain}.${dqsKey}.dbl.dq.spamhaus.net`);
            // 127.0.1.x = listed; 127.255.255.x = a query error (not a listing).
            return answers.some((ip) => ip.startsWith('127.0.1.'));
          } catch (error) {
            return NO_DATA.has((error as { code?: string }).code ?? '') ? false : null;
          }
        }
      : undefined;
  }

  readonly txt = async (name: string): Promise<string[] | null> => {
    try {
      return (await this.resolver.resolveTxt(name)).map((chunks) => chunks.join(''));
    } catch (error) {
      return NO_DATA.has((error as { code?: string }).code ?? '') ? [] : null;
    }
  };

  readonly mx = async (domain: string): Promise<string[] | null> => {
    try {
      return (await this.resolver.resolveMx(domain))
        .sort((a, b) => a.priority - b.priority)
        .map((record) => record.exchange.toLowerCase());
    } catch (error) {
      return NO_DATA.has((error as { code?: string }).code ?? '') ? [] : null;
    }
  };
}
