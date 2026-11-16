"""Spoken-form text normaliser for G2P-based voices (Kokoro, Piper).

Pocket TTS reads digits itself; Kokoro and Piper hear only what the G2P
produces, and Moonshine's G2P turns "3:30 PM" into nonsense. Cartesia does
this normalisation server-side, so a local voice needs its own. Spike-grade:
it covers the sentence set (times, dates, ordinals, phone numbers, emails,
money, percentages, years, plain numbers), not the long tail.
"""

from __future__ import annotations

import re

ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
        "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"]
TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"]
ORD_IRREGULAR = {"one": "first", "two": "second", "three": "third", "five": "fifth", "eight": "eighth",
                 "nine": "ninth", "twelve": "twelfth"}
MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec"


def cardinal(n: int) -> str:
    if n < 0:
        return "minus " + cardinal(-n)
    if n < 20:
        return ONES[n]
    if n < 100:
        t, o = divmod(n, 10)
        return TENS[t] + ("-" + ONES[o] if o else "")
    if n < 1000:
        h, r = divmod(n, 100)
        return ONES[h] + " hundred" + (" " + cardinal(r) if r else "")
    for size, word in ((10**9, "billion"), (10**6, "million"), (1000, "thousand")):
        if n >= size:
            q, r = divmod(n, size)
            return cardinal(q) + " " + word + (" " + cardinal(r) if r else "")
    return str(n)


def ordinal(n: int) -> str:
    words = cardinal(n)
    head, _, last = words.rpartition("-") if "-" in words.split(" ")[-1] else words.rpartition(" ")
    sep = "-" if "-" in words.split(" ")[-1] else " "
    if last in ORD_IRREGULAR:
        last = ORD_IRREGULAR[last]
    elif last.endswith("y"):
        last = last[:-1] + "ieth"
    else:
        last = last + "th"
    return (head + sep if head else "") + last


def year(n: int) -> str:
    if 2000 <= n <= 2009:
        return cardinal(n)
    hi, lo = divmod(n, 100)
    if lo == 0:
        return cardinal(hi) + " hundred"
    return cardinal(hi) + " " + (("oh " + ONES[lo]) if lo < 10 else cardinal(lo))


def digits(s: str) -> str:
    return " ".join(ONES[int(c)] for c in s if c.isdigit())


# Letter names as words: a G2P reads a bare "A" as the article and "C" alone
# can come out as "sea", so ".ca" became "dot sea" and "AM" became "am".
LETTERS = {"a": "ae", "b": "bee", "c": "see", "d": "dee", "e": "ee", "f": "eff", "g": "jee", "h": "aitch",
           "i": "eye", "j": "jay", "k": "kay", "l": "el", "m": "em", "n": "en", "o": "oh", "p": "pee", "q": "cue",
           "r": "ar", "s": "ess", "t": "tee", "u": "you", "v": "vee", "w": "double you", "x": "ex", "y": "why", "z": "zee"}


def spell(s: str) -> str:
    return " ".join(LETTERS.get(c.lower(), c) for c in s if c.strip())


def _time(m: re.Match[str]) -> str:
    h, mm, ampm = int(m.group(1)), m.group(2), m.group(3)
    out = cardinal(h)
    if mm and mm != "00":
        out += " " + (("oh " + ONES[int(mm)]) if mm.startswith("0") else cardinal(int(mm)))
    elif mm == "00" and not ampm:
        out += " o'clock"
    if ampm:
        out += " " + spell(ampm.replace(".", "").lower())
    return out


def _email(m: re.Match[str]) -> str:
    user, domain = m.group(1), m.group(2)

    def part(p: str) -> str:
        p = p.replace(".", " dot ").replace("_", " underscore ").replace("-", " dash ")
        p = re.sub(r"\d+", lambda d: digits(d.group(0)), p)
        # A one- or two-letter piece ("priya.r") is a letter, not a word.
        return re.sub(r"\b[A-Za-z]{1,2}\b", lambda w: w.group(0) if w.group(0).lower() in ("at", "dot") else spell(w.group(0)), p)

    labels = domain.split(".")
    tld = labels[-1]
    spoken_tld = tld if tld.lower() in ("com", "org", "net", "edu", "gov", "io") else spell(tld)
    return part(user) + " at " + " dot ".join([part(x) for x in labels[:-1]] + [spoken_tld])


def _phone(m: re.Match[str]) -> str:
    groups = re.findall(r"\d+", m.group(0))
    return ", ".join(digits(g) for g in groups)


def _money(m: re.Match[str]) -> str:
    whole = int(m.group(1).replace(",", ""))
    cents = m.group(2)
    out = cardinal(whole) + (" dollar" if whole == 1 else " dollars")
    if cents and int(cents):
        out += " and " + cardinal(int(cents)) + " cents"
    return out


def normalize(text: str) -> str:
    t = text
    t = re.sub(r"\b([\w.+-]+)@([\w-]+(?:\.[\w-]+)+)\b", _email, t)
    t = re.sub(r"(?<!\w)(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b", _phone, t)
    t = re.sub(r"\$(\d[\d,]*)(?:\.(\d{2}))?", _money, t)
    t = re.sub(r"\b(\d{1,2})(?::(\d{2}))?\s*([AaPp]\.[Mm]\.|[AaPp][Mm]\b)", _time, t)
    t = re.sub(r"\b(\d{1,2}):(\d{2})()\b", _time, t)
    t = re.sub(r"\b(\d+)(st|nd|rd|th)\b", lambda m: ordinal(int(m.group(1))), t)
    # "November 18" → "November eighteenth"
    t = re.sub(rf"\b({MONTHS})\.? (\d{{1,2}})\b", lambda m: m.group(1) + " " + ordinal(int(m.group(2))), t)
    t = re.sub(r"\b(1[5-9]\d\d|20\d\d)\b", lambda m: year(int(m.group(1))), t)
    # Mixed letter/digit codes (Q3, K7F2Q9) are read character by character.
    t = re.sub(r"\b(?=\w*\d)(?=\w*[A-Za-z])[A-Za-z0-9]+\b",
               lambda m: " ".join(LETTERS[c.lower()] if c.isalpha() else ONES[int(c)] for c in m.group(0)), t)
    t = re.sub(r"(\d+(?:\.\d+)?)%", lambda m: m.group(1) + " percent", t)
    t = re.sub(r"\b(\d[\d,]*)\.(\d+)\b", lambda m: cardinal(int(m.group(1).replace(",", ""))) + " point " + digits(m.group(2)), t)
    t = re.sub(r"\b\d[\d,]*\b", lambda m: cardinal(int(m.group(0).replace(",", ""))), t)
    return t


if __name__ == "__main__":
    import sys

    print(normalize(" ".join(sys.argv[1:])))
