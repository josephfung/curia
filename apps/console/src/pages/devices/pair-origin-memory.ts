export const PAIRING_ORIGIN_KEY = 'curia:pairing:origin';

export function readPairingOrigin(storage: Pick<Storage, 'getItem'>): string {
  try {
    const value = storage.getItem(PAIRING_ORIGIN_KEY);
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

export function writePairingOrigin(storage: Pick<Storage, 'setItem'>, origin: string): void {
  try {
    storage.setItem(PAIRING_ORIGIN_KEY, origin);
  } catch {
    // Private mode and blocked storage still let the operator type the address.
  }
}
