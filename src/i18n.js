// @ts-check
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const en = require('./locales/en');
const ko = require('./locales/ko');
const ptBR = require('./locales/pt-BR');

/**
 * @typedef {{
 *   code: string,
 *   label: string,
 *   htmlLang?: string,
 *   browserLocale?: string,
 *   dateLocale?: string,
 *   webUi?: Record<string, string[]>,
 *   ui?: Record<string, string>,
 *   messages?: Record<string, string>
 * }} LanguagePackInput
 */

/**
 * @typedef {{
 *   code: string,
 *   label: string,
 *   htmlLang: string,
 *   browserLocale: string,
 *   dateLocale: string,
 *   webUi: Record<string, string[]>,
 *   ui: Record<string, string>,
 *   messages: Record<string, string>
 * }} LanguagePack
 */

const DEFAULT_LANGUAGE = 'en';

/** @type {Map<string, LanguagePack>} */
const packs = new Map();

/** @param {LanguagePackInput} pack */
function registerLanguagePack(pack) {
  if (!pack || typeof pack.code !== 'string' || !pack.code.trim()) {
    throw new Error('Language pack requires a valid language code.');
  }
  const canonicalCode = pack.code.trim();
  const key = canonicalCode.toLowerCase();
  packs.set(key, {
    code: canonicalCode,
    label: typeof pack.label === 'string' && pack.label.trim() ? pack.label.trim() : canonicalCode,
    htmlLang:
      typeof pack.htmlLang === 'string' && pack.htmlLang.trim() ? pack.htmlLang.trim() : canonicalCode,
    browserLocale:
      typeof pack.browserLocale === 'string' && pack.browserLocale.trim()
        ? pack.browserLocale.trim()
        : canonicalCode,
    dateLocale:
      typeof pack.dateLocale === 'string' && pack.dateLocale.trim()
        ? pack.dateLocale.trim()
        : canonicalCode,
    webUi: { ...en.webUi, ...(pack.webUi || {}) },
    ui: { ...en.ui, ...(pack.ui || {}) },
    messages: { ...en.messages, ...(pack.messages || {}) },
  });
}

registerLanguagePack(en);
registerLanguagePack(ko);
registerLanguagePack(ptBR);

try {
  const localesDir = path.join(__dirname, 'locales');
  for (const entry of fs.readdirSync(localesDir)) {
    if (!/\.(?:js|json)$/i.test(entry)) continue;
    const base = entry.replace(/\.(?:js|json)$/i, '').toLowerCase();
    if (packs.has(base)) continue;
    try {
      const loaded = require(path.join(localesDir, entry));
      if (loaded && typeof loaded.code === 'string') registerLanguagePack(loaded);
    } catch {
      /* Ignore malformed custom locale files and keep built-in packs working. */
    }
  }
} catch {
  /* Built-in en, ko, and pt-BR packs are already registered. */
}

/** @param {string | undefined | null} code @returns {string} */
function normalizeLanguage(code) {
  if (typeof code !== 'string' || !code.trim()) return DEFAULT_LANGUAGE;
  const clean = code.trim().replace(/_/g, '-').toLowerCase();
  const exact = packs.get(clean);
  if (exact) return exact.code;
  const primary = clean.split('-')[0];
  const primaryMatch = packs.get(primary);
  if (primaryMatch) return primaryMatch.code;
  for (const [key, pack] of packs.entries()) {
    if (key.split('-')[0] === primary) return pack.code;
  }
  return DEFAULT_LANGUAGE;
}

let currentLanguage = normalizeLanguage(process.env.M365_AGENT_LANG || DEFAULT_LANGUAGE);

/** @returns {string} */
function getLanguage() {
  return currentLanguage;
}

/** @param {string | undefined | null} code @returns {string} */
function setLanguage(code) {
  currentLanguage = normalizeLanguage(code);
  return currentLanguage;
}

/** @returns {{ code: string, label: string }[]} */
function getAvailableLanguages() {
  const list = [...packs.values()].map((pack) => ({ code: pack.code, label: pack.label }));
  list.sort((a, b) =>
    a.code === DEFAULT_LANGUAGE ? -1 : b.code === DEFAULT_LANGUAGE ? 1 : a.code.localeCompare(b.code),
  );
  return list;
}

/** @param {string} [code] @returns {LanguagePack} */
function getLanguagePack(code) {
  const resolved = code ? normalizeLanguage(code) : currentLanguage;
  return /** @type {LanguagePack} */ (packs.get(resolved.toLowerCase()) || packs.get(DEFAULT_LANGUAGE));
}

/**
 * @param {string} template
 * @param {Record<string, unknown>} [params]
 * @returns {string}
 */
function formatTemplate(template, params) {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, key) =>
    Object.hasOwn(params, key) && params[key] !== undefined && params[key] !== null
      ? String(params[key])
      : match,
  );
}

/**
 * @param {string} key
 * @param {Record<string, unknown>} [params]
 * @param {string} [code]
 * @returns {string}
 */
function t(key, params, code) {
  const pack = getLanguagePack(code);
  const fallback = /** @type {LanguagePack} */ (packs.get(DEFAULT_LANGUAGE));
  const template = pack.messages[key] ?? pack.ui[key] ?? fallback.messages[key] ?? fallback.ui[key] ?? key;
  return formatTemplate(template, params);
}

/**
 * @param {string} key
 * @param {Record<string, unknown>} [params]
 * @param {string} [code]
 * @returns {string}
 */
function ui(key, params, code) {
  const pack = getLanguagePack(code);
  const fallback = /** @type {LanguagePack} */ (packs.get(DEFAULT_LANGUAGE));
  const template = pack.ui[key] ?? fallback.ui[key] ?? key;
  return formatTemplate(template, params);
}

/** @param {string} value */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Builds a case-insensitive RegExp combining localized web UI control labels
 * across all registered language packs, prioritizing the active language pack first.
 * @param {string} key
 * @param {string} [suffixPattern]
 * @returns {RegExp}
 */
function getWebUiPattern(key, suffixPattern = '(?:\\s*[\\(\\-–—:].*)?') {
  const active = getLanguagePack();
  const orderedPacks = [active, ...[...packs.values()].filter((pack) => pack.code !== active.code)];
  const terms = [];
  const seen = new Set();
  for (const pack of orderedPacks) {
    const list = pack.webUi?.[key];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (typeof item !== 'string' || !item.trim()) continue;
      const normalized = item.trim().toLowerCase();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      terms.push(escapeRegExp(item.trim()));
    }
  }
  return new RegExp(`^(?:${terms.join('|')})${suffixPattern}$`, 'i');
}

module.exports = {
  DEFAULT_LANGUAGE,
  registerLanguagePack,
  normalizeLanguage,
  getLanguage,
  setLanguage,
  getAvailableLanguages,
  getLanguagePack,
  getWebUiPattern,
  t,
  ui,
};
