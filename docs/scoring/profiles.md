# Built-in scoring profiles (BF-031)

Scores answer "who should I contact next, for which offer, and why?". Each **offer** has a built-in profile
(`apps/api/src/modules/scoring/domain/builtin-profiles.ts`, each at version 1). They are read-only: a workspace
duplicates one to customize it (BF-032). Change a weight here and in code together, bump that profile's version in
`BUILTIN_PROFILE_VERSIONS` (a test pins each version to a hash of its config), and update the golden table
(`golden.test.ts`, below).

## How a score is computed

1. **Features** (`FEATURE_DEFINITIONS` in `@bf/contracts`, computed in `scoring/domain/features`): typed values
   from the business record, the latest website audit and crawl, the workspace's review insights, contacts and CRM
   row. A value the facts do not give is *missing*; stored snapshots keep it missing, and scoring uses the
   feature's documented default when it has one (e.g. `has_phone` → false). Feature keys are append-only and
   `FEATURE_SET_VERSION` names the features' semantics.
2. **Transforms** map each value to 0–1: `linear`/`inverse` over a range, `piecewise` (non-decreasing points),
   `log` (`log(1 + x) ÷ log(1 + max)`), `boolean`, `enumMap`. Booleans default to 1/0; shares (0–1) need no
   transform. Numeric transforms are monotone; for "less is better" use `inverse` or a negative weight.
3. **Weighted sum**: `score = clamp(100 × Σ weight × transformed ÷ Σ positive weights, 0, 100)`. A missing feature
   takes the profile's `missing` value if it sets one — which can raise a score; the built-ins use it only for
   booking, paired with a cap — else contributes nothing while its weight still counts. Negative
   weights lower the score. Each contribution says what stood in (`imputed`: the registry default or the profile's
   `missing` value).
4. **Gates** (conditions on the features, defaults applied; a comparison with a missing value is false, so
   `not: { eq }` matches a missing value while `neq` does not): an *exclusion* gives tier **X**, score 0 and no
   reasons but its own; a *cap* limits the score (the lowest cap wins; an exclusion wins over caps). A cap that does
   not lower the score is reported as not applied: its reason still explains the score. Do-not-contact always
   excludes, whatever the profile says.
5. **Tiers**: A from the profile's `A` threshold, B from `B`, else C.
6. **Reasons**: the three strongest contributions each way, in EN/FR: the profile's `reasonTemplates` first, then
   the registry's texts — by value (`true`, `false`, an enum value), by side of the feature's pivot (`below`,
   `above`), else `value`. A value the profile filled in reads only a `missing` text (no text, no reason).

`category_offer_relevance` is one key whose value is the relevance of the profile's own offer (stored per score):
one key per offer would add five mostly irrelevant features to every snapshot.

The engine is pure and deterministic (property-tested: same input, same output; raising a positively weighted
feature never lowers the score).

## Gates shared by every built-in profile

| Gate | Condition | Effect | Why |
|---|---|---|---|
| `closed_permanently` | operating status is closed permanently | exclude | Nobody to sell to. |
| `disqualified` | pipeline status is disqualified | exclude | A person judged it. |
| `already_customer` | pipeline status is won | cap 40 | A customer stays visible for cross-selling, below cold prospects. |
| `no_solicitation` | the website asks not to be solicited | exclude | Respect the owner's wish (the compliance gate also blocks outreach). |
| `closed_temporarily` | operating status is closed temporarily | cap 40 | Worth a look later, not now. |
| `offer_rarely_fits` | category relevance of the offer < 0.25 | cap 30 | A missing booking tool does not make a gift shop a booking prospect. |
| `unreachable` | no usable e-mail, no phone, no WhatsApp | cap 30 | A great prospect we cannot reach is not "act now" yet; enrichment may find a way in. |

## `new_website` — businesses without a real website (tiers A ≥ 70, B ≥ 50)

