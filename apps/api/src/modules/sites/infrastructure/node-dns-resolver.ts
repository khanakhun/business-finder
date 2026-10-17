import { Resolver } from 'node:dns/promises';
import { Injectable } from '@nestjs/common';
import type { DnsResolver } from '../application/go-live/ports.ts';
import type { DnsAnswers } from '../domain/domain-verification.ts';

// Public DNS lookups for custom domain verification (BF-062): a fresh resolver per check (no stale cache between
// the person adding a record and "check now"), short timeouts; no answer reads as no record.

const quiet = async <T>(query: Promise<T[]>): Promise<T[]> => {
  try {
    return await query;
  } catch {
    return [];
  }
};

@Injectable()
export class NodeDnsResolver implements DnsResolver {
  async answers(hostname: string, txtName: string): Promise<DnsAnswers> {
    const resolver = new Resolver({ timeout: 3_000, tries: 2 });
    const [txt, cname, a, aaaa] = await Promise.all([
      quiet(resolver.resolveTxt(txtName)),
      quiet(resolver.resolveCname(hostname)),
      quiet(resolver.resolve4(hostname)),
      quiet(resolver.resolve6(hostname)),
    ]);
    return { txt: txt.map((chunks) => chunks.join('')), cname, a, aaaa };
  }
}
