# One-time Pass currency references and bulk purchase landing

The existing independent landing is `/one-time-pass/`, using `PADDLE_PRICE_DAY_PASS`. Its base price is CNY 9.90, separate from the arbitrary-amount `AUTHOR_TIP_CNY_CENT` sponsor product. Production price preview confirmed a quantity range of 1–999999.

The user requested that conversion remain in the landing page, without modifying the Paddle account. The landing displays local exchange-rate references for all 33 supported languages, using daily CNY-base rates from ExchangeRate-API with attribution and a visible update date. The actual Paddle charge is shown separately and remains the currency returned by Paddle PricePreview (currently CNY). Reference prices carry an approximation sign when converted. No Paddle account settings or price objects were changed.

Billing country is passed consistently to Paddle preview and checkout. Changing language updates the reference currency; explicit regional locale tags and country changes also select the matching reference currency. Unit prices, tax, subtotal and total come from current Paddle price previews, then local references are calculated from the full unrounded amount. Quote generations prevent late responses from overwriting a changed order. Checkout cannot proceed with a missing or invalid quote.

The pass accepts whole quantities up to the lower of Paddle’s configured maximum and 999999. Quick controls offer 1, 10, 100 and 1000 units. The purchase link carries `lang`, `country`, `currency` and `quantity`; buyers may change them before paying. Language changes preserve the updated country and quantity. Return URLs preserve the same fields. Each purchased unit adds 24 hours to this purchase’s duration; existing calendar-month usage limits are unchanged.

The webhook now handles purchased quantities up to 999999 and continues to use authoritative Paddle line items rather than browser metadata. Regression tests cover 1000 units, 999999 units, misleading metadata and safe bounds.

## Validation

- Backend: 84 tests passed locally.
- Frontend: 103 tests passed locally, including 33-language currency defaults, FX and quote retry, race conditions, large orders and shared-link state.
- Production acceptance: pending deployment.
- No payment was submitted. Checkout opening is distinct from a completed paid order.

## Sources

- https://developer.paddle.com/paddle-js/methods/paddle-pricepreview/
- https://developer.paddle.com/paddle-js/methods/paddle-checkout-open/
- https://developer.paddle.com/build/products/offer-localized-pricing/
- https://www.exchangerate-api.com/docs/free
