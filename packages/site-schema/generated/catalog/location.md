# Location (`location`)

Where the business is, with a map and directions.

## Use it

- With an address or coordinates from the facts.

## Avoid

- A map without a known location.

## Variants

| Variant | When | Preview |
|---|---|---|
| `map_split` | Map beside the address. | `thumbnails/location/map_split.png` |
| `map_full` | A full-width map. | `thumbnails/location/map_full.png` |
| `address_only` | The address and a directions button, no map. | `thumbnails/location/address_only.png` |

## Props

| Prop | Type | Required | What to write |
|---|---|---|---|
| `heading` | text per locale |  | E.g. "Find us". One entry per site locale, at most 80 characters each. |
| `showDirections` | boolean | yes | Show a directions button (needs an address or coordinates). |
| `note` | text per locale |  | E.g. "Parking behind the shop". One entry per site locale, at most 200 characters each. |

## Examples

- Good: Find us: 12 rue du Port, Gustavia / Nous trouver : 12 rue du Port, Gustavia
- Bad: Near the beach / Près de la plage
