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
        // Primary brand — deep indigo-blue, not generic flat blue
        primary: {
          DEFAULT: '#4f46e5',
          50: '#eef2ff', 100: '#e0e7ff', 200: '#c7d2fe', 300: '#a5b4fc',
          400: '#818cf8', 500: '#4f46e5', 600: '#4338ca', 700: '#3730a3',
          800: '#312e81', 900: '#1e1b4b',
        },
        // Success
        success: { DEFAULT: '#10b981', light: '#d1fae5', dark: '#059669' },
        // Warning
        warning: { DEFAULT: '#f59e0b', light: '#fef3c7', dark: '#d97706' },
        // Danger
        danger: { DEFAULT: '#ef4444', light: '#fee2e2', dark: '#dc2626' },
        // Purple accent
        purple: { DEFAULT: '#8b5cf6', light: '#ede9fe', dark: '#7c3aed' },
        // Teal accent
        teal: { DEFAULT: '#14b8a6', light: '#ccfbf1', dark: '#0d9488' },

        // Sidebar — exact Monday.com colors
        sidebar: {
          bg: '#f6f7fb',
          hover: '#dcdfec',
          active: '#cce5ff',
          text: '#676879',
          'text-active': '#323338',
          border: '#e6e9ef',
          accent: '#0073ea',
        },

        // Surfaces — warm neutrals, not cold gray
        surface: {
          DEFAULT: '#f8fafc',
          50: '#f8fafc',
          100: '#f1f5f9',
          200: '#e2e8f0',
          300: '#cbd5e1',
        },

        // Borders
        border: {
          DEFAULT: '#e2e8f0',
          light: '#f1f5f9',
          dark: '#cbd5e1',
        },

        // Text — Monday.com exact colors
        'text-primary': '#323338',
        'text-secondary': '#676879',
        'text-tertiary': '#c5c7d0',
        'text-muted': '#c4c4c4',

        // Status colors — richer
        'status-not-started': '#94a3b8',
        'status-in-progress': '#3b82f6',
        'status-review': '#8b5cf6',
        'status-done': '#10b981',
        'status-stuck': '#ef4444',
        'status-on-hold': '#f59e0b',
      },

      fontFamily: {
        sans: ['Figtree', 'Roboto', 'Noto Sans', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
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
        'sm': '4px',
        'DEFAULT': '6px',
        'md': '8px',
        'lg': '10px',
        'xl': '12px',
        '2xl': '16px',
        '3xl': '20px',
      },

      boxShadow: {
        'xs': '0 1px 2px rgba(0,0,0,0.04)',
        'sm': '0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)',
        'DEFAULT': '0 2px 8px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)',
        'md': '0 4px 12px rgba(0,0,0,0.07), 0 1px 3px rgba(0,0,0,0.05)',
        'lg': '0 8px 24px rgba(0,0,0,0.08), 0 2px 6px rgba(0,0,0,0.04)',
        'xl': '0 16px 48px rgba(0,0,0,0.1), 0 4px 12px rgba(0,0,0,0.05)',
        'card': '0 1px 3px rgba(0,0,0,0.04), 0 1px 2px rgba(0,0,0,0.02)',
        'card-hover': '0 4px 16px rgba(0,0,0,0.08), 0 1px 4px rgba(0,0,0,0.04)',
        'dropdown': '0 8px 30px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.06)',
        'modal': '0 20px 60px rgba(0,0,0,0.15), 0 4px 16px rgba(0,0,0,0.08)',
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
