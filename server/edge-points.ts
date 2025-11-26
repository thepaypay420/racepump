import Decimal from "decimal.js";

export interface EdgePointsInput {
  betAmount: string; // decimal string
  payoutAmount: string; // decimal string
  totalPot: string; // decimal string
  win: boolean;
}

/**
 * Compute Edge Points for a single race result for a wallet.
 * Heavily scaled to thousands+ to feel meaningful.
 * Factors:
 * - Win bonus
 * - Bet size and payout size (sqrt scaling to reduce whales dominating)
 * - Efficiency multiplier (payout relative to bet)
 * - Pot multiplier (bigger pots slightly boost points)
 * - Losses receive reduced points but never negative
 */
export function computeEdgePoints(input: EdgePointsInput): string {
  const bet = new Decimal(input.betAmount || "0").abs();
  const payout = new Decimal(input.payoutAmount || "0").abs();
  const totalPot = new Decimal(input.totalPot || "0").abs();
  const win = Boolean(input.win) && payout.gt(0);

  // Base points
  let points = new Decimal(1000);
  if (win) points = points.add(5000);

  // Normalize by pot share to be currency-agnostic
  const safePot = totalPot.lte(0) ? new Decimal(1) : totalPot;
  const betShare = Decimal.min(1, bet.div(safePot));
  const payoutShare = Decimal.min(1, payout.div(safePot));

  // Pot-share based contributions (sqrt damping)
  const betContribution = betShare.sqrt().mul(6000);
  const payoutContribution = payoutShare.sqrt().mul(9000);
  points = points.add(betContribution).add(payoutContribution);

  // Efficiency: payout-to-bet ratio, capped to avoid runaway
  const efficiency = bet.gt(0) ? payout.div(bet) : new Decimal(0);
  const efficiencyContribution = Decimal.min(new Decimal(5), efficiency).mul(1000);
  points = points.add(efficiencyContribution);

  // Pot multiplier: remove unit bias; give small boost for meaningful participation
  // Use the user's own bet share as a soft proxy for competitiveness (0..1)
  const potMultiplier = new Decimal(1).add(betShare.mul(0.15));
  points = points.mul(potMultiplier);

  // Loss reduction and floor
  if (!win) points = points.mul(0.7);
  const floored = points.toDecimalPlaces(0, Decimal.ROUND_DOWN);
  const minFloor = new Decimal(500);
  return Decimal.max(floored, minFloor).toString();
}

