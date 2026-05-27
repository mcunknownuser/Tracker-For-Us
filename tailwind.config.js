/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        serif: ['"Playfair Display"', 'Georgia', 'serif'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      // Use Tailwind's built-in `neutral` palette as the source of truth for
      // backgrounds, borders, and text. No brand colors — the design is
      // intentionally monochrome and editorial. Accents come from typography
      // and spacing, not color.
      letterSpacing: {
        widest: '0.25em',
        editorial: '0.4em',
      },
      // Subtle page/step transitions for the onboarding wizard, auth flow,
      // and modals. Keep these short — content shouldn't feel slow.
      keyframes: {
        'fade-in':       { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
        'fade-in-up':    {
          '0%':   { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-in-down':  {
          '0%':   { opacity: '0', transform: 'translateY(-8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'shimmer': {
          '0%':   { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(100%)' },
        },
      },
      animation: {
        'fade-in':      'fade-in 260ms ease-out both',
        'fade-in-up':   'fade-in-up 320ms cubic-bezier(0.22, 0.61, 0.36, 1) both',
        'fade-in-down': 'fade-in-down 320ms cubic-bezier(0.22, 0.61, 0.36, 1) both',
        'shimmer':      'shimmer 1.4s linear infinite',
      },
    },
  },
  plugins: [],
};
