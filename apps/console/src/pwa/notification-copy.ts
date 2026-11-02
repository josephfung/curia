// The words for "notifications on this device" (#2341). Turning them on
// subscribes the browser or installed app it's tapped in, never another
// device, so every line names which one.

export interface NotificationCopy {
  /** "phone", "app" or "browser": what "this …" refers to. */
  noun: 'phone' | 'app' | 'browser';
  intro: string;
  /** Shown on a computer: how to get notifications on the phone instead. */
  phoneHint: string | null;
  turnOn: string;
  onStatus: string;
}

export function notificationCopy(env: { standalone: boolean; touch: boolean }): NotificationCopy {
  const noun = env.standalone ? (env.touch ? 'phone' : 'app') : 'browser';
  const intro = noun === 'phone'
    ? "Curia can send a notification to this phone when it messages you and the app isn't open."
    : noun === 'app'
      ? 'Curia can show a notification from this app when it messages you and no Curia window is open.'
      : 'Curia can show a notification in this browser when it messages you and no Curia window is open.';
  return {
    noun,
    intro,
    phoneHint: env.touch ? null : 'To get them on your phone, turn them on in the Curia app on the phone.',
    turnOn: `Turn on for this ${noun}`,
    onStatus: `On for this ${noun}`,
  };
}
