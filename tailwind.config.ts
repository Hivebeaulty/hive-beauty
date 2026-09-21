import type { Config } from "tailwindcss";

// Paleta extraída por amostragem de pixel do logo Hive Beauty.
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        blush: {
          50: "#FBF1EA",
          100: "#F5DDCF", // fundo de destaque (cor de fundo do logo)
          200: "#EFCBB8",
        },
        plum: {
          400: "#9C6E7B",
          500: "#885563", // cor primária da marca (hexágonos + "beauty")
          600: "#6E4451",
          700: "#563441",
        },
        charcoal: {
          500: "#6B6570",
          700: "#524C54",
          900: "#464248", // cor do texto "hive"
        },
        success: "#7A9B76",
        warning: "#C98A4B",
        danger: "#B85C5C",
      },
      fontFamily: {
        // Sans arredondada para ecoar o lettering do logo (dot circular no "i").
        sans: ["Quicksand", "Poppins", "system-ui", "sans-serif"],
      },
      borderRadius: {
        xl: "1rem",
        "2xl": "1.5rem",
      },
    },
  },
  plugins: [],
};

export default config;
