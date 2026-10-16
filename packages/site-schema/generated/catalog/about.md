# About (`about`)

Who the business is, in two or three short factual paragraphs.

## Use it

- What the facts say: place, specialities, who runs it.

## Avoid

- Invented history, years or awards.
- Marketing filler.

## Variants

| Variant | When | Preview |
|---|---|---|
| `split` | Text beside a photo. | `thumbnails/about/split.png` |
| `centered` | Centred text only. | `thumbnails/about/centered.png` |
| `story` | Wider text with a large photo, for businesses with a story the facts tell. | `thumbnails/about/story.png` |

## Props

| Prop | Type | Required | What to write |
|---|---|---|---|
| `heading` | text per locale | yes | E.g. "About us". One entry per site locale, at most 80 characters each. |
| `body` | text per locale | yes | Two or three short paragraphs (blank line between) on the business. Facts only. One entry per site locale, at most 1500 characters each. |
| `imageAssetId` | string |  | The id of an asset in `assets`. |
| `factIds` | list (0–20) of string |  | The facts the text states (years, origins…). |

## Examples

- Good: On the quai des Indes, we advise homeowners and tradespeople. / Sur le quai des Indes, nous conseillons particuliers et artisans.
- Bad: Founded in 1970 by a passionate family… / Fondée en 1970 par une famille passionnée…
