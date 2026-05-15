/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Primary brand — Monday blue (#0073ea) per generic_monday_ui.md §1.1.
        // The 50–900 ramp is tuned around that hue so utilities like
        // `bg-primary-50` and `text-primary-700` stay coherent.
        primary: {
          DEFAULT: '#0073ea',
          50:  '#f0f7ff',
          100: '#cce5ff',
          200: '#aed4fc',
          300: '#7fbcf8',
          400: '#3d99f0',
          500: '#0073ea',
          600: '#0060b9',
          700: '#004f99',
          800: '#003f7a',
          900: '#002e5c',
        },
        // Status — values from skill §1.5
        success: { DEFAULT: '#00854d', light: '#bbdbc9', dark: '#007038' },
        warning: { DEFAULT: '#ffcb00', light: '#fceba1', dark: '#eaaa15' },
        danger:  { DEFAULT: '#d83a52', light: '#f4c3cb', dark: '#b63546' },
        // Accents kept for legacy call sites; not part of the spec.
        purple: { DEFAULT: '#8b5cf6', light: '#ede9fe', dark: '#7c3aed' },
        teal: { DEFAULT: '#14b8a6', light: '#ccfbf1', dark: '#0d9488' },

        // Sidebar — uses CSS variables so light/dark mode auto-adapts
        sidebar: {
          bg: 'var(--sidebar-bg)',
          hover: 'var(--sidebar-hover)',
          active: 'var(--sidebar-active)',
          text: 'rgb(var(--sidebar-text) / <alpha-value>)',
          'text-active': 'var(--sidebar-text-active)',
          border: 'var(--sidebar-border)',
          accent: 'rgb(var(--sidebar-accent) / <alpha-value>)',
        },

        // Surfaces — uses CSS variables for theme adaptation
        surface: {
          DEFAULT: 'var(--surface)',
          50: 'var(--surface-50)',
          100: 'var(--surface-100)',
          200: 'var(--surface-200)',
          300: 'var(--surface-300)',
        },

        // Borders — uses CSS variables for theme adaptation
        border: {
          DEFAULT: 'var(--border-color)',
          light: 'var(--border-light)',
          dark: 'var(--border-dark)',
        },

        // Text — uses CSS variables for theme adaptation
        'text-primary': 'var(--text-primary)',
        'text-secondary': 'var(--text-secondary)',
        'text-tertiary': 'var(--text-tertiary)',
        'text-muted': 'var(--text-muted)',

        // Status colors — richer
        'status-not-started': '#94a3b8',
        'status-in-progress': '#3b82f6',
        'status-review': '#8b5cf6',
        'status-done': '#10b981',
        'status-stuck': '#ef4444',
        'status-on-hold': '#f59e0b',
      },

      fontFamily: {
        // Body / UI — skill §2.1 --font-family
        sans: ['Figtree', 'Roboto', 'Noto Sans Hebrew', 'Noto Kufi Arabic', 'Noto Sans JP', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
        // Headings (H1–H4) — skill §2.1 --title-font-family
        title: ['Poppins', 'Roboto', 'Noto Sans Hebrew', 'Noto Kufi Arabic', 'Noto Sans JP', 'sans-serif'],
      },

      fontSize: {
        'xxs': ['0.625rem', { lineHeight: '0.875rem' }],    // 10px
        'xs': ['0.75rem', { lineHeight: '1rem' }],           // 12px
        'sm': ['0.8125rem', { lineHeight: '1.25rem' }],      // 13px
        'base': ['0.875rem', { lineHeight: '1.375rem' }],    // 14px
        'md': ['0.9375rem', { lineHeight: '1.5rem' }],       // 15px
        'lg': ['1.0625rem', { lineHeight: '1.625rem' }],     // 17px
        'xl': ['1.25rem', { lineHeight: '1.75rem' }],        // 20px
        '2xl': ['1.5rem', { lineHeight: '2rem' }],           // 24px
        '3xl': ['1.875rem', { lineHeight: '2.25rem' }],      // 30px
      },

      borderRadius: {
        // Spec §3.2 — three canonical radii. Tailwind aliases preserved
        // for back-compat; sm/2xl now map to the spec values.
        'sm': '4px',          // --border-radius-small
        'DEFAULT': '6px',
        'md': '8px',          // --border-radius-medium
        'lg': '10px',
        'xl': '12px',
        '2xl': '16px',        // --border-radius-big
        '3xl': '20px',
      },

      boxShadow: {
        // Spec §3.3 — four canonical elevations. Aliases mapped onto them
        // so `shadow-md`, `shadow-dropdown`, `shadow-modal` etc. produce
        // skill-consistent depth.
        'xs': '0 4px 6px -4px rgba(0,0,0,0.1)',                      // --box-shadow-xs
        'sm': '0 4px 8px rgba(0,0,0,0.2)',                           // --box-shadow-small
        'DEFAULT': '0 4px 8px rgba(0,0,0,0.2)',
        'md': '0 6px 20px rgba(0,0,0,0.2)',                          // --box-shadow-medium
        'lg': '0 15px 50px rgba(0,0,0,0.3)',                         // --box-shadow-large
        'xl': '0 15px 50px rgba(0,0,0,0.3)',
        'card': '0 4px 6px -4px rgba(0,0,0,0.1)',
        'card-hover': '0 4px 8px rgba(0,0,0,0.2)',
        'dropdown': '0 6px 20px rgba(0,0,0,0.2)',
        'modal': '0 15px 50px rgba(0,0,0,0.3)',
        'inner-glow': 'inset 0 1px 0 rgba(255,255,255,0.05)',
        'sidebar': '2px 0 8px rgba(0,0,0,0.08)',
      },

      spacing: {
        '4.5': '1.125rem',
        '13': '3.25rem',
        '15': '3.75rem',
        '18': '4.5rem',
        '68': '17rem',
        '72': '18rem',
        '76': '19rem',
        '84': '21rem',
      },

      animation: {
        'slide-in': 'slideIn 0.25s cubic-bezier(0.16, 1, 0.3, 1)',
        'slide-in-right': 'slideInRight 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
        'slide-out-right': 'slideOutRight 0.2s cubic-bezier(0.4, 0, 1, 1)',
        'fade-in': 'fadeIn 0.2s ease-out',
        'fade-in-up': 'fadeInUp 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
        'scale-in': 'scaleIn 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
        'slide-up': 'slideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
        'pulse-soft': 'pulseSoft 2s ease-in-out infinite',
        'shimmer': 'shimmer 1.5s ease-in-out infinite',
        'spin-slow': 'spin 2s linear infinite',
      },

      keyframes: {
        slideIn: {
          '0%': { transform: 'translateY(8px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        slideInRight: {
          '0%': { transform: 'translateX(100%)', opacity: '0' },
          '100%': { transform: 'translateX(0)', opacity: '1' },
        },
        slideOutRight: {
          '0%': { transform: 'translateX(0)', opacity: '1' },
          '100%': { transform: 'translateX(100%)', opacity: '0' },
        },
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        fadeInUp: {
          '0%': { opacity: '0', transform: 'translateY(12px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        scaleIn: {
          '0%': { transform: 'scale(0.95)', opacity: '0' },
          '100%': { transform: 'scale(1)', opacity: '1' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translate(-50%, 12px)' },
          '100%': { opacity: '1', transform: 'translate(-50%, 0)' },
        },
        pulseSoft: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.5' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },

      transitionTimingFunction: {
        'smooth': 'cubic-bezier(0.16, 1, 0.3, 1)',
        'bounce': 'cubic-bezier(0.68, -0.55, 0.265, 1.55)',
      },

      backdropBlur: {
        'xs': '2px',
      },
    },
  },
  plugins: [],
}
