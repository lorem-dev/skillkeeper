/**
 * Maps the host platform (`process.platform`, via the bridge) to the
 * window-chrome variant: 'mac' uses no title-bar strip (native traffic lights +
 * drag regions on the real content), while 'windows'/'linux' draw a TitleBar.
 * Shared by App (the `.sk-app--<platform>` class) and WindowChrome.
 */
export function hostPlatform(platform: string): 'mac' | 'windows' | 'linux' {
  if (platform === 'darwin') return 'mac';
  if (platform === 'win32') return 'windows';
  return 'linux';
}
