import type {
  CategoryAttributes,
  FindingCode,
  OfferRelevance,
  OperatingStatus,
  PainSignalTag,
  PipelineStatus,
  VerificationStatus,
  WebsiteStatus,
} from '@bf/contracts';
import { type DbClient, getExecutor } from '@bf/db';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DB_CLIENT } from '../../platform/db/db.module.ts';
import type { FactsAssembler } from '../application/ports.ts';
import type { BusinessFacts, SiteFacts } from '../domain/facts.ts';

// The facts of a batch of businesses of one workspace (BF-031) in three queries, whatever the batch size: the
// business with its workspace row, primary category (ancestors' attributes and offer relevance, root first), latest
// audit and the crawl behind it; the contacts; the workspace's review insights.
// DECISION(BF-031): a cross-module read model (business graph, CRM, enrichment, reviews tables, read-only), like the
// enrichment subject reader; scoring writes only its own tables and the denormalized score columns.

/** Pipeline stages a business reaches once the workspace contacted it. */
const CONTACTED = ['contacted', 'engaged', 'meeting', 'proposal', 'won', 'lost'];

interface BusinessRow extends Record<string, unknown> {
  id: string;
  country_code: string | null;
  operating_status: OperatingStatus;
  price_level: number | null;
  rating_avg: number | string | null;
  rating_count: number | null;
  website_url: string | null;
  shared_website_count: number | string;
  do_not_contact: boolean;
  pipeline_status: PipelineStatus;
  status_changed_at: Date | string | null;
  category_attributes: CategoryAttributes[] | null;
  category_relevance: OfferRelevance[] | null;
  audit_status: WebsiteStatus | null;
  quality_score: number | null;
  psi_mobile_performance: number | string | null;
  lcp_mobile_ms: number | string | null;
  vision_overall: number | string | null;
  finding_codes: FindingCode[] | null;
  site: SiteFacts | null;
}

interface ContactRow extends Record<string, unknown> {
  business_id: string;
  type: string;
  subtype: string;
  verification_status: VerificationStatus;
}

interface InsightsRow extends Record<string, unknown> {
  business_id: string;
  sample_size: number;
  pain_share: Partial<Record<PainSignalTag, number>>;
  sentiment_avg: number | null;
  owner_response_rate: number | null;
}

const num = (value: number | string | null | undefined): number | null =>
  value === null || value === undefined ? null : Number(value);
const iso = (value: Date | string | null): string | null =>
  value === null ? null : new Date(value).toISOString();

