import type { Config } from 'tailwindcss'
import animate from 'tailwindcss-animate'

// 蓝青磨砂玻璃主题，见 docs/SnStick-UI-UX-Design-Spec.md。
export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    container: { center: true, padding: '1rem' },
    extend: {
      colors: {
        // §6.0.1 色板 — CSS variables 见 src/index.css
        base:      'hsl(var(--base) / <alpha-value>)',
        surface:   'hsl(var(--surface) / <alpha-value>)',
        elevated:  'hsl(var(--elevated) / <alpha-value>)',
        border:    'hsl(var(--border) / <alpha-value>)',
        foreground: 'hsl(var(--fg-primary) / <alpha-value>)',
        secondary:  'hsl(var(--fg-secondary) / <alpha-value>)',
        muted:      'hsl(var(--fg-muted) / <alpha-value>)',
        accent:     'hsl(var(--accent) / <alpha-value>)',
        // A 股语义色:仅用于价格 / K 线,不用于 UI 状态
        bull:       'hsl(var(--bull) / <alpha-value>)',
        bear:       'hsl(var(--bear) / <alpha-value>)',
        warning:    'hsl(var(--warning) / <alpha-value>)',
        danger:     'hsl(var(--danger) / <alpha-value>)',
      },
      fontFamily: {
        sans: ['Inter', '"HarmonyOS Sans SC"', '"PingFang SC"', '"Microsoft YaHei UI"', '"Microsoft YaHei"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', '"IBM Plex Mono"', 'ui-monospace', 'monospace'],
      },
      borderRadius: {
        card: 'var(--radius-card)',
        btn: 'var(--radius-control)',
        input: 'var(--radius-input)',
        dialog: 'var(--radius-dialog)',
      },
      transitionTimingFunction: {
        // §6.0.4 Linear/Vercel 同款缓动
        smooth: 'cubic-bezier(0.16, 1, 0.3, 1)',
      },
    },
  },
  plugins: [animate],
} satisfies Config
