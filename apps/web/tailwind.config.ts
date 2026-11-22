import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // WhatsApp-derived palette: the green is the product's anchor colour.
        wa: {
          green: '#128C7E',
          greenDark: '#075E54',
          greenLight: '#25D366',
          teal: '#128C7E',
          bubbleIn: '#FFFFFF',
          bubbleOut: '#DCF8C6',
          panel: '#F0F2F5',
          header: '#075E54',
          tick: '#53BDEB',
        },
        admin: {
          bg: '#0B0F14',
          panel: '#121A22',
          line: '#1F2A35',
          accent: '#128C7E',
        },
      },
      fontFamily: {
        sans: ['Segoe UI', 'Helvetica Neue', 'Helvetica', 'Arial', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      animation: {
        'fade-in': 'fadeIn 160ms ease-out',
      },
      keyframes: {
        fadeIn: { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
      },
    },
  },
  plugins: [],
};

export default config;
