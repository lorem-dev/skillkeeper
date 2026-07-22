/**
 * Runtime detection of whether the engine actually *paints* `backdrop-filter`.
 *
 * `@supports (backdrop-filter: blur(1px))` is not enough on Windows. WebView2 /
 * Chromium parses the property as supported, but only paints backdrop-filter
 * effects when the page is GPU-composited. Where the GPU is blocklisted or off
 * (old drivers, a Remote Desktop session, a VM without GPU passthrough, hardware
 * acceleration disabled) Chromium falls back to software compositing and
 * silently drops every backdrop-filter -- frosted headers, menus and modal
 * scrims then render as near-transparent panels. The `@supports not` fallbacks
 * never fire, because `@supports` still reports the property as supported. This
 * is why the blur appears on one Windows machine and not another running the
 * same build.
 *
 * There is no direct CSS/JS query for "is compositing GPU-accelerated", but in
 * Chromium the GPU decision is unified: when compositing goes software, WebGL is
 * served by the software rasterizer (SwiftShader / WARP) as well. Probing the
 * WebGL renderer string is therefore a reliable proxy. We default to "paints"
 * on any uncertainty (unknown renderer, no WebGL, exception) so a healthy
 * machine is never wrongly stripped of its glass -- we only flag the clear
 * software-renderer case.
 */

let backdropBlurSupport: boolean | undefined;

// Renderer strings Chromium reports when compositing has fallen back to software
// (SwiftShader / Direct3D WARP / Mesa llvmpipe). Matching any of these means
// backdrop-filter blur will not be painted.
const SOFTWARE_RENDERER = /swiftshader|software|basic render|llvmpipe|swrast/i;

/** The unmasked WebGL renderer string, or null when it cannot be determined. */
function detectRenderer(): string | null {
  try {
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl') ??
      canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;
    if (gl === null) return null;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const value =
      ext !== null
        ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)
        : gl.getParameter(gl.RENDERER);
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

/**
 * Whether the engine actually paints `backdrop-filter: blur()`. False only when
 * we positively detect a software renderer (GPU compositing off); true in every
 * other case, including uncertainty. Cached after the first call.
 */
export function supportsBackdropBlur(): boolean {
  if (backdropBlurSupport !== undefined) return backdropBlurSupport;
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    backdropBlurSupport = true;
    return backdropBlurSupport;
  }
  // If the engine does not even parse backdrop-filter, the CSS `@supports not`
  // fallbacks already cover it -- nothing to detect at runtime.
  const cssParses =
    typeof CSS !== 'undefined' &&
    typeof CSS.supports === 'function' &&
    (CSS.supports('backdrop-filter', 'blur(1px)') ||
      CSS.supports('-webkit-backdrop-filter', 'blur(1px)'));
  if (!cssParses) {
    backdropBlurSupport = true;
    return backdropBlurSupport;
  }
  const renderer = detectRenderer();
  backdropBlurSupport = renderer === null ? true : !SOFTWARE_RENDERER.test(renderer);
  return backdropBlurSupport;
}
