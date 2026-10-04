# Integer prices and default C preset

Application source: `672908939735e9095e5708640261b9d8a19bf0d0`.
Production deployment: `dpl_Bs4aiwMPdJuxgg8K4wTyWr97cEZq`, READY, aliased to https://vid2ppt.com.
Deployment URL: https://vid2deck-ed08pc0sr-ys-projects-5fb6bad4.vercel.app

Currency values on the localized pricing and pass pages now round to whole units for display. Currency minor-unit precision is still determined separately before display formatting; payment quotes and quantities retain their original precision.

ABCD use large 24px letters in distinct blue, amber, purple and teal badges. Each card uses the corresponding tinted background. Selection has a stronger colored border and a checkmark. Narrow screens through 600px use two columns, including the previously crowded 483px breakpoint.

The pass page defaults to the C reference budget (CNY 666) when the URL has no explicit quantity. The current CNY 9.90 unit quote gives 68 passes and a displayed CNY 673 total. The first live quote recalculates the default count if the unit price differs; explicit shared quantities and buyer edits take priority.

## Verification

- Local: all 122 frontend tests passed, including 52 payment/localization tests; build passed.
- Cloud: 84 backend and 122 frontend tests passed (206 total); production build and deployment completed successfully.
- Production JS and CSS match source bytes and SHA-256 exactly.
- Production browser: default C is selected at 68 passes; A/B/C/D badges use distinct colors and 24px letters; all visible prices use integer formatting. Choosing D gives 101 passes and displayed CNY 1,000; choosing C restores 68 and CNY 673.
- Desktop, 483px breakpoint and 390px mobile have zero horizontal overflow. Both narrow views use two columns. English pricing displays integer USD references and zero overflow.
- Purchase email was cleared from screenshots, no payment was submitted, and the temporary viewport override was reset.

Evidence: `checkout-ui-integer-live-2026-10-04.json`, `checkout-ui-integer-browser-2026-10-04.json`, `payment-qa/pass-default-c-integer-desktop-live-2026-10-04.png`, and `payment-qa/pass-default-c-integer-mobile-live-2026-10-04.png`.
