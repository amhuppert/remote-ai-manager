/**
 * PostCSS config for the Next app (Tailwind v4 toolchain integration).
 *
 * `@tailwindcss/postcss` processes the `@import "tailwindcss/..."` layer imports
 * and `@theme` directives in `src/app/globals.css`. Turbopack (Next 16 dev +
 * build) auto-detects this file. Preflight is intentionally NOT imported in
 * globals.css — CC's own `reset.css` remains the single base reset until the
 * Stage B cleanup reconciles it.
 */
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
