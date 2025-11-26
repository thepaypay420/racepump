import Decimal from 'decimal.js';

// Configure Decimal.js for financial calculations
Decimal.set({
  precision: 28,
  rounding: Decimal.ROUND_DOWN,
  toExpNeg: -9,
  toExpPos: 20,
});

export { Decimal };

// Format token amounts for display
export function formatTokenAmount(amount: string | number, decimals: number = 9): string {
  const decimal = new Decimal(amount);
  const divisor = new Decimal(10).pow(decimals);
  const formatted = decimal.div(divisor);
  
  return formatted.toFixed();
}

// Parse user input to token amount (with decimals)
export function parseTokenAmount(input: string, decimals: number = 9): string {
  const decimal = new Decimal(input);
  const multiplier = new Decimal(10).pow(decimals);
  const tokenAmount = decimal.mul(multiplier);
  
  return tokenAmount.toFixed(0);
}

// Calculate implied odds for parimutuel betting
export function calculateImpliedOdds(
  runnerTotal: string,
  totalPot: string,
  rakeBps: number = 300
): string {
  const runnerDecimal = new Decimal(runnerTotal);
  const potDecimal = new Decimal(totalPot);
  
  if (runnerDecimal.eq(0)) {
    return "∞"; // Infinite odds if no bets
  }
  
  // Calculate net pool after rake
  const rakeDecimal = new Decimal(rakeBps).div(10000);
  const netPool = potDecimal.mul(new Decimal(1).sub(rakeDecimal));
  
  // Parimutuel odds: net pool / runner total
  const odds = netPool.div(runnerDecimal);
  
  return odds.toFixed(2);
}

// Calculate potential payout
export function calculatePayout(
  betAmount: string,
  impliedOdds: string
): string {
  const betDecimal = new Decimal(betAmount);
  const oddsDecimal = new Decimal(impliedOdds);
  
  return betDecimal.mul(oddsDecimal).toFixed(2);
}

// Format large numbers with suffixes
export function formatLargeNumber(num: number | string | undefined): string {
  if (num === undefined || num === null || num === '') {
    return '0';
  }
  const number = new Decimal(num);
  if (number.isNegative()) {
    return '0';
  }
  
  if (number.gte(1000000)) {
    return number.div(1000000).toFixed(1) + "M";
  } else if (number.gte(1000)) {
    return number.div(1000).toFixed(1) + "K";
  } else {
    // For smaller numbers, show up to 3 decimal places, removing trailing zeros
    return number.toFixed(3).replace(/\.?0+$/, '');
  }
}

// Format percentage
export function formatPercentage(decimal: string | number): string {
  const percent = new Decimal(decimal).mul(100);
  return percent.toFixed(1) + "%";
}

// Validate amount input
export function validateAmount(
  input: string,
  maxAmount?: string,
  minAmount: string = "0"
): { valid: boolean; error?: string } {
  try {
    const amount = new Decimal(input);
    const min = new Decimal(minAmount);
    
    if (amount.lte(min)) {
      return { valid: false, error: `Amount must be greater than ${minAmount}` };
    }
    
    if (maxAmount) {
      const max = new Decimal(maxAmount);
      if (amount.gt(max)) {
        return { valid: false, error: `Amount cannot exceed ${maxAmount}` };
      }
    }
    
    return { valid: true };
  } catch (error) {
    return { valid: false, error: "Invalid amount" };
  }
}