| Feature | Weight | Transform | Rationale |
|---|---:|---|---|
| `website_status` | 40 | none/parked 1, social only 0.9, broken 0.7, weak 0.25, ok/strong 0 | The need itself: no site (or no real one) is the strongest signal. |
| `category_offer_relevance` | 15 | — (0–1) | Some trades need a site more than others (the taxonomy says how much). |
| `review_count_log` | 10 | linear 0–3 (1 to 1,000 reviews) | Busy businesses can pay and have customers looking for them. |
| `has_verified_email` | 8 | yes/no | We can reach them in writing. |
| `has_phone` | 7 | yes/no | We can call. |
| `rating_avg` | 5 | linear 3–5 | A good reputation deserves a page that shows it. |
| `tourism_facing` | 5 | yes/no | Visitors search online before they come. |
| `pain_share.hard_to_find_info` | 5 | linear 0–30 % | Customers already complain they cannot find the information. |
| `pain_share.website_broken_or_outdated` | 5 | linear 0–30 % | Customers already notice the website problem. |
| `appointment_based` | 3 | yes/no | A site that takes requests saves them calls. |
| `price_level` | 3 | linear 1–4 | Higher price points afford a site more easily. |
| `has_whatsapp` | 2 | yes/no | One more way in. |
| `multi_location` | −8 | yes/no | Chains usually have a central website and agency. |

Extra gate: `has_working_website` (status ok/strong) caps at 30 — that business belongs to the redesign offer.

## `website_redesign` — businesses with a poor website (tiers A ≥ 65, B ≥ 45)

