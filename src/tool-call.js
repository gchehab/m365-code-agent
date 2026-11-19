// @ts-check
'use strict';
const { jsonValue } = require('./mcp');
const { t } = require('./i18n');
/** @typedef {import('../types/contracts').ToolCall} ToolCall */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Normalize untrusted model output before tools access the filesystem.
 * @param {unknown} value
 * @returns {ToolCall}
 */
function normalizeToolCall(value) {
  if (!isRecord(value)) throw new Error(t('errMissingToolRequestObject'));
  const nested = isRecord(value.function) ? value.function : {};
  const name = value.name || nested.name;
  if (typeof name !== 'string' || !name.trim()) throw new Error(t('errMissingToolName'));
  let args = value.arguments ?? value.parameters ?? value.args ?? nested.arguments ?? {};
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch (cause) {
      throw new Error(t('errInvalidToolArgsJson'), { cause });
    }
  }
  if (!isRecord(args)) throw new Error(t('errToolArgsNotObject'));
  /** @type {ToolCall} */
  const result = { name };
  /** @param {string} key @param {string | undefined} alias */
  const argument = (key, alias) => value[key] ?? args[key] ?? (alias ? args[alias] : undefined);
  for (const key of /** @type {const} */ (['path', 'query', 'command', 'tool'])) {
    const entry = argument(key, key === 'path' ? 'file_path' : undefined);
    if (entry === undefined) continue;
    if (typeof entry !== 'string') throw new Error(t('errFieldMustBeString', { key }));
    result[key] = entry;
  }
  const aliases = {
    offset: undefined,
    limit: undefined,
    startLine: 'start_line',
    startColumn: 'start_column',
    lineCount: 'line_count',
  };
  for (const key of /** @type {const} */ (['limit', 'startLine', 'startColumn', 'lineCount', 'offset'])) {
    const entry = argument(key, aliases[key]);
    if (entry === undefined) continue;
    if (typeof entry !== 'number' || !Number.isFinite(entry))
      throw new Error(t('errFieldMustBeFiniteNumber', { key }));
    result[key] = entry;
  }
  const paths = argument('paths', undefined);
  if (paths !== undefined) {
    if (
      typeof paths !== 'string' &&
      !(Array.isArray(paths) && paths.every((path) => typeof path === 'string'))
    )
      throw new Error(t('errPathsMustBeStringOrArray'));
    result.paths = paths;
  }
  const input = Object.hasOwn(value, 'input') ? value.input : args.input;
  if (input !== undefined) {
    if (!isRecord(input)) throw new Error(t('errMcpInputMustBeObject'));
    result.input = /** @type {Record<string, unknown>} */ (jsonValue(input));
  }
  return result;
}
module.exports = { normalizeToolCall };
