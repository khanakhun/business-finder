import type {
  CategoryAttributes,
  FindingCode,
  OfferRelevance,
  OperatingStatus,
  PainSignalTag,
  PipelineStatus,
  SiteIntel,
  VerificationStatus,
  WebsiteStatus,
} from '@bf/contracts';

// What scoring knows about a business at one point in time (BF-031): an immutable snapshot assembled in bulk from the
// business graph, the latest website audit and crawl, the workspace's review insights, contacts and CRM row. Features
// are pure functions of it, so a score is reproducible from the facts (and their hash) alone.

/** The crawl facts features read (a subset of SiteIntel, as stored with the latest audited snapshot). */
export type SiteFacts = Pick<
  SiteIntel,
  | 'reachability'
  | 'socialOnly'
  | 'security'
  | 'pages'
  | 'booking'
  | 'ordering'
  | 'contacts'
  | 'analytics'
  | 'freshness'
  | 'noSolicitation'
>;

export interface BusinessFacts {
  readonly businessId: string;
  /** When the facts were assembled (ages and freshness are measured from it, never from the clock). */
  readonly asOf: string;
  readonly business: {
    readonly countryCode: string | null;
    readonly operatingStatus: OperatingStatus;
    readonly priceLevel: number | null;
    readonly ratingAvg: number | null;
    readonly ratingCount: number | null;
    readonly websiteUrl: string | null;
    /** Businesses (this one included) whose website is on the same registrable domain. */
    readonly sharedWebsiteCount: number;
  };
  /** The primary category's attributes and offer relevance, inherited from its ancestors; null without one. */
  readonly category: {
    readonly attributes: CategoryAttributes;
    readonly offerRelevance: OfferRelevance;
  } | null;
  /** The latest website audit; null before the first one (or without a website). */
  readonly audit: {
    readonly status: WebsiteStatus;
    readonly qualityScore: number | null;
    readonly psiMobilePerformance: number | null;
    readonly lcpMobileMs: number | null;
    readonly visionOverall: number | null;
    readonly findingCodes: readonly FindingCode[];
  } | null;
  /** The crawl behind the latest audit; null without one. */
  readonly site: SiteFacts | null;
  /** The workspace's review insights; null without any. */
  readonly reviews: {
    readonly sampleSize: number;
    readonly painShare: Readonly<Partial<Record<PainSignalTag, number>>>;
    readonly sentimentAvg: number | null;
    readonly ownerResponseRate: number | null;
  } | null;
  readonly contacts: {
    /** E-mails the workspace may use, with their verification and whether they are generic (info@…). */
    readonly emails: readonly { readonly status: VerificationStatus; readonly generic: boolean }[];
    readonly phones: number;
    readonly whatsapp: number;
  };
  readonly workspace: {
    readonly doNotContact: boolean;
    readonly pipelineStatus: PipelineStatus;
    /** The workspace's last outbound contact; null if never. */
    readonly lastContactedAt: string | null;
  };
}
