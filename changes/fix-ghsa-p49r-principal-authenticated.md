### Security

- **Unverified principal messages** — SMS or email failing SPF/DKIM/DMARC no longer carries the principal's authority. (GHSA-p49r-jqh2-v668)
- **Confirm on a verified channel** — such requests file an approval delivered only to Signal, Slack or the app. (GHSA-p49r-jqh2-v668)
- **Approval delivery** — SMS no longer carries approvals; unverified-request approvals are capped at three an hour. (GHSA-p49r-jqh2-v668)
- **Local CLI** — counts as an authenticated principal channel. (GHSA-p49r-jqh2-v668)
- **Unverified principal email** — gets a reply to its sender only, never reply-all. (GHSA-p49r-jqh2-v668)
- **Email sender authentication** — also requires SPF aligned with the From domain, refusing replayed signed mail. (GHSA-p49r-jqh2-v668)
