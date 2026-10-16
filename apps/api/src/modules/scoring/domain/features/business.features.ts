import { type FeatureComputes, readableSite, round } from './feature.ts';

// Business features (BF-031): the golden record, its category and review statistics.

export const businessFeatures: FeatureComputes = {
  category_offer_relevance: (facts, { offer }) => facts.category?.offerRelevance[offer] ?? null,
  appointment_based: (facts) => facts.category?.attributes.appointmentBased ?? null,
  tourism_facing: (facts) => facts.category?.attributes.tourismFacing ?? null,
  price_level: (facts) => facts.business.priceLevel,
  rating_avg: (facts) => facts.business.ratingAvg,
  review_count_log: (facts) => {
    const count = facts.business.ratingCount;
    return count === null ? null : round(Math.log10(1 + Math.max(0, count)), 3);
  },
  owner_response_rate: (facts) => facts.reviews?.ownerResponseRate ?? null,
  multi_location: (facts) => facts.business.websiteUrl !== null && facts.business.sharedWebsiteCount > 1,
  ad_pixels_present: (facts) => {
    const analytics = readableSite(facts)?.analytics;
    return analytics ? analytics.metaPixel || analytics.tiktokPixel : null;
  },
  operating_status: (facts) => facts.business.operatingStatus,
};
