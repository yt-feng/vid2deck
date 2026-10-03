# One-time Pass currency references and bulk purchase landing

The existing independent landing is `/one-time-pass/`, using `PADDLE_PRICE_DAY_PASS`. Its base price is CNY 9.90, separate from the arbitrary-amount `AUTHOR_TIP_CNY_CENT` sponsor product. Production price preview confirmed a quantity range of 1–999999.

The user requested that conversion remain in the landing page, without modifying the Paddle account. The landing displays local exchange-rate references for all 33 supported languages, using daily CNY-base rates from ExchangeRate-API with attribution and a visible update date. The actual Paddle charge is shown separately and remains the currency returned by Paddle PricePreview (currently CNY). Reference prices carry an approximation sign when converted. No Paddle account settings or price objects were changed.

Billing country is passed consistently to Paddle preview and checkout. Changing language updates the reference currency; explicit regional locale tags and country changes also select the matching reference currency. Unit prices, tax, subtotal and total come from current Paddle price previews, then local references are calculated from the full unrounded amount. Quote generations prevent late responses from overwriting a changed order. Checkout cannot proceed with a missing or invalid quote.

The pass accepts whole quantities up to the lower of Paddle’s configured maximum and 999999. Quick controls offer 1, 10, 100 and 1000 units. The purchase link carries `lang`, `country`, `currency` and `quantity`; buyers may change them before paying. Language changes preserve the updated country and quantity. Return URLs preserve the same fields. Each purchased unit adds 24 hours to this purchase’s duration; existing calendar-month usage limits are unchanged.

The webhook now handles purchased quantities up to 999999 and continues to use authoritative Paddle line items rather than browser metadata. Regression tests cover 1000 units, 999999 units, misleading metadata and safe bounds.

## Validation

- Backend: 84 tests passed locally.
- Frontend: 103 tests passed locally, including 33-language currency defaults, FX and quote retry, race conditions, large orders and shared-link state.
- Production: `dpl_J3mKaffxGDqpCUWqeKXuf85x6R4V`, READY and aliased to `https://vid2ppt.com`; code commit `8c40adc`. Cloud build repeated all 187 tests and passed.
- All 40 public resources match source bytes, including all 33 dictionaries with 102 keys. Production configuration is complete. Anonymous entitlement requests and unsigned webhooks still return 401.
- Browser: English/US/1000 units shows approximately USD 1474.45 and actual CNY 9900.00. The real Paddle Checkout displayed 1000 units, CNY 9900.00 due today and the selected US country. Changing language retained the order and displayed EUR 1309.28 in French and JPY 232599 in Japanese.
- Screenshots and structured live evidence are saved in `docs/payment-qa/` and `paddle-currency-landing-live-2026-10-03.json`.
- No payment was submitted. Checkout opening is distinct from a completed paid order.

## Sources

- https://developer.paddle.com/paddle-js/methods/paddle-pricepreview/
- https://developer.paddle.com/paddle-js/methods/paddle-checkout-open/
- https://developer.paddle.com/build/products/offer-localized-pricing/
- https://www.exchangerate-api.com/docs/free
