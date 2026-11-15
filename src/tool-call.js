// @ts-check
'use strict';
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
  if (!isRecord(value)) throw new Error('도구 요청 객체가 없습니다.');
  const nested = isRecord(value.function) ? value.function : {};
  const name = value.name || nested.name;
  if (typeof name !== 'string' || !name.trim()) throw new Error('도구 이름이 없는 요청입니다.');
  let args = value.arguments ?? value.parameters ?? value.args ?? nested.arguments ?? {};
  if (typeof args === 'string') args = JSON.parse(args);
  if (!isRecord(args)) throw new Error('도구 인자가 객체가 아닙니다.');
  /** @type {ToolCall} */
  const result = { name };
  const argument = (key, alias) => value[key] ?? args[key] ?? (alias ? args[alias] : undefined);
  for (const key of /** @type {const} */ (['path', 'query', 'command'])) {
    const entry = argument(key, key === 'path' ? 'file_path' : undefined);
    if (entry === undefined) continue;
    if (typeof entry !== 'string') throw new Error(`${key}는 문자열이어야 합니다.`);
    result[key] = entry;
  }
  const aliases = {
    limit: undefined,
    startLine: 'start_line',
    startColumn: 'start_column',
    lineCount: 'line_count',
  };
  for (const key of /** @type {const} */ (['limit', 'startLine', 'startColumn', 'lineCount'])) {
    const entry = argument(key, aliases[key]);
    if (entry === undefined) continue;
    if (typeof entry !== 'number' || !Number.isFinite(entry))
      throw new Error(`${key}는 유한한 숫자여야 합니다.`);
    result[key] = entry;
  }
  const paths = argument('paths', undefined);
  if (paths !== undefined) {
    if (
      typeof paths !== 'string' &&
      !(Array.isArray(paths) && paths.every((path) => typeof path === 'string'))
    )
      throw new Error('paths는 문자열 또는 문자열 배열이어야 합니다.');
    result.paths = paths;
  }
  return result;
}
module.exports = { normalizeToolCall };
