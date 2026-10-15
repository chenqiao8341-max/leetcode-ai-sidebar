// Paint the previously selected palette before loading the conversation UI.
// This cache contains a theme name only; chrome.storage remains authoritative.
(() => {
  try {
    const allowed=['light','dark','warm','lavender','system'];
    let theme=localStorage.getItem('lc-appearance-theme-v1');
    if(!allowed.includes(theme))theme='light';
    document.documentElement.dataset.theme=theme==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):theme;
  }catch{document.documentElement.dataset.theme='light';}
})();
