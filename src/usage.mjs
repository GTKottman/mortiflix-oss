// What a project's Claude usage cost, in words the owner can trust. Claude Code reports a list-price cost for every
// session; on a Claude plan (subscription login) that money was never charged, so it's shown as what the work
// would have cost at API prices. On an API key it's real spend.
const money = (v) => `$${v.toFixed(2)}`;

export function costText(usage = {}) {
  const total = Number(usage.cost_usd) || 0;
  if (!(total > 0)) return null;
  const plan = Math.min(total, Number(usage.plan_usd) || 0);
  const api = Math.max(0, total - plan);
  if (plan > 0 && api < 0.005) return `Would have cost about ${money(plan)} at API prices. On your Claude plan, you didn't pay that.`;
  if (plan < 0.005) return `About ${money(api)} spent on the Claude API.`;
  return `About ${money(api)} spent on the Claude API, plus about ${money(plan)} of work on your Claude plan that you didn't pay for.`;
}
