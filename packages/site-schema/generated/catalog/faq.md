# FAQ (`faq`)

Questions customers ask, answered from the facts.

## Use it

- Answers the facts support; otherwise invite them to ask.

## Avoid

- Answers that state new facts (prices, policies) not in the registry.

## Variants

| Variant | When | Preview |
|---|---|---|
| `accordion` | Questions that open. | `thumbnails/faq/accordion.png` |
| `two_column` | Questions and answers side by side. | `thumbnails/faq/two_column.png` |

## Props

| Prop | Type | Required | What to write |
|---|---|---|---|
| `heading` | text per locale |  | E.g. "Questions". One entry per site locale, at most 80 characters each. |
| `items` | list (1–12) of object | yes | The questions, one to twelve. |
| `items[].question` | text per locale | yes | A question customers ask. One entry per site locale, at most 120 characters each. |
| `items[].answer` | text per locale | yes | The answer, from facts only; otherwise invite them to ask. One entry per site locale, at most 600 characters each. |
| `items[].factIds` | list (0–10) of string |  | The facts the answer states. |

## Examples

- Good: Do you cut keys? — Yes, on site, during opening hours. / Faites-vous les clés ? — Oui, sur place, aux heures d’ouverture.
- Bad: Is parking free? — Yes, always. / Le parking est-il gratuit ? — Oui, toujours.
