# Contact form and domain email

## Production configuration

- Public contact address: `info@vid2ppt.com`.
- Contact page: `https://vid2ppt.com/contact/`.
- The Cloudflare Email Routing catch-all rule is active for `vid2ppt.com`, forwarding to the owner's verified private mailbox. No individual address rules override it.
- Cloudflare reports Email Routing enabled and DNS records locked. Public DNS resolves all three Cloudflare MX records.
- Cloudflare Email Sending is enabled for `vid2ppt.com`, with sending DNS authentication configured.
- Contact form mail is sent to `info@vid2ppt.com`, then forwarded by the same catch-all rule.
- Production secrets are stored in Vercel. The application uses a dedicated token with the Email Sending permission; visitor replies use the submitted reply-to address.
- A dedicated Managed Turnstile widget accepts only `vid2ppt.com` and `www.vid2ppt.com`, with the `contact` action checked on the server. Pre-clearance is disabled.

## Implementation

- `/api/contact` routes to the existing usage function before ordinary request parsing or authentication, preserving the 12-function deployment footprint.
- Fields: optional name (100), required email (254), subject (160), and message (10–5,000). The API limits request bodies to 32 KiB.
- The browser prevents overlapping submissions, preserves content on failure, and refreshes single-use verification tokens after each request.
- A stable public reference is included in the email subject and service logs. Cloudflare's API acknowledgement must include the expected recipient as delivered or queued; rejected mail never reports success.
- The provider has no documented request deduplication guarantee. An ambiguous transport timeout may need the reference checked before retrying.
- The private forwarding destination and secret values are absent from public page content.

## Verification

- Frontend contact regressions, API validation, provider rejection, origin checks, and Turnstile failure tests pass.
- Vercel production deployment `dpl_Cwy7rn87BSuRYxFucMkRBzLNJgMB` is READY and aliased to the primary and www domains. The production contact page matches its source file byte for byte, including the real sitekey and 45-second request timeout.
- Chrome completed Turnstile and submitted the actual production contact form. Receipt: `V2P-0884320E8FF845E495DF`; provider message ID: `<qNbohVfnuMrFzveklCJmDd0pEzkwCFv2bztE@vid2ppt.com>`.
- Cloudflare's activity log confirms that message to `info@vid2ppt.com` was **Forwarded** at 10:27:04 Asia/Shanghai on 2026-09-08. Event action: Forward. SPF, DKIM, and DMARC: pass. The active catch-all rule has the owner's verified mailbox as its destination.
- An earlier provider connectivity test (`V2P-1F848984D2A3415FB37D`) was separately confirmed **Delivered** to the owner mailbox. Provider delivery evidence was inspected; the recipient inbox UI was not opened.
- Live API checks: missing verification returns 400, cross-origin submission returns 403, and GET returns 405. Invalid requests do not send mail.
- Seven public routes return successfully with contact links and no old support address or private destination in their HTML. The sponsor page links to the contact page without repeating the mailbox. Results: `contact-http-smoke-2026-09-08.json`.
- Desktop and 390-pixel mobile layouts were visually inspected with no horizontal overflow. Actual submission was tested in Chrome; the embedded preview did not complete Turnstile and was used only for layout inspection.
