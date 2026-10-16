# Contact (`contact`)

How to reach the business: the channels it publishes and, optionally, the form.

## Use it

- Only channels present in the contact facts.

## Avoid

- Showing a channel the business does not publish.

## Variants

| Variant | When | Preview |
|---|---|---|
| `split` | Channels beside the form. | `thumbnails/contact/split.png` |
| `centered` | Channels centred, form below. | `thumbnails/contact/centered.png` |

## Props

| Prop | Type | Required | What to write |
|---|---|---|---|
| `heading` | text per locale | yes | E.g. "Contact us". One entry per site locale, at most 80 characters each. |
| `intro` | text per locale |  | One or two sentences introducing the section. One entry per site locale, at most 300 characters each. |
| `showForm` | boolean | yes | Show the contact form (needs `settings.contactForm.enabled`). |
| `channels` | object | yes | Which contact channels to list (only those present in `contact`). |
| `channels.phone` | boolean | yes | List the phone number. |
| `channels.email` | boolean | yes | List the e-mail address. |
| `channels.whatsapp` | boolean | yes | List WhatsApp. |

## Examples

- Good: Contact us / Nous contacter
- Bad: Call us 24/7! / Appelez-nous 24 h/24 !
