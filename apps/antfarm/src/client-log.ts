/** Minimal browser-side logging (Ant Farm has no pino). */

export function clientWarn(message: string, detail?: unknown): void {
  if (detail !== undefined) {
    console.error(`[antfarm] ${message}`, detail);
  } else {
    console.error(`[antfarm] ${message}`);
  }
}
