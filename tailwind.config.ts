import type { Config } from "tailwindcss";

/**
 * Identidade visual — Leão Amorim Tecnologia.
 * Azul-marinho #1E2D5A como base institucional e a cor de marca/ação em
 * azul #4F7CFF → ciano #26D5EE (gradiente oficial do site da marca).
 */
const config: Config = {
  // Tema claro/escuro por classe .dark no <html> (alternado pelo botão de tema).
  darkMode: "class",
  content: [
    "./src/app/**/*.{ts,tsx}",
    "./src/components/**/*.{ts,tsx}",
    "./src/emails/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        marinho: {
          DEFAULT: "#1E2D5A",
          50: "#EDF0F7",
          100: "#D6DCEC",
          200: "#AEB9D8",
          300: "#8595C4",
          400: "#5D72B0",
          500: "#3E538F",
          600: "#2C3E6F",
          700: "#1E2D5A",
          800: "#182448",
          900: "#111A34",
        },
        // Cor de marca/ação — azul oficial Leão Amorim Tecnologia (#4F7CFF).
        marca: {
          DEFAULT: "#4F7CFF",
          50: "#EEF4FF",
          100: "#DBE6FF",
          200: "#BDD0FF",
          300: "#94B2FF",
          400: "#6E93FF",
          500: "#4F7CFF",
          600: "#3A63D8",
          700: "#2C4CAB",
          800: "#223B84",
          900: "#1B2F68",
        },
        // Extremo ciano do gradiente da marca.
        ciano: { DEFAULT: "#26D5EE", 300: "#7FE6F6", 500: "#26D5EE" },
        alerta: {
          DEFAULT: "#B42318",
          50: "#FEF3F2",
          100: "#FEE4E2",
          500: "#F04438",
          700: "#B42318",
        },
        sucesso: { DEFAULT: "#067647", 50: "#ECFDF3", 100: "#DCFAE6" },
        atencao: { DEFAULT: "#B54708", 50: "#FFFAEB", 100: "#FEF0C7" },
        /**
         * Escala neutra REATIVA AO TEMA: os valores vêm de CSS variables
         * definidas em globals.css (:root = claro, .dark = escuro invertido).
         * Assim todo `text-neutro-*`, `bg-neutro-*` e `border-neutro-*` do app
         * se adapta automaticamente, sem precisar de variante `dark:` em cada uso.
         */
        neutro: {
          50: "rgb(var(--n-50) / <alpha-value>)",
          100: "rgb(var(--n-100) / <alpha-value>)",
          200: "rgb(var(--n-200) / <alpha-value>)",
          300: "rgb(var(--n-300) / <alpha-value>)",
          400: "rgb(var(--n-400) / <alpha-value>)",
          500: "rgb(var(--n-500) / <alpha-value>)",
          600: "rgb(var(--n-600) / <alpha-value>)",
          700: "rgb(var(--n-700) / <alpha-value>)",
          800: "rgb(var(--n-800) / <alpha-value>)",
          900: "rgb(var(--n-900) / <alpha-value>)",
        },
        // Superfície de cartões/barras (branca no claro, escura no escuro).
        superficie: "rgb(var(--superficie) / <alpha-value>)",
      },
      fontFamily: {
        // Mesmas famílias do site da marca (auto-hospedadas em src/app/fonts).
        sans: ["var(--font-body)", "Inter", "system-ui", "sans-serif"],
        display: ["var(--font-display)", "Space Grotesk", "Segoe UI", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "JetBrains Mono", "SFMono-Regular", "monospace"],
      },
      borderRadius: {
        xl: "0.875rem",
        "2xl": "1.25rem",
      },
      boxShadow: {
        card: "0 1px 2px rgba(16,24,40,0.05), 0 1px 3px rgba(16,24,40,0.1)",
        elevada: "0 12px 32px -8px rgba(30,45,90,0.25)",
      },
    },
  },
  plugins: [],
};

export default config;
