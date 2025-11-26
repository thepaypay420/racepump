export interface ReflectionTokenMeta {
  mint: string;
  symbol: string;
  name: string;
  logoURI?: string;
  decimals: number;
  raceId?: string;
  lastUpdated: number;
  disabledReason?: string;
  reflectionEnabled?: boolean;
}

export interface RaceswapPublicConfig {
  programId: string;
  configAddress: string;
  swapAuthority: string;
  treasuryWallet: string;
  reflectionFeeBps: number;
  treasuryFeeBps: number;
  reflectionEnabled: boolean;
  reflectionDisabledReason?: string;
}

export interface RaceswapTokenInfo {
  address: string;
  symbol: string;
  name: string;
  logoURI?: string;
  decimals: number;
  dailyVolumeUsd?: number;
  priorityScore?: number;
}

export interface RaceswapPlanRequest {
  inputMint: string;
  outputMint: string;
  amount: string;
  slippageBps?: number;
  disableReflection?: boolean;
}

export interface JupiterInstructionPayload {
  accounts: string[];
  isWritable: boolean[];
  isSigner: boolean[];
  data: string;
}

export interface RaceswapPlanLeg {
  payload: JupiterInstructionPayload;
}

export interface RaceswapPlanResponse {
  inputMint: string;
  outputMint: string;
  reflectionMint?: string;
  totalAmount: string;
  reflectionAmount: string;
  treasuryAmount: string;
  mainAmount: string;
  minMainOut: string;
  minReflectionOut: string;
  disableReflection: boolean;
  reflectionDisabledReason?: string;
  reflectionMeta: ReflectionTokenMeta;
  mainLeg: RaceswapPlanLeg;
  reflectionLeg?: RaceswapPlanLeg;
  accounts: string[];
  accountMetas: {
    isWritable: boolean;
    isSigner: boolean;
  }[];
  quoteExpiresAt: number;
  feeConfig: {
    reflectionFeeBps: number;
    treasuryFeeBps: number;
  };
  treasuryWallet: string;
  programId: string;
  configAddress: string;
  swapAuthority: string;
  inputVault: string;
  jupiterProgramId: string;
  addressLookupTableAddresses?: string[];
  inputDecimals: number;
  outputDecimals: number;
  computeUnitLimit?: number;
  computeUnitPrice?: string;
}
