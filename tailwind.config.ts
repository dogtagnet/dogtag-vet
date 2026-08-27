import type {Config} from "tailwindcss";

// Tailwind utilities are thin wrappers around the CSS custom properties defined in
// src/app/globals.css - that file is the single source of truth for every color value in this
// repo. Nothing in this config (or anywhere else) hardcodes a hex color; see design-system.md.
const config: Config = {
  darkMode: "class",
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "var(--bg)",
        surface: "var(--surface)",
        "surface-2": "var(--surface-2)",
        border: {
          DEFAULT: "var(--border)",
          strong: "var(--border-strong)",
        },
        ink: {
          DEFAULT: "var(--ink)",
          muted: "var(--ink-muted)",
          faint: "var(--ink-faint)",
        },
        brand: {
          DEFAULT: "var(--brand)",
          soft: "var(--brand-soft)",
        },
        link: "var(--link)",
        focus: "var(--focus)",
        ok: {DEFAULT: "var(--ok)", soft: "var(--ok-soft)"},
        warn: {DEFAULT: "var(--warn)", soft: "var(--warn-soft)"},
        danger: {DEFAULT: "var(--danger)", soft: "var(--danger-soft)"},
        info: {DEFAULT: "var(--info)", soft: "var(--info-soft)"},
        "neutral-status": {DEFAULT: "var(--neutral-status)", soft: "var(--neutral-status-soft)"},
        "qr-paper": "var(--qr-paper)",
      },
      fontFamily: {
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
        mono: ["var(--font-jetbrains-mono)", "ui-monospace", "monospace"],
      },
      fontSize: {
        caption: ["12px", {lineHeight: "16px"}],
        "table-body": ["13px", {lineHeight: "18px"}],
        body: ["14px", {lineHeight: "20px"}],
        emphasized: ["16px", {lineHeight: "22px"}],
        "section-title": ["20px", {lineHeight: "26px", fontWeight: "600"}],
        "page-title": ["24px", {lineHeight: "30px", fontWeight: "700"}],
        hero: ["32px", {lineHeight: "38px", fontWeight: "700"}],
      },
      borderRadius: {
        control: "6px",
        card: "10px",
        badge: "999px",
      },
      boxShadow: {
        card: "0 1px 2px rgba(22,32,43,.06)",
        raised: "0 4px 16px rgba(22,32,43,.06)",
      },
      spacing: {
        18: "4.5rem",
      },
    },
  },
  plugins: [],
};

export default config;
