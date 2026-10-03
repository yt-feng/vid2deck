# Vid2PPT payment localization — 2026-10-03

The production baseline was deployment `dpl_7VqdkJxt7T1inMWmLYihrHQvawrC`, READY and bound to vid2ppt.com. Its live pricing HTML matched the clean `d0a9925` checkout. Changes were made in a separate managed worktree; the original dirty checkout was preserved.

## Delivered scope

- Product landing `/welcome/`, pricing `/pricing/` and independent purchase `/one-time-pass/` have 33 complete languages, 89 translated strings each.
- Root homepage chooses the language from the explicit `lang` parameter, saved choice, browser language preferences, then English. App links `#start`, `#workspace` and `#account` continue to open the existing application. Marketing anchors redirect to the selected-language landing page.
- The editing workspace, blog, guides and existing policy documents continue to use Chinese. Localized product/payment pages disclose the editor language.
- Paddle Checkout gets the page language for its 19 supported locales; the remaining 14 use English with an explicit localized notice. Return URLs keep the page language. Paddle `_ptxn` payment links remain supported.
- Prices remain CNY 39/month (Pro), CNY 498 once (Lifetime), and CNY 9.90 per day pass. Paddle displays actual checkout totals and taxes.
- Day-pass purchased quantity now grants 24 hours per unit, derived from authoritative purchased line items. Stable Paddle purchase timestamps keep duplicate deliveries from extending the same purchase. Monthly allowances do not multiply and reset at calendar-month boundaries; this is explained in all languages.
- Customer metadata no longer selects a paid plan by injecting unrelated price IDs.

## Evidence boundaries

The original production Paddle Pro checkout opened in the browser in English and showed CN¥39/month. No payment was submitted. The public production configuration had all required price IDs and a production client token. Vercel's environment-variable names confirmed presence of the webhook secret and Supabase variables without retrieving their values.

Opening a checkout and passing mocked webhook tests do not demonstrate a real charge followed by a production entitlement write. That final buyer flow remains unverified until a real purchase and resulting account access are checked.

## Validation

- Complete locale key, placeholder and numeric-copy checks.
- Language precedence, browser-region aliases, explicit English fallback, Arabic RTL and language retention after payment.
- Checkout email/quantity validation, duplicate-click locking, retry after configuration failure, authenticated entitlement lookup, and success-query handling that does not invent active access.
- Webhook tests for authoritative purchased prices and single/multiple day-pass duration.
- Existing product, export, blog, contact and API regression suites plus TypeScript/Vite production build.

Paddle locale contract: https://developer.paddle.com/paddle-js/methods/paddle-checkout-open/