@Injectable()
export class SqlFactsAssembler implements FactsAssembler {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  async assemble(
    organizationId: string,
    businessIds: readonly string[],
    asOf: Date,
  ): Promise<BusinessFacts[]> {
    if (businessIds.length === 0) return [];
    const x = getExecutor(this.db);
    const ids = sql`ARRAY[${sql.join(
      businessIds.map((id) => sql`${id}`),
      sql`, `,
    )}]::uuid[]`;
    const [businesses, contacts, insights] = await Promise.all([
      x.execute<BusinessRow>(sql`
        SELECT b.id, b.country_code, b.operating_status, b.price_level, b.rating_avg, b.rating_count, b.website_url,
          CASE WHEN b.website_registrable_domain IS NULL THEN 1 ELSE (
            SELECT count(*) FROM businesses o
            WHERE o.website_registrable_domain = b.website_registrable_domain AND o.merged_into_id IS NULL
          ) END AS shared_website_count,
          ob.do_not_contact, ob.pipeline_status, ob.status_changed_at,
          cat.attributes AS category_attributes, cat.relevance AS category_relevance,
          wa.website_status AS audit_status, wa.quality_score,
          wa.psi->'mobile'->'scores'->>'performance' AS psi_mobile_performance,
          wa.psi->'mobile'->'metrics'->>'lcpMs' AS lcp_mobile_ms,
          wa.vision->>'overall' AS vision_overall,
          jsonb_path_query_array(wa.findings, '$[*].code') AS finding_codes,
          CASE WHEN ws.id IS NULL THEN NULL ELSE jsonb_build_object(
            'reachability', ws.reachability, 'socialOnly', ws.social_only, 'security', ws.security,
            'pages', ws.pages, 'booking', ws.booking, 'ordering', ws.ordering,
            'contacts', jsonb_build_object('emails', '[]'::jsonb, 'phones', '[]'::jsonb,
              'whatsappLinks', '[]'::jsonb, 'contactForms', ws.contacts->'contactForms'),
            'analytics', ws.analytics, 'freshness', ws.freshness, 'noSolicitation', ws.no_solicitation
          ) END AS site
        FROM businesses b
        JOIN org_businesses ob ON ob.business_id = b.id AND ob.organization_id = ${organizationId}
        LEFT JOIN LATERAL (
          SELECT jsonb_agg(anc.attributes ORDER BY nlevel(anc.path)) AS attributes,
                 jsonb_agg(anc.offer_relevance ORDER BY nlevel(anc.path)) AS relevance
          FROM categories leaf JOIN categories anc ON anc.path @> leaf.path
          WHERE leaf.id = b.primary_category_id
        ) cat ON true
        LEFT JOIN website_audits wa ON wa.business_id = b.id AND wa.is_latest
        LEFT JOIN website_snapshots ws ON ws.id = wa.snapshot_id
        WHERE b.id = ANY(${ids})`),
      // Contacts the workspace may use: shared ones and its own manual entries (ADR-0008).
      x.execute<ContactRow>(sql`
        SELECT business_id, type, subtype, verification_status FROM business_contacts
        WHERE business_id = ANY(${ids})
          AND (submitted_by_org_id IS NULL OR submitted_by_org_id = ${organizationId})`),
      x.execute<InsightsRow>(sql`
        SELECT business_id, sample_size, pain_share, sentiment_avg, owner_response_rate FROM review_insights
        WHERE organization_id = ${organizationId} AND business_id = ANY(${ids})`),
    ]);
    const contactsOf = new Map<string, ContactRow[]>();
    for (const row of contacts)
      contactsOf.set(row.business_id, [...(contactsOf.get(row.business_id) ?? []), row]);
    const insightsOf = new Map(insights.map((row) => [row.business_id, row]));
    const order = new Map(businessIds.map((id, index) => [id, index]));
    return [...businesses]
      .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
      .map((row) => toFacts(row, contactsOf.get(row.id) ?? [], insightsOf.get(row.id), asOf));
  }
}

const merged = <T extends object>(levels: readonly T[] | null): T =>
  Object.assign({}, ...(levels ?? [])) as T;

function toFacts(
  row: BusinessRow,
  contacts: readonly ContactRow[],
  insights: InsightsRow | undefined,
  asOf: Date,
) {
  const facts: BusinessFacts = {
    businessId: row.id,
    asOf: asOf.toISOString(),
    business: {
      countryCode: row.country_code,
      operatingStatus: row.operating_status,
      priceLevel: row.price_level,
      ratingAvg: num(row.rating_avg),
      ratingCount: row.rating_count,
      websiteUrl: row.website_url,
      sharedWebsiteCount: Number(row.shared_website_count),
    },
    category: row.category_attributes
      ? { attributes: merged(row.category_attributes), offerRelevance: merged(row.category_relevance) }
      : null,
    audit: row.audit_status
      ? {
          status: row.audit_status,
          qualityScore: row.quality_score,
          psiMobilePerformance: num(row.psi_mobile_performance),
          lcpMobileMs: num(row.lcp_mobile_ms),
          visionOverall: num(row.vision_overall),
          findingCodes: row.finding_codes ?? [],
        }
      : null,
    site: row.site,
    reviews: insights
      ? {
          sampleSize: insights.sample_size,
          painShare: insights.pain_share,
          sentimentAvg: insights.sentiment_avg,
          ownerResponseRate: insights.owner_response_rate,
        }
      : null,
    contacts: {
      emails: contacts
        .filter((contact) => contact.type === 'email')
        .map((contact) => ({ status: contact.verification_status, generic: contact.subtype === 'generic' })),
      phones: contacts.filter((contact) => contact.type === 'phone').length,
      whatsapp: contacts.filter((contact) => contact.type === 'whatsapp').length,
    },
    workspace: {
      doNotContact: row.do_not_contact,
      pipelineStatus: row.pipeline_status,
      // DECISION(BF-031): until outreach records sends (BF-05x), the last contact is the last pipeline move of a
      // contacted business.
      lastContactedAt: CONTACTED.includes(row.pipeline_status) ? iso(row.status_changed_at) : null,
    },
  };
  return facts;
}
