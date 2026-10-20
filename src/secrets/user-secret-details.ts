// user-secret-details.ts — non-secret sign-in details for a user.* vault key (#2201).
//
// Where to sign in and with which username. Neither is a secret: they are stored in plain
// text beside the vault (user_secret_details) and returned by list-user-secrets so an agent
// signs in directly instead of searching the web for a login page.

export interface UserSecretDetails {
  loginUrl?: string;
  username?: string;
}

const MAX_URL_LENGTH = 500;
const MAX_USERNAME_LENGTH = 200;

/**
 * Validate the optional login_url / username skill inputs. Throws with a message fit for
 * the agent on a bad value; absent or blank inputs are simply omitted.
 */
export function parseUserSecretDetails(input: { login_url?: unknown; username?: unknown }): UserSecretDetails {
  const details: UserSecretDetails = {};
  if (input.login_url !== undefined && input.login_url !== null && input.login_url !== '') {
    if (typeof input.login_url !== 'string') throw new Error('login_url must be a string');
    const raw = input.login_url.trim();
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error(`login_url must be a full http(s) URL, got '${raw.slice(0, 100)}'`);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error('login_url must be an http(s) URL');
    }
    if (url.username || url.password) {
      throw new Error('login_url must not contain credentials');
    }
    if (raw.length > MAX_URL_LENGTH) throw new Error(`login_url must be at most ${MAX_URL_LENGTH} characters`);
    details.loginUrl = url.toString();
  }
  if (input.username !== undefined && input.username !== null && input.username !== '') {
    if (typeof input.username !== 'string') throw new Error('username must be a string');
    const username = input.username.trim();
    if (username.length === 0 || /[\u0000-\u001f\u007f]/.test(username)) {
      throw new Error('username must be a single line of text');
    }
    if (username.length > MAX_USERNAME_LENGTH) {
      throw new Error(`username must be at most ${MAX_USERNAME_LENGTH} characters`);
    }
    details.username = username;
  }
  return details;
}

export function hasUserSecretDetails(details: UserSecretDetails): boolean {
  return details.loginUrl !== undefined || details.username !== undefined;
}
