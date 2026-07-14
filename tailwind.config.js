/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
      },
      colors: {
        ink: {
          50: '#f6f7f9',
          100: '#eceef2',
          200: '#d5dae2',
          300: '#b0b9c8',
          400: '#8593a8',
          500: '#66748d',
          600: '#515d74',
          700: '#434c5e',
          800: '#3a4250',
          900: '#343945',
          950: '#22252d',
        },
      },
      boxShadow: {
        card: '0 1px 2px rgba(16,24,40,.04), 0 1px 3px rgba(16,24,40,.06)',
      },
    },
  },
  plugins: [],
}
