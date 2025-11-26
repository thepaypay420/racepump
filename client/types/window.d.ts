declare global {
  interface Window {
    solana?: {
      isPhantom?: boolean;
      connect(): Promise<{ publicKey: { toString(): string } }>;
      signAndSendTransaction(transaction: any): Promise<{ signature: string }>;
      signTransaction(transaction: any): Promise<any>;
      signMessage(message: Uint8Array): Promise<{ signature: Uint8Array }>;
      on(event: string, handler: Function): void;
      off(event: string, handler: Function): void;
    };
  }
}

export {};