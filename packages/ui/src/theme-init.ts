/** localStorage key of the persisted theme choice (next-themes); client-only, never sent to a server. */
export const THEME_STORAGE_KEY = 'bw-theme';

/**
 * Blocking script for `<head>`: sets the `.dark`/`.light` class before the first paint, from the stored choice or the
 * device's colour scheme. next-themes' own script sits in the body, so a streamed page could paint (and keep) the wrong
 * theme until hydration; this one runs first on every load, the same rule next-themes applies afterwards.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var t=null;try{t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});}catch(e){}var d=t==='dark'||(t!=='light'&&window.matchMedia('(prefers-color-scheme: dark)').matches);var r=document.documentElement;r.classList.remove('light','dark');r.classList.add(d?'dark':'light');r.style.colorScheme=d?'dark':'light';}catch(e){}})();`;
