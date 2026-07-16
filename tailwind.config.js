/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        /* NIGHTRAID dark theme palette — charcoal background, white text, neon lime accents */
        paper: '#0A0A0A',
        'paper-deep': '#141414',
        ink: '#FFFFFF',
        wine: '#0C0607',
        deep: '#000000',
        coal: '#050505',
        blood: '#E3262E',
        'blood-deep': '#A81B21',
        bone: '#F4F1EA',
        ash: '#8A8A8A',
        line: 'rgba(255,255,255,0.14)',
        haze: 'rgba(255,255,255,0.08)',
      },
      fontFamily: {
        display: ['Anton', 'Impact', 'sans-serif'],
        serif: ['"Instrument Serif"', 'Georgia', 'serif'],
        body: ['Archivo', 'system-ui', 'sans-serif'],
        /* Legacy alias — small technical labels render in the body grotesk */
        mono: ['Archivo', 'system-ui', 'sans-serif'],
      },
      letterSpacing: {
        label: '0.22em',
        wide2: '0.14em',
      },
      transitionTimingFunction: {
        cine: 'cubic-bezier(0.65, 0.05, 0, 1)',
      },
      transitionDuration: {
        400: '400ms',
      },
      zIndex: {
        60: '60',
        70: '70',
        80: '80',
      },
    },
  },
  plugins: [],
}
