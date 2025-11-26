import { AnchorProvider, Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";

const DEFAULT_RPC =
  process.env.RPC_URL ||
  "https://spring-cold-tree.solana-mainnet.quiknode.pro/24011188359c3607a1ed91ac2ecbfe22b8e39681/";

function createDummyWallet() {
  const keypair = Keypair.generate();
  return {
    publicKey: keypair.publicKey,
    signTransaction: async (tx: Transaction) => {
      tx.partialSign(keypair);
      return tx;
    },
    signAllTransactions: async (txs: Transaction[]) => {
      return txs.map((tx) => {
        tx.partialSign(keypair);
        return tx;
      });
    },
  };
}

async function main() {
  const programId = new PublicKey(
    process.env.RACESWAP_PROGRAM_ID || "Cy63SzwBBCP5ywaByjUrLuUXQ4pXP9nR7e7kdQqp5uLk"
  );

  const connection = new Connection(DEFAULT_RPC, "confirmed");
  const wallet = createDummyWallet();
  const provider = new AnchorProvider(connection, wallet as any, {
    commitment: "confirmed",
  });

  const idl = await Program.fetchIdl(programId, provider);
  if (!idl) {
    console.error("Failed to fetch IDL for program", programId.toBase58());
    process.exit(1);
  }
  console.log(JSON.stringify(idl, null, 2));
}

main().catch((err) => {
  console.error("IDL fetch failed:", err);
  process.exit(1);
});
