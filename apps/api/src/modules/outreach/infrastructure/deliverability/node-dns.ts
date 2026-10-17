import { Resolver } from 'node:dns/promises';
import { Injectable } from '@nestjs/common';
import type { DnsLookups } from '../../domain/deliverability/domain-check.ts';

// DNS for the authentication checks (BF-056): the system resolver with a short timeout and two tries. "No such
// record" is an empty answer; a timeout or a server failure is `null` (the check then says `unknown`, never `pass`).

const NO_DATA = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN', 'ENONAME']);

@Injectable()
export class NodeDnsLookups implements DnsLookups {
  private readonly resolver = new Resolver({ timeout: 3_000, tries: 2 });

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
