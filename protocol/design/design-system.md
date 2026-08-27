# DogTag design system

One visual language across the admin platform, the vet platform, and both mobile apps.
The reference feeling is a professional block explorer: data-dense, calm, instantly legible, zero decoration that does not carry information.
Every surface ships light and dark themes.

## Principles

1. Data first: tables, key-value panels, and timelines are the primary surfaces; marketing flourish is banned inside the product.
2. On-chain facts look on-chain: every address, hash, root, and tx id renders in mono with middle truncation and a copy affordance, and links to the explorer where one exists.
3. State is always visible: everything with a lifecycle (entity, tag, payment, appointment, deployment) shows a status badge from the shared status palette.
4. Both themes are first-class: tokens only, no hardcoded colors in components; contrast >= WCAG AA in both themes.
5. Density with breathing room: 8px spacing grid, compact rows (44px touch targets on mobile, 40px rows on web tables).

## Tokens

Semantic tokens, expressed as CSS variables on the web and as theme objects on mobile.
Light values first, dark values second.

### Neutrals and surfaces

- `--bg`: #F6F7F9 / #0D1117 (page background)
- `--surface`: #FFFFFF / #161B22 (cards, tables)
- `--surface-2`: #EEF1F4 / #1F2630 (table headers, wells, code)
- `--border`: #D8DEE5 / #2C333D
- `--border-strong`: #B7C0CB / #414B58
- `--ink`: #16202B / #E6EBF1 (primary text)
- `--ink-muted`: #5B6773 / #93A0AE (secondary text)
- `--ink-faint`: #8A95A1 / #6B7683 (tertiary, placeholders)

### Brand and accents

- `--brand`: #0E6E63 / #2FB3A4 (DogTag teal: primary actions, active nav, links on hover)
- `--brand-soft`: #DCEFEC / #123A35 (selected rows, chips)
- `--link`: #0B62A4 / #58A6E8 (hyperlinks, tx/address links)
- `--focus`: #0B62A4 at 40% ring / #58A6E8 at 40% ring

### Status palette (shared meanings everywhere)

- `--ok`: #1F7A44 / #4CC38A with soft #DFF0E6 / #12271C (Active, Paid, Confirmed, Deployed)
- `--warn`: #9A6B00 / #E2B93B with soft #F7ECCE / #2E2510 (Pending, Awaiting review, Low balance)
- `--danger`: #B42331 / #F07178 with soft #F8DEE0 / #331418 (Revoked, Failed, Cancelled, Overdue)
- `--info`: #275FBF / #7AA7F0 with soft #DFE8F8 / #14213A (Submitted, In progress, Syncing)
- `--neutral-status`: #5B6773 / #93A0AE with soft #E7EBEF / #232B34 (Draft, Archived, Expired)

### Typography

- Web UI: Inter (400/500/600/700), fallback system-ui.
- Web mono: JetBrains Mono (400/500), fallback ui-monospace.
- iOS: SF Pro Text / SF Mono.
- Android: Roboto / JetBrains Mono (bundled).
- Scale (web): 12 caption, 13 table body, 14 body, 16 emphasized body, 20 section title, 24 page title, 32 hero number.
- Mobile scale: platform-native dynamic type mapped to the same roles.
- Hashes, addresses, ids, amounts: always mono, tabular numerals for amounts.

### Geometry

- Radius: 6px controls, 10px cards, 999px badges.
- Shadows: light theme only, 0 1px 2px rgba(22,32,43,.06) and 0 4px 16px rgba(22,32,43,.06); dark theme uses borders, not shadows.
- Spacing grid: 4/8/12/16/24/32/48.

## Core components (every platform implements its native equivalent)

- AddressChip: `0x1234...ABCD` mono, copy on tap or click, optional explorer link, optional ENS-style label above.
- HashCell: same treatment for roots, tx hashes, document hashes.
- StatusBadge: soft background + strong text from the status palette, dot prefix, never color-only (always a word).
- KeyValuePanel: two-column definition list for entity profiles, tag details, payment details.
- DataTable: sticky header, mono columns for chain data, row hover, empty state with one-line guidance, pagination or infinite scroll, per-column alignment (numbers right).
- Timeline: for on-chain event history and audit trails; each entry has timestamp, actor chip, event name, tx link.
- Banner and Snackbar: for setup prompts (deploy registry, deploy factory, fund contract) and transient results; banners are dismiss-persistent per condition, never nagging.
- FormSection: titled groups with helper text; validation inline under fields; primary action fixed bottom-right on web, bottom bar on mobile.
- QR surfaces: white quiet zone always (even in dark theme), caption with expiry countdown for one-time tokens.
- Theme toggle: system / light / dark tri-state, persisted per user.

## Voice

Labels are nouns, buttons are verbs, errors say what happened and what to do next.
No exclamation marks in product copy.
Privacy copy follows `docs/crypto-improvements-v2.md` C8: owner hidden, tag history public, said plainly.
