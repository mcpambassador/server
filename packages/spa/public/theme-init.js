/* global localStorage, window, document */
try {
  const stored = JSON.parse(localStorage.getItem('mcp-ambassador-theme') || '{}');
  const theme = stored?.state?.theme || 'system';
  const isDark =
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  if (isDark) document.documentElement.classList.add('dark');
} catch {
  /* ignore: fall back to default theme */
}
