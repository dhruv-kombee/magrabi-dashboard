import type { Theme } from '../hooks/useTheme'
import styles from './ThemeToggle.module.css'

/** Lightbulb icon toggle -- lit/filled in dark mode (the "light is on" reading), outline in light
 * mode. A plain inline SVG rather than an emoji character, so it renders crisply and consistently
 * regardless of the OS emoji font.
 *
 * Takes theme/toggle as props rather than calling useTheme() itself -- this component only renders
 * post-login (inside NavHeader), but the theme must apply on the pre-login page too, so the hook
 * itself is called once, unconditionally, at the App root instead. */
export function ThemeToggle({ theme, toggle }: { theme: Theme; toggle: () => void }) {
  const isDark = theme === 'dark'

  return (
    <button
      className={`${styles.button} ${isDark ? styles.on : ''}`}
      onClick={toggle}
      title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      aria-label="Toggle dark mode"
    >
      {isDark ? (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2a7 7 0 0 0-4 12.74V17a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-2.26A7 7 0 0 0 12 2zM9 20a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1v-1H9v1z" />
        </svg>
      ) : (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M12 2a7 7 0 0 0-4 12.74V17a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-2.26A7 7 0 0 0 12 2z" />
          <path d="M9 20a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1v-1H9v1z" />
        </svg>
      )}
    </button>
  )
}
