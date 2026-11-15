'use strict';
/* global getComputedStyle */
// One renderer task reads visibility/enabled state, so DOM replacement cannot
// turn a previous isVisible result into a long isEnabled wait on a vanished node.
function inspectControls(input) {
  const elements = Array.isArray(input) ? input : [input];
  return elements.map(element => {
    const style = getComputedStyle(element);
    const visible = element.isConnected && style.visibility !== 'hidden' && style.visibility !== 'collapse' && [...element.getClientRects()].some(rect => rect.width > 0 && rect.height > 0);
    let disabled = element.matches(':disabled');
    for (let node = element; node; node = node.parentElement || node.getRootNode()?.host) if (node.hasAttribute('inert') || node.getAttribute('aria-disabled') === 'true') disabled = true;
    return { visible, enabled: !disabled, label: (element.getAttribute('aria-label') || element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 161), popup: element.getAttribute('aria-haspopup') };
  });
}
const transientDomError = error => /detached|not attached|execution context was destroyed|cannot find context|target.*closed|frame.*removed/i.test(error.message);
async function anyReadyControl(locator) {
  try { return (await locator.evaluateAll(inspectControls)).some(state => state.visible && state.enabled); }
  catch (error) { if (transientDomError(error)) return false; throw error; }
}
async function firstReadyControl(locator) {
  let handles;
  try { handles = await locator.elementHandles(); } catch (error) { if (transientDomError(error)) return null; throw error; }
  let selected = null;
  try {
    for (const handle of handles.slice(0, 12)) {
      try { const [state] = await handle.evaluate(inspectControls); if (state.visible && state.enabled) { selected = handle; break; } }
      catch (error) { if (!transientDomError(error)) throw error; }
    }
    return selected;
  } finally { await Promise.allSettled(handles.filter(handle => handle !== selected).map(handle => handle.dispose())); }
}
module.exports = { inspectControls, anyReadyControl, firstReadyControl };
