/**
 * i18n：zh-CN / en 双语。UI 字符串走 t(key)，
 * 数据表内联双语走 tl(l10n)。
 */
import type { L10n, Lang } from '../core/types';
import { ZH } from './zh';
import { EN } from './en';

const LANG_KEY = 'paradise-isle.lang';

/** First visit: follow the browser (Chinese if it is set to Chinese, otherwise English). */
function initialLang(): Lang {
  try {
    const saved = globalThis.localStorage?.getItem(LANG_KEY);
    if (saved === 'zh' || saved === 'en') return saved;
  } catch { /* storage blocked */ }
  const nav = globalThis.navigator?.language ?? 'en';
  return nav.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

let currentLang: Lang = initialLang();

/** Switch the UI language and remember the choice for the next visit. */
export function setLang(lang: Lang): void {
  currentLang = lang;
  try { globalThis.localStorage?.setItem(LANG_KEY, lang); } catch { /* storage blocked */ }
  if (typeof document !== 'undefined') {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    document.title = lang === 'zh' ? '天堂小岛 Paradise Isle' : 'Paradise Isle';
  }
}

export function getLang(): Lang {
  return currentLang;
}

export function t(key: string, vars?: Record<string, string | number>): string {
  const dict = currentLang === 'zh' ? ZH : EN;
  let s = dict[key] ?? (currentLang === 'zh' ? ZH[key] : EN[key]) ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.replaceAll(`{${k}}`, String(v));
    }
  }
  return s;
}

export function tl(l10n: L10n | undefined): string {
  if (!l10n) return '';
  return currentLang === 'zh' ? l10n.zh : l10n.en || l10n.zh;
}

/** 毫秒 → "2小时3分" / "45秒" */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (currentLang === 'zh') {
    if (h > 0) return m > 0 ? `${h}小时${m}分` : `${h}小时`;
    if (m > 0) return sec > 0 && m < 5 ? `${m}分${sec}秒` : `${m}分钟`;
    return `${sec}秒`;
  }
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return sec > 0 && m < 5 ? `${m}m ${sec}s` : `${m}m`;
  return `${sec}s`;
}
