import { readFile } from 'node:fs/promises';
import { defineEval, jsonPathMatch } from '../../src/evals/index.ts';
import { AssetsAnalyzeImage, type AssetsAnalyzeImageOutput } from '../../src/tasks/assets-analyze-image.ts';

interface Expected {
  readonly depicts: string;
  readonly containsText: boolean;
  readonly containsPeople: boolean;
}

// BF-038 targets: ≥ 90% on `depicts`, ≥ 95% on people flags (identifiable people matter most: AI images must have
// none). This first set is synthetic (shapes and gradients rendered by make-images.ts, no third-party content); the
// 50+ labelled photos the ticket asks for need a licensed set (follow-up).
export default defineEval({
  task: AssetsAnalyzeImage,
  images: async (row) =>
    Promise.all(
      (row.input as { images: string[] }).images.map(async (path) => ({
        bytes: new Uint8Array(await readFile(new URL(path, import.meta.url))),
        mediaType: 'image/jpeg',
      })),
    ),
  scorers: [
    jsonPathMatch('depicts', (depicts, row) => depicts === (row.expected as Expected).depicts, 'exact'),
    jsonPathMatch(
      'containsPeople',
      (people, row) => people === (row.expected as Expected).containsPeople,
      'exact',
    ),
    jsonPathMatch('containsText', (text, row) => text === (row.expected as Expected).containsText, 'exact'),
    jsonPathMatch(
      'alt',
      (alt) => {
        const texts = (alt as AssetsAnalyzeImageOutput['alt'] | undefined) ?? [];
        return (
          ['fr', 'en'].every((locale) => texts.some((entry) => entry.locale === locale)) &&
          texts.every((entry) => entry.text.length <= 125 && !/^(image|photo) (of|de)\b/i.test(entry.text))
        );
      },
      'complete',
    ),
  ],
  thresholds: {
    'depicts.exact': 0.9,
    'containsPeople.exact': 0.95,
    'containsText.exact': 0.8,
    'alt.complete': 1,
  },
});
