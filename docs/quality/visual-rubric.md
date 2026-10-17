# Visual critic: rubric and calibration (BF-045)

The visual critic (`quality.visual_critic.v1`, smart tier with vision) grades a generated site from three screenshots:
- home at desktop, 1280 px wide;
- home at mobile, 390 px at 2×;
- the heaviest inner page at desktop.

Each is a few screens long, rendered offline in the quality sandbox with the site's own assets.

## Rubric

Nine criteria, scored 1–5. Anchors at 1, 3 and 5 are in the prompt (`packages/ai/prompts/quality.visual_critic.v1.md`):
- hierarchy;
- typography;
- spacing and rhythm;
- imagery;
- colour;
- calls to action;
- mobile layout;
- brand and positioning fit;
- originality.

The critic also lists the problems worth a repair, each tied to a block of the outline and a repair strategy:
`swap_hero_asset`, `change_variant`, `reduce_text`, `merge_sections`, `change_density`, `adjust_accent`,
`reorder_sections` or `other`.

## Pass rule (provisional)

A version passes when the average of the nine scores is **≥ 3.5** and **no criterion is below 3**. These are the
ticket's starting values: `PLATFORM_MINIMUMS.visual` in `apps/api/src/modules/generation/domain/quality/thresholds.ts`.
A workspace can tighten them, never loosen them.

## Calibration (pending: needs the team's ratings)

1. `pnpm quality:calibrate golden`. It needs Docker and the runner image. It renders the golden set: each synthetic
   business of the eval set, its starter site and a weakened variant (no photos, flat palette), at least 30 sites.
   The screenshots and `ratings.template.json` go to `apps/api/evals/quality-golden/`.
2. People copy the template to `ratings.json` and rate each site: 1–5 per criterion and overall. Two raters per site
   is better; average them.
3. `pnpm quality:calibrate agreement`. It needs model keys. It grades the same screenshots with the critic and writes
   `agreement-<timestamp>.json` with three things:
   - Spearman's ρ per criterion and overall (target: overall ≥ 0.6);
   - the critic threshold that best separates the sites people found acceptable (overall ≥ 3.5);
   - the cost.
4. Set the thresholds from the report and record the numbers here, with the date and the models used.

| Date | Sites | Critic model | ρ overall | Weakest criterion | Threshold chosen |
|---|---|---|---|---|---|
| — | — | — | — | — | provisional 3.5 / min 3 |
