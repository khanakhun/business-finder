# Blocks engine eval (BF-041)

`businesses.json` holds 27 synthetic businesses (fake data). They cover the ticket's categories, FR/EN and EN-only sites, rich and sparse facts, and two prompt-injection cases. Each business becomes a real workspace (brief, facts, starter site) through BF-040's builders, then the blocks engine runs on it.

| Run | What it measures |
|---|---|
| CI (`blocks-engine.eval.test.ts`) | The pipeline with a **simulated** model: no network or keys. It checks validity, fact violations, lint errors, the event order, the re-ask on injected facts and abort within 3 s. Its texts are templates, so it says nothing about quality. |
| `pnpm --filter @bf/api eval:blocks` | Real models through the AI gateway (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`). It costs money. Each site is also graded by the agent-tier judge (`generation.site_judge`, an anchored 1–5 rubric, blind to the engine). Reports go to `reports/`. |

Options: `--limit <n>`, `--only <id,id>`, `--no-judge`, `--concurrency <n>`, `--simulated`.

The ticket's thresholds:
- **Automatic:** 100% valid specs, 0 fact violations, 0 lint errors, at most 3 lint warnings per site on the texts the engine writes. Fact values shown verbatim are not counted.
- **Judged** (live runs only): mean ≥ 4.0, no score below 3.
- **Reported:** median cost (target ≤ $0.40) and P50/P95 duration (targets < 2 min / < 4 min).
