# Spawn-card Tailwind migration — visual parity evidence

Before/after screenshots for the spawn-card surface, captured from the
`Spawn Card/SpawnCard` Storybook stories at the conventions-doc fixed viewports
(device-scale-factor 1):

- **desktop** = 1440 × 900
- **mobile** = 390 × 844

`before-*` = pre-migration rendering (migration temporarily stashed); `after-*` =
the shipped rendering. Each image is element-cropped to
`section[aria-label="Spawn proposal"]`.

States covered:

| State | Story / interaction |
|---|---|
| `multi` | MultiSession — header count badge, 3 rows (agent + mode chips), Edit/Create |
| `edit` | MultiSession after clicking Edit — the edit-form grid + field captions + inputs |
| `invalid` | Invalid — amber accent border + issue list |

Result: every before/after pair matches at both viewports, including the mobile
44px touch target on the Edit/Create action buttons. Cropped card dimensions
(before vs after) are identical for all six pairs:

| Pair | Desktop | Mobile |
|---|---|---|
| multi | 1410×241 | 360×280 |
| edit | 1410×749 | 360×766 |
| invalid | 1410×80 | 360×96 |

> Mobile touch target: below the 768px spine the action buttons must be 44px
> tall. A primitive's box height is not reattachable through `layoutClassName`,
> so the action row supplies it from its own flex box (`max-768:min-h-[44px]
> max-768:items-stretch`), per the conventions doc §8.1.

> Evidence location: the conventions doc (§4) nominates
> `docs/reports/visual/<slice>/`, but this surface's task ownership restricts
> writes to `src/features/_root/spawn-card/` and forbids `docs/reports/*`. Spec
> tasks (source rank 3) outrank the conventions doc (rank 4), so the evidence is
> homed here; integration may relocate it when it owns the shared report tree.
