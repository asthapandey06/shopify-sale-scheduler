/**
 * Whether the Sales list sends the merchant to the Plan page.
 * - An active plan: no.
 * - Prices still changed by a sale: no, the merchant must be able to reach it to restore them.
 * - Paused: no. Pause cancels the plan but keeps the history, which must stay readable; the page shows a
 *   Resume banner that leads back to the Plan page.
 * - Otherwise (new install, declined or lapsed plan): yes (App Store requirement 1.2.2).
 */
export function shouldRedirectToPlan(state: { hasActivePayment: boolean; paused: boolean; changedPrices: number }): boolean {
  if (state.hasActivePayment) return false;
  if (state.paused) return false;
  return state.changedPrices === 0;
}