| Feature | Weight | Transform | Rationale |
|---|---:|---|---|
| `website_status` | 25 | broken 1, weak 0.9, ok 0.4, none/parked/social only/strong 0 | The need: a site that serves the business poorly (no real site is the new website offer's). |
| `website_quality_score` | 15 | inverse 20–90 | The audit's composite of design, speed and findings. |
| `vision_overall` | 10 | inverse 2–9 | A dated look is what owners see and feel first. |
| `psi_mobile_performance` | 8 | inverse 20–90 | Slow on phones loses visitors (most traffic is mobile). |
| `category_offer_relevance` | 8 | — | How much a better site matters for this trade. |
| `site_freshness_years` | 7 | linear 1–6 years | An abandoned site is a sign of need (and of no current agency). |
| `lcp_mobile_seconds` | 5 | linear 2.5–8 s | The main content takes long to show on a phone. |
| `has_language_gap_for_market` | 5 | yes/no | Missing English for tourists, or French locally. |
| `review_count_log` | 5 | linear 0–3 | Activity and budget. |
| `pain_share.website_broken_or_outdated` | 5 | linear 0–30 % | Customers mention the website. |
| `has_verified_email` | 5 | yes/no | Reachable in writing. |
| `has_https` | 4 | no HTTPS → 1 | Browsers flag the site as not secure. |
| `has_contact_form` | 3 | no form → 1 | Leads are lost. |
| `ad_pixels_present` | 3 | yes/no | They already pay for marketing: a better site multiplies it. |
| `has_phone` | 3 | yes/no | Reachable by phone. |
| `multi_location` | −6 | yes/no | Chains have central sites. |

A missing measurement (PageSpeed quota, model outage, a site that cannot be audited) contributes nothing: a
broken site is already rewarded by `website_status` (broken → 1). Extra gates: `no_website_to_redesign` (status
none/parked/social only) caps at 20 — that business belongs to the new website offer; `not_audited_yet` (a website,
no audit) caps at 40 until the audit runs. A broken site leads with the new website offer (a rebuild): redesign
ranks it lower, since nothing on it could be measured.

## `ai_receptionist` — businesses that miss calls and messages (tiers A ≥ 65, B ≥ 45)

| Feature | Weight | Transform | Rationale |
|---|---:|---|---|
| `pain_share.unreachable_by_phone` | 20 | linear 0–25 % | The exact problem the offer solves. |
| `category_offer_relevance` | 15 | — | Trades that live on the phone. |
| `pain_share.slow_or_no_reply` | 12 | linear 0–25 % | Messages go unanswered. |
| `appointment_based` | 12 | yes/no | Bookings by phone are the receptionist's core job. |
| `has_phone` | 8 | yes/no | There must be a line to answer. |
| `review_count_log` | 8 | linear 0.5–3 | Busy enough to miss calls. |
| `pain_share.poor_communication` | 5 | linear 0–25 % | Related complaint. |
| `pain_share.language_barrier` | 5 | linear 0–20 % | A multilingual receptionist helps. |
| `tourism_facing` | 5 | yes/no | Foreign callers, other time zones. |
| `owner_response_rate` | 5 | inverse 0–80 % | Owners who do not reply to reviews likely miss calls too. |
| `has_verified_email` | 4 | yes/no | Reachable in writing. |
| `has_whatsapp` | 3 | yes/no | Messaging channel to automate. |
| `price_level` | 3 | linear 1–4 | Budget. |

Extra gate: `no_phone_line` (no phone) caps at 40.

## `booking_system` — appointment businesses without online booking (tiers A ≥ 65, B ≥ 45)

| Feature | Weight | Transform | Rationale |
|---|---:|---|---|
| `has_booking_tool` | 25 | no tool → 1 | The need itself. |
| `appointment_based` | 15 | yes/no | Booking only matters for appointment trades. |
| `category_offer_relevance` | 15 | — | How much the trade books. |
| `pain_share.booking_friction` | 15 | linear 0–25 % | Customers complain about booking. |
| `review_count_log` | 7 | linear 0.5–3 | Volume of customers. |
| `pain_share.long_wait_times` | 5 | linear 0–25 % | Scheduling problems. |
| `has_verified_email` | 5 | yes/no | Reachable in writing. |
| `tourism_facing` | 4 | yes/no | Visitors book ahead, online. |
| `has_website` | 3 | yes/no | A widget fits an existing site (without one, the new website offer leads). |
| `has_phone` | 3 | yes/no | Reachable by phone. |

Missing value: `has_booking_tool` counts as "no tool" when unknown (no readable site, e.g. only a social page).
Extra gates: `booking_not_checked` (a website whose crawl did not say — not crawled yet, blocked, broken — other
than a social page or a parked domain) caps at 40; `already_books_online` caps at 35.

## `local_seo` — businesses customers struggle to find (tiers A ≥ 65, B ≥ 45)

| Feature | Weight | Transform | Rationale |
|---|---:|---|---|
| `category_offer_relevance` | 12 | — | Trades found through local search. |
| `pain_share.hard_to_find_info` | 12 | linear 0–25 % | Customers say they cannot find it. |
| `rating_avg` | 10 | linear 3.5–5 | A good reputation is worth showing in search. |
| `website_status` | 10 | weak 0.8, social only 0.7, none/parked/broken/ok 0.6, strong 0.3 | Every business needs presence; a strong site already ranks better. |
| `has_language_gap_for_market` | 10 | yes/no | Invisible to searchers in the missing language. |
| `tourism_facing` | 10 | yes/no | Visitors search maps and "near me". |
| `review_count_log` | 8 | linear 0.5–2.5 | Reviews feed local ranking. |
| `website_quality_score` | 8 | inverse 30–95 | Technical SEO room. |
| `owner_response_rate` | 6 | inverse 0–80 % | Unanswered reviews hurt local ranking. |
| `has_verified_email` | 5 | yes/no | Reachable in writing. |
| `multi_location` | 4 | yes/no | Several listings to manage. |
| `has_phone` | 3 | yes/no | Reachable by phone. |
| `pain_share.positive_strong_reputation` | 2 | linear 0–50 % | Praise to amplify. |

## Golden table

Twelve fictional businesses (`scoring/domain/__fixtures__/golden.ts`) and their tier per profile, pinned by
`golden.test.ts`:

| Business | new website | redesign | AI receptionist | booking | local SEO |
|---|:-:|:-:|:-:|:-:|:-:|
| Beach bistro, no website, busy | A | C | C | B | B |
| Salon, Facebook page only, phone pains | A | C | A | A | C |
| Villa rental, dated slow site | B | A | B | A | A |
| Hotel, strong site, books online | C | C | B | C | B |
| Dentist, ok site, no booking | C | C | B | A | C |
| Gift shop, parked domain | B | C | C | C | C |
| Permanently closed café | X | X | X | X | X |
| Do-not-contact bakery | X | X | X | X | X |
| Garage, unreachable | C | C | C | C | C |
| Spa, broken site, many complaints | B | C | A | C | C |
| Chain boutique, shared website | C | C | C | C | C |
| Won customer, no website | C | C | C | C | C |
