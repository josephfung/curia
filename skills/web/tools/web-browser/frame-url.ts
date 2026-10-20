// frame-url.ts — which hosts and frame URLs web-browser must never reach (SSRF guard).
// Shared by the navigate guard, per-frame interaction / extraction gating, and the
// verification tool's choice of the frame a sign-in code is typed into (#2017).

/**
 * True for hosts that must never be reached — loopback, private/link-local ranges, IPv6
 * unique-local/link-local, IPv4-mapped-IPv6 forms, and cloud metadata endpoints. Shared
 * by the navigate guard and per-frame SSRF gating so both use one definition.
 */
export function isPrivateHost(hostname: string): boolean {
  let h = hostname.toLowerCase();
  // URL.hostname keeps brackets on IPv6 literals ([::1]) — strip them to normalize.
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  // IPv4-mapped IPv6 — re-check the embedded IPv4 against the rules below so a mapped
  // loopback/private address can't slip through. The URL parser normalizes the dotted
  // form (::ffff:127.0.0.1) to the hex form (::ffff:7f00:1), so decode both.
  const mappedDotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h);
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (mappedDotted) {
    h = mappedDotted[1]!;
  } else if (mappedHex) {
    const hi = parseInt(mappedHex[1]!, 16);
    const lo = parseInt(mappedHex[2]!, 16);
    h = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }

  return (
    h === 'localhost' ||
    h === '0.0.0.0' ||
    h === '::' ||
    h === '::1' ||
    h === 'metadata.google.internal' ||
    // IPv4 loopback / private / link-local (169.254/16 also covers the cloud metadata IP)
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^169\.254\./.test(h) ||
    // IPv6 link-local fe80::/10 (fe80:–febf:)
    /^fe[89ab][0-9a-f]:/.test(h) ||
    // IPv6 unique-local (ULA) fc00::/7 (fc00:–fdff:)
    /^f[cd][0-9a-f]{2}:/.test(h)
  );
}

/**
 * Decide whether a child frame's URL is off-limits for content extraction / interaction.
 * Blocks file: (local files) and any http(s) frame on a private/internal host. Inline
 * frames (about:blank, about:srcdoc, data:, blob:) carry no network egress, so they're
 * allowed — their content comes from the already-validated parent page. An unparseable
 * URL (e.g. '') is treated as not-blocked (typically the main frame before navigation).
 */
export function isBlockedFrameUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol === 'file:') return true;
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return isPrivateHost(parsed.hostname.toLowerCase());
}
