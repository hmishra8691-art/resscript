/** Tailwind v4 is a PostCSS plugin; there is no `tailwind.config.js` — the theme lives in
 * `src/app/globals.css` behind `@theme`, which is why the design tokens are CSS variables
 * (UI §11: "dark mode is a variable swap rather than a `dark:` variant on every element"). */
const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};

export default config;
