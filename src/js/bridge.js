// The only file that touches window.__TAURI__. Everything native goes through here.
const T = window.__TAURI__;

export const hasBridge = !!(T && T.core);
export const call = (cmd, args) => T.core.invoke(cmd, args);
export const listen = (name, fn) => T.event.listen(name, (e) => fn(e.payload));

export async function copyText(text) {
  await T.clipboardManager.writeText(text);
}
export async function readText() {
  return T.clipboardManager.readText();
}
export function onFileDrop(handlers) {
  return T.webview.getCurrentWebview().onDragDropEvent((e) => {
    const p = e.payload;
    if (p.type === 'enter' || p.type === 'over') handlers.over();
    else if (p.type === 'leave') handlers.leave();
    else if (p.type === 'drop') handlers.drop(p.paths);
  });
}
