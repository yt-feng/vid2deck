# vid2deck

## Architecture

The current production architecture and maintenance invariants are documented in [`docs/architecture.md`](docs/architecture.md). Update that document in the same PR or commit whenever payment, accounts, entitlements, cross-site grants, data storage, or deployment boundaries change.

## Online-video import

The website can accept YouTube, Bilibili and other video URLs from the same web UI. `/api/download-video` downloads one public video temporarily, returns it to the browser, and then the existing in-browser frame extraction flow continues locally.

The cloud downloader is intentionally limited so it can stay inside free hosting resources: no playlists, no DRM/paywalled/login-only sources, 720p-oriented formats, and a default `180 MB` file cap. Temporary files are removed immediately after the browser receives the video.

Useful options:

- `VID2PPT_CLOUD_MAX_DOWNLOAD_MB`: maximum single cloud download size, default `180`.
- `VID2PPT_CLOUD_YTDLP_FORMAT`: custom yt-dlp format selector.

## Paddle configuration

Author tips use `PADDLE_PRICE_AUTHOR_TIP_CNY_CENT` as a one-time Paddle Price ID. Configure it as a CNY 0.01 unit price; the frontend sends the selected amount as quantity in cents, so ¥10 is quantity `1000`. Custom tip input accepts ¥1 and up, but the checkout amount is rounded up to at least ¥10 to avoid low-value checkout failures.

Manual services use `PADDLE_PRICE_MANUAL_SERVICE_USD_CENT` as a shared one-time Paddle Price ID. Configure it as a USD 0.01 unit price with a high maximum quantity; the pricing page multiplies each service's displayed USD price by 100 and sends that as the Paddle quantity. For example, `$5 / hour` becomes quantity `500` for one hour and `$20 / page` becomes quantity `2000` for one page. To change manual service prices later, update the `data-unit-price-cents` values in `public/pricing/index.html` and redeploy; no new Paddle Price is needed.

## Lightweight accounts

Run `supabase/schema.sql` in the Supabase SQL editor. The app uses a simple `site_users` table for username/password login and keeps the existing `user_entitlements` / `usage_events` payment tables.

Required Vercel environment variables:

- `SUPABASE_URL`: the Supabase project URL, for example `https://xxxx.supabase.co`
- `SUPABASE_SERVICE_ROLE_KEY`: Supabase service role key for server-side API routes
- `AUTH_SECRET`: random signing secret for login and captcha tokens

Users can register with a username and optional email. If email is empty, the app generates `username@users.vid2ppt.com` so Paddle payments and entitlements still have a stable account email.
