// WER and entity scoring for the #2469 harness.
//
// Every engine writes entities differently: Deepgram smart_format gives
// "3:30 PM" and "416-555-0142", Parakeet "3:30 p.m.", Zipformer "THREE THIRTY P M".
// Both reference and hypothesis go through one spoken-form canonicaliser (a
// port of service/normalize.py) so formatting differences are not scored as
// recognition errors. What is left is what was heard.

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const ORD: Record<string, string> = { one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth', nine: 'ninth', twelve: 'twelfth' };
const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December';

function cardinal(n: number): string {
  if (n < 20) return ONES[n]!;
  if (n < 100) return TENS[Math.floor(n / 10)]! + (n % 10 ? ` ${ONES[n % 10]!}` : '');
  if (n < 1000) return `${ONES[Math.floor(n / 100)]!} hundred${n % 100 ? ` ${cardinal(n % 100)}` : ''}`;
  for (const [size, word] of [[1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']] as const) {
    if (n >= size) return `${cardinal(Math.floor(n / size))} ${word}${n % size ? ` ${cardinal(n % size)}` : ''}`;
  }
  return String(n);
}

function ordinal(n: number): string {
  const words = cardinal(n).split(' ');
  const last = words.pop()!;
  const o = ORD[last] ?? (last.endsWith('y') ? `${last.slice(0, -1)}ieth` : `${last}th`);
  return [...words, o].join(' ');
}

function year(n: number): string {
  if (n >= 2000 && n <= 2009) return cardinal(n);
  const hi = Math.floor(n / 100);
  const lo = n % 100;
  return `${cardinal(hi)} ${lo === 0 ? 'hundred' : lo < 10 ? `oh ${ONES[lo]!}` : cardinal(lo)}`;
}

const digits = (s: string): string => [...s].filter(c => /\d/.test(c)).map(c => ONES[Number(c)]!).join(' ');
const spell = (s: string): string => [...s.toLowerCase()].join(' ');

function time(h: string, mm: string | undefined, ampm: string | undefined): string {
  let out = cardinal(Number(h));
  if (mm && mm !== '00') out += ` ${mm.startsWith('0') ? `oh ${ONES[Number(mm)]!}` : cardinal(Number(mm))}`;
  if (ampm) out += ` ${spell(ampm.replace(/\./g, ''))}`;
  return out;
}

/** Written → spoken words (lower case, no punctuation). */
export function canonical(text: string): string[] {
  let t = text;
  // "is$1,250" (no space) and "3.30 p.m." (dot as the time separator) are formatting, not hearing.
  t = t.replace(/(\S)\$(\d)/g, '$1 $$$2');
  t = t.replace(/\b(\d{1,2})\.(\d{2})(\s*[AaPp]\.?\s?[Mm]\.?)/g, '$1:$2$3');
  // An unbroken run of 7+ digits is a phone number read digit by digit, not a cardinal.
  t = t.replace(/\b\d{7,}\b/g, m => digits(m));
  t = t.replace(/\b([\w.+-]+)@([\w-]+(?:\.[\w-]+)+)\b/g, (_m, user: string, domain: string) => {
    const part = (p: string): string => p.replace(/\./g, ' dot ').replace(/_/g, ' underscore ').replace(/-/g, ' dash ')
      .replace(/\d+/g, d => digits(d));
    const labels = domain.split('.');
    const tld = labels.pop()!;
    const spokenTld = ['com', 'org', 'net', 'edu', 'gov', 'io'].includes(tld.toLowerCase()) ? tld : spell(tld);
    return `${part(user)} at ${[...labels.map(part), spokenTld].join(' dot ')}`;
  });
  // After the email rule: "oakbridge.ca" written without the "@" part, where the dot is spoken.
  t = t.replace(/\b([A-Za-z]+)\.([A-Za-z]+)\b/g, (m, a: string, b: string) => (/^(p|a)\.m$/i.test(m) ? m : `${a} dot ${b}`));
  t = t.replace(/(?<!\w)(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/g, m => (m.match(/\d+/g) ?? []).map(digits).join(' '));
  t = t.replace(/\$(\d[\d,]*)(?:\.(\d{2}))?/g, (_m, w: string, c?: string) =>
    `${cardinal(Number(w.replace(/,/g, '')))} dollars${c && Number(c) ? ` and ${cardinal(Number(c))} cents` : ''}`);
  t = t.replace(/\b(\d{1,2})(?::(\d{2}))?\s*([AaPp]\.?\s?[Mm]\.?)(?=\W|$)/g, (_m, h: string, mm?: string, ap?: string) => time(h, mm, ap?.replace(/\s/g, '')));
  t = t.replace(/\b(\d{1,2}):(\d{2})\b/g, (_m, h: string, mm: string) => time(h, mm, undefined));
  t = t.replace(/\b(\d+)(st|nd|rd|th)\b/gi, (_m, n: string) => ordinal(Number(n)));
  t = t.replace(new RegExp(`\\b(${MONTHS}) (\\d{1,2})\\b`, 'gi'), (_m, mo: string, d: string) => `${mo} ${ordinal(Number(d))}`);
  t = t.replace(/\b(1[5-9]\d\d|20\d\d)\b/g, (_m, y: string) => year(Number(y)));
  t = t.replace(/(\d+)%/g, '$1 percent');
  t = t.replace(/\b(\d[\d,]*)\b/g, m => cardinal(Number(m.replace(/,/g, ''))));
  t = t.replace(/\bDr\./g, 'doctor');
  // Mixed letter/digit codes (Q3, K7F2Q9) are spoken character by character.
  t = t.replace(/\b(?=\w*\d)(?=\w*[A-Za-z])\w+\b/g, m => [...m].map(c => (/\d/.test(c) ? ONES[Number(c)]! : c.toLowerCase())).join(' '));
  t = t.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9\s]/g, ' ');
  // A spoken "dash" and a written hyphen are the same thing; drop the word on both sides.
  return t.split(/\s+/).filter(w => w && w !== 'dash').map(w => (w === 'oh' ? 'zero' : w));
}

/** Word error counts (substitutions + deletions + insertions) against the reference. */
export function wordErrors(ref: string[], hyp: string[]): number {
  const d = Array.from({ length: ref.length + 1 }, (_, i) => [i, ...Array<number>(hyp.length).fill(0)]);
  for (let j = 1; j <= hyp.length; j += 1) d[0]![j] = j;
  for (let i = 1; i <= ref.length; i += 1) {
    for (let j = 1; j <= hyp.length; j += 1) {
      const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
    }
  }
  return d[ref.length]![hyp.length]!;
}

/**
 * The entity was heard if some run of hypothesis tokens spells it exactly,
 * ignoring only where the engine put spaces ("oak bridge" = "oakbridge").
 */
export function entityHeard(entity: string, hyp: string[]): boolean {
  const target = canonical(entity).join('');
  if (!target) return true;
  for (let i = 0; i < hyp.length; i += 1) {
    let acc = '';
    for (let j = i; j < hyp.length && acc.length < target.length; j += 1) {
      acc += hyp[j]!;
      if (acc === target) return true;
    }
  }
  return false;
}
