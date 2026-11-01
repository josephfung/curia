export type InstallGuidance =
  | { kind: 'installed' }
  | { kind: 'prompt' }
  | { kind: 'ios-share' }
  | { kind: 'browser-menu' };

export const IOS_SHARE_STEPS = [
  'Tap the Share button in Safari.',
  'Tap Add to Home Screen.',
  'Tap Add.',
] as const;

export const BROWSER_INSTALL_HINT = 'Open the browser menu and choose Install app.';

export function installGuidance(env: {
  ios: boolean;
  standalone: boolean;
  promptAvailable: boolean;
}): InstallGuidance {
  if (env.standalone) return { kind: 'installed' };
  if (env.promptAvailable) return { kind: 'prompt' };
  if (env.ios) return { kind: 'ios-share' };
  return { kind: 'browser-menu' };
}
