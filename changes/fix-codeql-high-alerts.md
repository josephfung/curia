### Security

- **Browser egress proxy** — forwarded headers use null-prototype objects, so a `__proto__` header cannot pollute.
- **Calendar availability** — Google group-calendar check matches `.calendar.google.com`, not look-alike domains.
- **OKF section parser** — heading regex no longer backtracks polynomially on long whitespace runs.
