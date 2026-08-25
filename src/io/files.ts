import { desktop } from '../desktop';

/**
 * File in and out. In a browser tab these are downloads and an <input type=file>;
 * in the desktop shell the same calls become native Save and Open dialogs.
 */

export function downloadText(filename: string, text: string, mime = 'text/plain'): void {
  const bridge = desktop();
  if (bridge) {
    void bridge.saveFile(filename, text, false);
    return;
  }
  downloadBlob(filename, new Blob([text], { type: mime }));
}

export function downloadBinary(filename: string, data: ArrayBuffer, mime = 'application/octet-stream'): void {
  const bridge = desktop();
  if (bridge) {
    void bridge.saveFile(filename, new Uint8Array(data), true);
    return;
  }
  downloadBlob(filename, new Blob([data], { type: mime }));
}

function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function openTextFile(accept: string): Promise<{ name: string; text: string } | null> {
  const bridge = desktop();
  if (bridge && accept.includes('.kiln')) return bridge.openScene();
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => resolve({ name: file.name, text: String(reader.result ?? '') });
      reader.onerror = () => resolve(null);
      reader.readAsText(file);
    };
    input.click();
  });
}

/** Open a native file picker and hand back the raw File. */
export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    // A cancelled picker fires nothing at all in some browsers, so the promise
    // is also settled when focus comes back to the window.
    window.addEventListener('focus', () => setTimeout(() => resolve(input.files?.[0] ?? null), 300), { once: true });
    input.click();
  });
}
