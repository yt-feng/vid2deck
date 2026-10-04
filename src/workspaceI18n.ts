import englishCopy from './workspaceEnglish.json';

export type WorkspaceLanguage = 'zh-CN' | 'en';
type LocaleWindow = Window & { Vid2PPTLocale?: { current?: string; url?: (path: string, locale?: string) => string } };

const dictionary: Readonly<Record<string, string>> = englishCopy;
const chinese = /[\u3400-\u9fff]/;
export const missingWorkspaceTranslations = new Set<string>();

function normalizedSlots(source: string): { key: string; slots: string[] } {
  const slots: string[] = [];
  const key = source.replace(/\{\{(\d+)\}\}/g, (_match, slot: string) => {
    if (!slots.includes(slot)) slots.push(slot);
    return `{{${slots.indexOf(slot)}}}`;
  });
  return { key, slots };
}

// HTML attributes can occur at any position in an enclosing template. Normalize
// slot numbers per phrase so a new interpolation elsewhere cannot break its copy.
const normalizedDictionary = Object.fromEntries(Object.entries(dictionary).map(([source, english]) => {
  const { key, slots } = normalizedSlots(source);
  return [key, english.replace(/\{\{(\d+)\}\}/g, (_match, slot: string) => `{{${slots.indexOf(slot)}}}`)];
}));

export function workspaceLanguage(locale?: string): WorkspaceLanguage {
  const selected = locale ?? (typeof window === 'undefined' ? 'zh-CN' : (window as LocaleWindow).Vid2PPTLocale?.current ?? 'en');
  return /^zh(?:-|$)/i.test(selected) ? 'zh-CN' : 'en';
}

function translatePhrase(source: string): string {
  const key = source.trim();
  const normalized = normalizedSlots(key);
  const normalizedTranslation = normalizedDictionary[normalized.key];
  const translated = dictionary[key] ?? normalizedTranslation?.replace(/\{\{(\d+)\}\}/g, (_match, slot: string) => `{{${normalized.slots[Number(slot)]}}}`);
  if (translated !== undefined) {
    const start = source.indexOf(key);
    return source.slice(0, start) + translated + source.slice(start + key.length);
  }
  if (chinese.test(key) && !missingWorkspaceTranslations.has(key)) {
    missingWorkspaceTranslations.add(key);
    console.warn('Missing workspace UI translation:', key);
  }
  return source;
}

/** Translates only an authored source skeleton, before any user values are inserted. */
export function translateWorkspaceSource(source: string, language: WorkspaceLanguage = workspaceLanguage()): string {
  if (language !== 'en' || !chinese.test(source)) return source;
  if (!/<\/?[a-z][a-z0-9-]*[\s>]/i.test(source)) return translatePhrase(source);
  return source.replace(/<[^>]*>|[^<]+/g, (part) => part.startsWith('<')
    ? part.replace(/\b(aria-label|title|placeholder|alt)="([^"]*)"/g, (_match, name: string, value: string) => `${name}="${translatePhrase(value)}"`)
    : translatePhrase(part));
}

/**
 * Use ui('literal') or ui`authored ${value}` for application copy.
 * Interpolated filenames, usernames, OCR, transcripts and generated notes are
 * inserted once after translation, and are never passed through the dictionary.
 */
export function ui(source: string | TemplateStringsArray, ...values: unknown[]): string {
  if (typeof source === 'string') return translateWorkspaceSource(source);
  const skeleton = source.reduce((result, part, index) => result + (index ? `{{${index - 1}}}` : '') + part, '');
  const translated = translateWorkspaceSource(skeleton);
  return translated.replace(/\{\{(\d+)\}\}/g, (_match, index: string) => String(values[Number(index)]));
}

/** Service and worker feedback is system copy, separate from their result data. */
export function serviceMessage(value: unknown, fallback = 'The request could not be completed. Please try again or contact support.'): string {
  if (typeof value !== 'string' || !value.trim()) return '';
  if (workspaceLanguage() !== 'en') return value;
  if (dictionary[value] !== undefined) return dictionary[value];
  if (!chinese.test(value)) return value;
  // Exact anchored source patterns retain the dynamic parts of known API errors.
  // No substring rewriting is applied to arbitrary server-returned content.
  for (const [source, translated] of Object.entries(dictionary)) {
    if (!/\{\{\d+\}\}/.test(source) || !chinese.test(source)) continue;
    const slots: string[] = [];
    const pattern = source.split(/(\{\{\d+\}\})/g).map((part) => {
      const slot = part.match(/^\{\{(\d+)\}\}$/);
      if (slot) { slots.push(slot[1]); return '([\\s\\S]*?)'; }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('');
    const match = value.match(new RegExp(`^${pattern}$`));
    if (!match) continue;
    const values = Object.fromEntries(slots.map((slot, index) => [slot, match[index + 1]]));
    return translated.replace(/\{\{(\d+)\}\}/g, (_match, index: string) => values[index] ?? '');
  }
  return fallback;
}

/** Existing page chrome is authored HTML; localize its explicit surfaces once. */
export function initializeWorkspaceLanguage(): void {
  const language = workspaceLanguage();
  document.documentElement.lang = language;
  document.documentElement.dir = 'ltr';
  if (language === 'en') {
    document.title = 'Vid2PPT | Video notes, PPTX and PDF';
    document.querySelector<HTMLMetaElement>('meta[name="description"]')?.setAttribute('content', 'Turn videos into visual notes with original charts and timestamps. Read, edit and export PPTX, PDF, HTML and Markdown.');
    document.querySelectorAll<HTMLElement>('.site-nav, .site-footer, .skip-link').forEach((surface) => {
      // Only source chrome is visited. The app, frames and user-generated notes
      // are localized at their authored call sites, never through a DOM observer.
      const walker = document.createTreeWalker(surface, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        if (!node.parentElement?.closest('#globalRegionMenu, select, #openLoginBtn')) node.nodeValue = translateWorkspaceSource(node.nodeValue ?? '', language);
        node = walker.nextNode();
      }
      [surface, ...surface.querySelectorAll<HTMLElement>('[aria-label], [title], [alt], [placeholder]')].forEach((element) => {
        if (element.closest('#globalRegionMenu, select, #openLoginBtn')) return;
        for (const attribute of ['aria-label', 'title', 'alt', 'placeholder']) {
          const value = element.getAttribute(attribute);
          if (value) element.setAttribute(attribute, translateWorkspaceSource(value, language));
        }
      });
    });
  }
  // Preserve language when the workspace points to pricing, policies and guides.
  const locale = (window as LocaleWindow).Vid2PPTLocale;
  if (locale?.url) document.querySelectorAll<HTMLAnchorElement>('a[href^="/"]').forEach((link) => {
    if (link.hasAttribute('download') || link.getAttribute('href')?.startsWith('//')) return;
    link.href = locale.url?.(link.getAttribute('href') ?? '/') ?? link.href;
  });
}
