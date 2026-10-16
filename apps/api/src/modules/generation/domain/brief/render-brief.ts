import type { GenerationBrief } from '@bf/contracts';

// BRIEF.md (BF-040): the brief for people and agents to read, rendered from brief.json (which stays the source of
// truth). Deterministic; no crawled text (the operator's instructions are the only free text, labelled as such).

const list = (items: readonly string[]) =>
  items.length ? items.map((item) => `- ${item}`).join('\n') : '- (none)';

export function renderBrief(brief: GenerationBrief): string {
  const { identity, offer, audience, locales, pagePlan, design, constraints } = brief;
  const lines = [
    `# Brief — ${identity.name}`,
    '',
    `Brief version ${brief.briefVersion}. Use only the facts in \`facts.json\`; when a fact is missing, write neutral copy.`,
    '',
    '## Identity',
    '',
    list(
      [
        `Name: ${identity.name}${identity.nameFactId ? ` (\`${identity.nameFactId}\`)` : ''}`,
        identity.categoryLabel
          ? `Category: ${identity.categoryLabel.en} / ${identity.categoryLabel.fr} (\`${identity.categoryPath}\`)`
          : '',
        identity.locality ? `Locality: ${identity.locality}` : '',
        identity.description ? `In its own words: ${identity.description}` : '',
      ].filter(Boolean),
    ),
    '',
    '## Locales',
    '',
    `${locales.available.join(', ')} (default ${locales.default}).`,
    '',
    '## Offer (messaging focus — never state these as claims about the business)',
    '',
    `Offer: \`${offer.id}\`.`,
    list(offer.improvements.map((item) => `${item.text} (\`${item.ref}\`)`)),
    '',
    '## Audience',
    '',
    `Market: ${audience.market}.`,
    list(audience.hints.map((hint) => `${hint.text} (${hint.evidence.map((id) => `\`${id}\``).join(', ')})`)),
    '',
    '## Page plan',
    '',
    `Template \`${pagePlan.id}\` (matched \`${pagePlan.matched}\`).`,
    '',
    ...pagePlan.pages.flatMap((page) => [
      `### ${page.kind} (\`/${page.slug}\`)`,
      '',
      list(
        page.blocks.map(
          (block) =>
            `${block.type} · ${block.variant ?? 'default'}${block.fills ? ` — fills ${block.fills.join(', ')}` : ''}`,
        ),
      ),
      '',
    ]),
    pagePlan.collapsed.length ? '#### Collapsed pages' : '',
    pagePlan.collapsed.length
      ? list(pagePlan.collapsed.map((page) => `${page.kind} → ${page.into}: ${page.reason}`))
      : '',
    '',
    '## Selling points',
    '',
    list(
      brief.sellingPoints.map(
        (point) => `${point.text} (${point.evidence.map((id) => `\`${id}\``).join(', ')})`,
      ),
    ),
    '',
    '## Pain points to solve',
    '',
    list(brief.painPoints.map((pain) => `${pain.tag}: ${pain.remedy}`)),
    '',
    '## Design direction',
    '',
    list([
      `Style: ${design.style} — ${design.reasons.join('; ')}`,
      `Palette seed: primary ${design.palette.primary}, accent ${design.palette.accent} (from ${design.palette.source})`,
      `Imagery: ${design.imagery}`,
      `Density: ${design.density}`,
    ]),
    '',
    '## Constraints',
    '',
    list(
      [
        'No invented facts: every phone, e-mail, price, year, name and quote comes from facts.json.',
        'Neutral copy where facts are missing; never filler.',
        `Tone: ${constraints.tone}.`,
        constraints.frenchTypography
          ? 'French typography (non-breaking spaces before : ; ! ? and inside « »).'
          : '',
        `Headlines ≤ ${constraints.maxHeadlineChars} characters; paragraphs ≤ ${constraints.maxParagraphChars}.`,
        ...constraints.doNotMention.map((item) => `Do not mention: ${item}.`),
      ].filter(Boolean),
    ),
    '',
    '## Warnings',
    '',
    list(brief.warnings.map((warning) => `${warning.code}: ${warning.message}`)),
    '',
  ];
  if (brief.extraInstructions)
    lines.push(
      '## Operator instructions (from a workspace member)',
      '',
      '```text',
      brief.extraInstructions.replace(/`/g, "'"),
      '```',
      '',
    );
  return `${lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
}
