/**
 * Window drag regions for the frameless macOS chrome.
 *
 * WebKit (the webview Tauri uses) ignores the old app-region CSS, so draggable
 * chrome is tagged with `data-tauri-drag-region` instead and Tauri drives the
 * drag natively. Only the frameless macOS window (hidden title bar + native
 * traffic lights) drags via on-content regions; Windows and Linux drag via the
 * dedicated TitleBar strip, so on-content regions must stay off there.
 *
 * Generic layout primitives (`shared/ui` Page/Toolbar) and the full-screen
 * overlays need to opt in per platform, but `shared/*` may not import services
 * to learn the host platform. The app root pushes the decision once at startup
 * via {@link setMacChrome}; the helpers below then read that static flag.
 */
let macChrome = false;

/** Record whether the host uses the frameless macOS chrome. Call once at startup. */
export function setMacChrome(value: boolean): void {
  macChrome = value;
}

export interface DragRegionProps {
  readonly 'data-tauri-drag-region'?: true;
}

/**
 * Props to spread onto a non-interactive element so it becomes a window-drag
 * handle -- but only under the macOS chrome. Returns an empty object elsewhere,
 * leaving the element inert. Tauri drags only when the pressed element itself is
 * tagged, so interactive children (buttons, inputs) keep working with no opt-out.
 */
export function dragRegion(): DragRegionProps {
  return macChrome ? { 'data-tauri-drag-region': true } : {};
}
