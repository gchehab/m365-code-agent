'use strict';
const api = acquireVsCodeApi();
const reading = window.M365Reading(api);
const el = id => document.getElementById(id);
let size = 14;
reading.enhance(document.querySelector('main'));
function update() {
  document.documentElement.style.setProperty('--reading-font-size', size + 'px');
  el('fontSize').textContent = String(size);
  el('fontSmaller').disabled = size <= 12; el('fontLarger').disabled = size >= 18;
  reading.setWrap(el('wrapCode').checked);
}
el('fontSmaller').addEventListener('click', () => { size = Math.max(12, size - 1); update(); });
el('fontLarger').addEventListener('click', () => { size = Math.min(18, size + 1); update(); });
el('wrapCode').addEventListener('change', update);
el('copyResponse').addEventListener('click', () => reading.copy('', el('copyResponse'), 'copyResponse'));
window.addEventListener('message', ({ data }) => {
  if (data?.type === 'readingSettings') { size = data.readingSize; el('wrapCode').checked = data.wrapCode; update(); }
});
update(); api.postMessage({ type: 'ready' });
