# Hours (`hours`)

Opening hours from the contact facts.

## Use it

- When the opening hours are known.

## Avoid

- Guessing hours; without them, invite visitors to call.

## Variants

| Variant | When | Preview |
|---|---|---|
| `table` | A table of the week. | `thumbnails/hours/table.png` |
| `compact` | Days grouped on a few lines. | `thumbnails/hours/compact.png` |

## Shape

A block is `{ "id", "type": "hours", "variant", "props" }`: `id` is 6–32 URL-safe characters, unique in the site; every
localized text has an entry for every site locale.

## Props

| Prop | Type | Required | What to write |
|---|---|---|---|
| `heading` | text per locale |  | E.g. "Opening hours". One entry per site locale, at most 80 characters each. |
| `note` | text per locale |  | An extra line. One entry per site locale, at most 200 characters each. |

## Examples

- Good: Tue–Sat 09:00–18:00 / Mar.–sam. 9 h–18 h
- Bad: Usually open in the morning / En général ouvert le matin

A valid block (from a fixture site):

```json
{
  "id": "hour-cont1",
  "type": "hours",
  "variant": "table",
  "props": {}
}
```
