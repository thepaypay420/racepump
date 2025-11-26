import test from "node:test";
import assert from "node:assert/strict";
import Decimal from "decimal.js";
import { splitSwapAmounts } from "../server/raceswap";

test("splitSwapAmounts conserves total", () => {
  const total = new Decimal(1_000_000);
  const { reflectionAmount, treasuryAmount, mainAmount } = splitSwapAmounts(total, 100, 20);
  assert.equal(
    reflectionAmount.add(treasuryAmount).add(mainAmount).toString(),
    total.toString(),
    "all portions should add up to the total"
  );
  assert.equal(reflectionAmount.toNumber(), 10000);
  assert.equal(treasuryAmount.toNumber(), 2000);
  assert.equal(mainAmount.toNumber(), 988000);
});

test("splitSwapAmounts throws on invalid configuration", () => {
  const total = new Decimal(10_000);
  assert.throws(() => splitSwapAmounts(total, 8000, 3000), /Invalid fee configuration/);
  assert.throws(() => splitSwapAmounts(new Decimal(0), 100, 20), /must be positive/);
});
