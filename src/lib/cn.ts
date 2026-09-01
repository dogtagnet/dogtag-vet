import {extendTailwindMerge} from "tailwind-merge";

/**
 * WP4.7 A7 (width hygiene) - a `className` merge helper for exactly one reason: plain template-
 * string concatenation (`` `${base} ${override}` ``) puts BOTH a base utility and a caller's
 * override utility in the DOM's class list when they target the same CSS property (e.g. `w-full`
 * and a caller's `w-32`). Which one visually wins then depends on the two classes' order in the
 * COMPILED STYLESHEET, not on source/DOM order - not the caller's override, in general - which is
 * the root cause behind this codebase's `w-auto`/`!w-auto` override sites (see A7's plan section).
 * `twMerge` fixes this correctly: it drops the LOSING class from the output entirely, so a plain
 * (non-`!important`) override utility can never lose a specificity fight it was never entered into.
 *
 * This is `extendTailwindMerge`, not bare `twMerge`, for two concrete, empirically-verified reasons
 * (see the throwaway check script used to find these - deleted after use, not part of the repo):
 *
 * 1. Version semantics. `tailwind-merge`'s LATEST major (v3) models Tailwind CSS v4's utility
 *    semantics, where bare `outline` sets both outline-style AND outline-width, so it correctly
 *    conflicts with `outline-2`. This repo pins `tailwindcss@^3`, where `outline` (style only) and
 *    `outline-2` (width only) are separate, COMPOSABLE utilities - exactly the pattern this
 *    codebase's own focus ring uses (`focus-visible:outline focus-visible:outline-2
 *    focus-visible:outline-focus`, three separate declarations meant to combine). Bare v3-of-
 *    tailwind-merge's default config silently drops one of these three classes. Pinning to
 *    `tailwind-merge@^2` (the major aligned with Tailwind CSS v3) fixes this at the dependency
 *    version level - see this file's package.json entry.
 * 2. Custom theme values. `tailwind.config.ts`'s `theme.extend` defines this app's ENTIRE color,
 *    font-size, and border-radius scales (there are no hardcoded Tailwind default color/size
 *    utilities in use anywhere in this codebase - see that file's own doc comment). Even
 *    `tailwind-merge@^2`'s default config has no way to know these custom scale values exist, so
 *    without the `extend` below it silently mis-handles them - two confirmed failure modes, found
 *    by testing `baseControlClasses` (this app's shared form-control classes) through bare
 *    `twMerge` before wiring anything in:
 *      - `twMerge("text-ink text-body", "")` drops `text-body` entirely (font-size and text-color
 *        both key off the `text-` prefix; without knowing this app's custom font-size scale,
 *        tailwind-merge treats an unrecognized `text-body` as competing with the ALSO-unrecognized-
 *        as-a-real-Tailwind-color `text-ink` for the same "ambiguous text-*" slot).
 *      - `twMerge("rounded-control", "rounded-lg")` keeps BOTH (a real conflict that survives,
 *        defeating the entire point of merging) because `control` isn't a border-radius scale value
 *        tailwind-merge has ever heard of.
 *    The `extend.theme.colors`/`borderRadius` and `extend.classGroups['font-size']`/`shadow` below
 *    list this app's actual custom scale (kept in sync with `tailwind.config.ts` by hand - there is
 *    no way to import one config into the other, since `tailwind.config.ts` is consumed by the
 *    Tailwind CLI/PostCSS at build time and this file runs in both server and client bundles).
 *
 * If `tailwind.config.ts`'s `theme.extend` gains a new color, font-size, or border-radius key,
 * mirror it here or `cn()` will silently under-merge that new token exactly like the two cases
 * above.
 */
export const cn = extendTailwindMerge({
  extend: {
    theme: {
      colors: [
        "bg",
        "surface",
        "surface-2",
        "border",
        "border-strong",
        "ink",
        "ink-muted",
        "ink-faint",
        "brand",
        "brand-soft",
        "link",
        "focus",
        "ok",
        "ok-soft",
        "warn",
        "warn-soft",
        "danger",
        "danger-soft",
        "info",
        "info-soft",
        "neutral-status",
        "neutral-status-soft",
        "qr-paper",
      ],
      borderRadius: ["control", "card", "badge"],
    },
    classGroups: {
      "font-size": [{text: ["caption", "table-body", "body", "emphasized", "section-title", "page-title", "hero"]}],
      shadow: [{shadow: ["card", "raised"]}],
    },
  },
});
