export const THEME_IDS = ['light','dark','warm','lavender','system'];
export const THEME_CACHE = 'lc-appearance-theme-v1';
export function normalizeTheme(value) {return THEME_IDS.includes(value)?value:'light';}
export function resolveTheme(value,darkSystem=false) {const theme=normalizeTheme(value);return theme==='system'?(darkSystem?'dark':'light'):theme;}

export async function initializeAppearance({storage,changes,root=document.documentElement,media=matchMedia('(prefers-color-scheme: dark)'),cache=localStorage}={}) {
  let selected='light', revision=0, writes=Promise.resolve();
  const radios=[...document.querySelectorAll('input[name="theme"]')];
  const status=document.getElementById('appearance-status');
  function apply(theme) {
    selected=normalizeTheme(theme);
    root.dataset.theme=resolveTheme(selected,media.matches);
    root.dataset.themePreference=selected;
    radios.forEach(r=>r.checked=r.value===selected);
    try{cache.setItem(THEME_CACHE,selected);}catch{}
  }
  try {apply((await storage.get('appearance')).appearance?.theme);}
  catch {try{apply(cache.getItem(THEME_CACHE));}catch{apply('light');}status.textContent='无法读取主题偏好，选择后可以重试保存。';}
  function choose(value) {
    apply(value);const theme=selected, change=++revision;
    status.textContent='正在保存外观…';
    writes=writes.catch(()=>{}).then(()=>storage.set({appearance:{theme}}));
    writes.then(()=>{if(change===revision)status.textContent='主题已自动保存，重新打开后仍然生效。';},()=>{if(change===revision)status.textContent='当前已预览，但保存失败。请稍后重新选择。';});
    return writes;
  }
  radios.forEach(r=>r.addEventListener('change',()=>{if(r.checked)choose(r.value).catch(()=>{});}));
  media.addEventListener('change',()=>{if(selected==='system')apply(selected);});
  changes?.addListener((items,area)=>{
    if(area==='local' && items.appearance){apply(items.appearance.newValue?.theme);status.textContent='主题偏好已同步。';}
  });
  return {choose,get selected(){return selected;}};
}
