import { Vault } from '@jup-ag/lend-read';
import { Connection, PublicKey } from '@solana/web3.js';
import { getAccount } from '@solana/spl-token';

// getTokenLargestAccounts is unavailable on some public RPCs. The wallet read
// already knows the receipt token account. Resolve ownership from that account
// directly and revalidate on every SDK request, using the SDK's public override.
// All position accounting remains in the official Read SDK.
export class OwnerVerifiedVault extends Vault {
  constructor(private readonly connection: Connection, private readonly receiptAccount: PublicKey, private readonly expectedOwner: PublicKey) { super(connection); }
  override async getNftOwner(mint: PublicKey): Promise<PublicKey> {
    const receipt = await getAccount(this.connection, this.receiptAccount, 'confirmed');
    if (!receipt.mint.equals(mint) || receipt.amount !== 1n || !receipt.owner.equals(this.expectedOwner)) throw Error('Position NFT custody changed');
    return receipt.owner;
  }
}
