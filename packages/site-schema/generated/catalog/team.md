# Team (`team`)

People the business presents publicly.

## Use it

- Team-member facts only, with their published role.

## Avoid

- Inventing people or roles.

## Variants

| Variant | When | Preview |
|---|---|---|
| `grid` | A grid of portraits. | `thumbnails/team/grid.png` |
| `list` | A list with roles. | `thumbnails/team/list.png` |

## Props

| Prop | Type | Required | What to write |
|---|---|---|---|
| `heading` | text per locale |  | E.g. "The team". One entry per site locale, at most 80 characters each. |
| `members` | list (1–12) of object | yes | The people, as the business presents them. |
| `members[].factId` | string | yes | The team-member fact. Required. |
| `members[].name` | text (≤ 60) | yes | The name as the business presents it, e.g. "Léa M.". |
| `members[].role` | text per locale |  | E.g. "Head chef". One entry per site locale, at most 60 characters each. |
| `members[].photoAssetId` | string |  | The id of an asset in `assets`. |

## Examples

- Good: Léa M. — Manager / Léa M. — Gérante
- Bad: Our expert team of 20 / Notre équipe de 20 experts
