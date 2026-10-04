# Localized storefront and one-time pass UI

Source commit: `fd56912b14f6aeb550610b628bc4769103bac33e`.
Production deployment: `dpl_37X6yQixQJhvbNLW6dJKaLK9E8ao`, READY, aliased to `https://vid2ppt.com` and `https://www.vid2ppt.com`.
Deployment URL: https://vid2deck-201gbre7m-ys-projects-5fb6bad4.vercel.app

The English homepage, localized pricing page and independent one-time pass now share the same warm green visual system. The homepage illustrates original video frames becoming reviewable notes; pricing emphasizes each plan and its purchase action. A compact globe menu contains flag-labelled native language and billing-country selectors. Country/currency remain consistent through page links and language changes.

The pass form starts with a large editable number and 44px-plus decrement/increment targets. Focusing the input selects the current number; invalid or oversized entries can be recovered with the controls. Price requests are debounced and stale responses cannot overwrite the newer order. Quantity, current tax and final estimated total continue to use authoritative Paddle previews.

Quick selections use the four requested CNY reference budgets, rounded upward to whole passes using the live Paddle unit quote. The current CNY 9.90 quote yields:

| Approximate CNY budget | Pass quantity | Actual CNY total in the verified China quote |
| --- | --- | --- |
| 66 | 7 | 69.30 |
| 178 | 18 | 178.20 |
| 666 | 68 | 673.20 |
| 999 | 101 | 999.90 |

Other locales display these budget references and pass totals in the selected local currency. The actual Paddle charge stays explicit. No Paddle account configuration or price objects were modified. A same-currency quote remains payable without the exchange-rate feed; converted references require rates. Quantity limits still follow Paddle, capped at 999999. Multiple passes extend access duration, retaining the existing monthly usage limits.

The purchase-link input is removed from the customer UI. Existing shareable query URLs still work. Policy details, exchange-rate attribution and post-purchase account tools are compact disclosures. Mobile layout puts quantity and budgets earlier; Arabic retains RTL layout.

## Validation

- Local frontend: 116 tests passed, including 46 global payment regressions; production build passed.
- Cloud build: 84 backend tests plus all 116 frontend tests passed (200 total), followed by successful production build and deployment.
- Live bytes: 41/41 public resources match source SHA-256; all 33 language files have 107 keys with exact placeholders. Production Paddle configuration is complete. Anonymous entitlement and unsigned webhook requests return 401.
- Live browser: all four budget quantities/totals, +/- controls, manual quantity 12, country and language switching, English homepage and pricing, Pro selection, Chinese globe menu, mobile and Arabic RTL were verified. Checked pages have zero horizontal overflow.
- Real Paddle checkout opened for 7 passes, showing CNY 69.30 and Simplified Chinese. No payment was submitted.
- Temporary local preview was closed and browser viewport override was restored. The production pass tab remains as the deliverable.

Evidence: `checkout-ui-live-2026-10-04.json`, `checkout-ui-browser-2026-10-04.json`, and dated screenshots in `payment-qa/`.

## Customer copy and A–D follow-up

Current application source: `22712c86ebbc22a34c0cc89935892546bd778949`.
Current production deployment: `dpl_9keJHAzeyHgaZZVaWNQJ3zCzzMJ1`, READY, aliased to `https://vid2ppt.com` and `https://www.vid2ppt.com`.
Deployment URL: https://vid2deck-5fa7yh0a5-ys-projects-5fb6bad4.vercel.app

The four budget buttons now carry stable A, B, C and D labels in every locale, respectively mapping to the CNY 66, 178, 666 and 999 reference budgets. The quantities at the verified CNY 9.90 unit quote remain 7, 18, 68 and 101. The entire processed-by-Paddle paragraph is removed. Customer copy across all 33 locales uses ordinary purchase, account and renewal wording without provider or webhook implementation details. The actual charge and currency remain visible as useful order information.

- Latest local and cloud frontend suites: 117 tests passed, including 47 global payment regressions. The cloud build also passed 84 backend tests, for 201 total tests.
- Latest production resource verification: 41/41 resources match this source, all 33 locale files have 107 keys with matching placeholders, and all three configuration/authentication API checks passed.
- Latest Chinese desktop browser snapshot: A–D labels, quantities and totals match the requested mapping; quantity is 7, actual charge is CNY 69.30, no provider/webhook copy is visible, and horizontal overflow is zero at 1280×900.
- This follow-up changes copy and button labels. Earlier interaction, mobile/RTL and checkout observations above retain their original source/deployment provenance. No paid order was submitted.

Current evidence: `checkout-ui-clean-live-2026-10-04.json`, `checkout-ui-clean-browser-2026-10-04.json`, and `payment-qa/pass-abcd-clean-desktop-live-2026-10-04.jpg`.
