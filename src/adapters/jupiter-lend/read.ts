import { getVaultsProgram, readOraclePrice } from '@jup-ag/lend/borrow';
import { Connection, PublicKey } from '@solana/web3.js';
import { getAccount } from '@solana/spl-token';
import { VAULT_PROGRAM, verifiedVaults, byId, TOKEN_PROGRAM } from '@/config/instruments';
import { scaledDisplay } from '@/domain/amounts';
import type { Holding, Loan, MintState, PositionSelection, Source } from '@/domain/types';
import type { TokenAccount } from '@/adapters/solana/accounts';
import { safeError } from '@/adapters/solana/connection';
import { normalizePosition } from './normalize';
import { OwnerVerifiedVault } from './owner-vault';

export async function readSelectedPosition(connection: Connection, owner: PublicKey, selected: PositionSelection) {
  const registry = verifiedVaults.find(v => v.vaultId === selected.vaultId);
  if (!registry) throw Error('Selected vault is outside the verified xStock/USDC registry');
  const startSlot = await connection.getSlot();
  const program = getVaultsProgram({ connection });
  // Verify NFT custody before expensive protocol reads. Official IDL seeds:
  // position + vaultId(u16 LE) + positionId(u32 LE).
  const vaultSeed = Buffer.alloc(2); vaultSeed.writeUInt16LE(selected.vaultId);
  const positionSeed = Buffer.alloc(4); positionSeed.writeUInt32LE(selected.positionId);
  const address = PublicKey.findProgramAddressSync([Buffer.from('position'), vaultSeed, positionSeed], new PublicKey(VAULT_PROGRAM))[0];
  const raw = await program.account.position.fetch(address);
  if (raw.vaultId !== selected.vaultId || raw.nftId !== selected.positionId) throw Error('Position identity mismatch');
  // Owners can keep a position NFT in a non-ATA; do not assume ATA custody.
  const ownedNfts = await connection.getTokenAccountsByOwner(owner, { mint: raw.positionMint });
  let receiptAccount: PublicKey | null = null;
  for (const token of ownedNfts.value) {
    const decoded = await getAccount(connection, token.pubkey);
    if (decoded.owner.equals(owner) && decoded.mint.equals(raw.positionMint) && decoded.amount === 1n) receiptAccount = token.pubkey;
  }
  if (!receiptAccount) throw Error('The selected position NFT is not owned by this wallet');
  const vault = new OwnerVerifiedVault(connection, receiptAccount, owner);
  const position = await vault.getPositionByVaultId(selected.vaultId, selected.positionId);
  const config = await program.account.vaultConfig.fetch(position.vault.vault);
  if (config.vaultType !== 0 && config.vaultType !== 1) throw Error('Smart vault shares are outside the supported scope');
  if (config.supplyToken.toBase58() !== byId[registry.instrumentId].mint || config.borrowToken.toBase58() !== byId.USDC.mint) throw Error('Live vault mints do not match registry');
  let price: string | null = null;
  const issues: string[] = [];
  try { price = String((await readOraclePrice({ connection, oracle: config.oracle, signer: owner })).oraclePriceLiquidate); }
  catch (error) { issues.push(`Protocol oracle unavailable: ${safeError(error)}. LTV is unavailable.`); }
  const endSlot = await connection.getSlot();
  const chainTime = await connection.getBlockTime(startSlot);
  if (chainTime === null) throw Error('Loan observation time unavailable');
  const source: Source = { id: `jupiter-${selected.vaultId}-${selected.positionId}-${startSlot}`, label: 'Jupiter Lend SDK + onchain accounts',
    url: `https://explorer.solana.com/address/${address.toBase58()}`, observedAt: new Date(chainTime * 1000).toISOString(), retrievedAt: new Date().toISOString(),
    slot: startSlot, endSlot, kind: 'live', validity: endSlot - startSlot > 300 ? 'stale' : 'valid' };
  const loan = normalizePosition({ ...selected, owner: position.owner.toBase58(), requestedOwner: owner.toBase58(),
    positionAddress: address.toBase58(), positionMint: raw.positionMint.toBase58(), supplyMint: config.supplyToken.toBase58(), borrowMint: config.borrowToken.toBase58(),
    supply1e9: position.supply.toString(10), borrow1e9: position.borrow.toString(10), vaultType: config.vaultType,
    collateralFactorPermille: String(config.collateralFactor), liquidationThresholdPermille: String(config.liquidationThreshold),
    liquidationPenaltyBps: String(config.liquidationPenalty), liquidatePrice1e15: price, isLiquidated: position.isLiquidated, source });
  return { loan, issues };
}

export async function readLoans(connection: Connection, owner: PublicKey, accounts: TokenAccount[], states: MintState[], selection?: PositionSelection) {
  const program = getVaultsProgram({ connection });
  const issues: string[] = [];
  const receiptMints = new Set<string>();
  const selections: PositionSelection[] = [];
  let discoveryComplete = !selection;
  if (selection) { selections.push(selection); issues.push('Reading only the selected position. Other loans are outside this snapshot coverage.'); }
  else {
    const candidates = accounts.filter(a => a.tokenProgram === TOKEN_PROGRAM && a.raw === '1');
    if (candidates.length > 30) { discoveryComplete = false; issues.push('More than 30 candidate NFT accounts. Select a position to limit discovery.'); }
    for (const candidate of candidates.slice(0,30)) {
      try {
        const found = await program.account.position.all([{ memcmp: { offset: 14, bytes: candidate.mint } }]);
        for (const position of found) {
          receiptMints.add(candidate.mint);
          if (verifiedVaults.some(v => v.vaultId === position.account.vaultId)) selections.push({ vaultId: position.account.vaultId, positionId: position.account.nftId });
          else issues.push(`Jupiter vault ${position.account.vaultId} is unsupported and excluded from debt/equity totals.`);
        }
      } catch (error) { discoveryComplete = false; issues.push(`Position discovery failed: ${safeError(error)}. Use the explicit position selector.`); break; }
    }
  }
  const unique = [...new Map(selections.map(s => [`${s.vaultId}:${s.positionId}`, s])).values()];
  const loans: Loan[] = []; const deposited: Holding[] = [];
  for (const selected of unique) {
    try {
      const result = await readSelectedPosition(connection, owner, selected);
      loans.push(result.loan); issues.push(...result.issues); receiptMints.add(result.loan.positionMint);
      const instrument = byId[result.loan.collateralInstrumentId];
      const mintState = states.find(s => s.mint === instrument.mint);
      if (!mintState) { issues.push(`${instrument.symbol} posted quantity is unvalued: mint state unavailable.`); continue; }
      deposited.push({ id: `deposited:${result.loan.id}`, owner: owner.toBase58(), instrumentId: instrument.id,
        scope: 'deposited', accountIds: [result.loan.positionAddress], positionId: result.loan.id,
        rawAmount: result.loan.collateralAccountingRaw, rawUnit: 'protocol-1e9', decimals: 9,
        unscaledAmount: result.loan.collateralUnscaled, displayAmount: scaledDisplay(result.loan.collateralAccountingRaw, 9, mintState.multiplier),
        spendable: false, spendableRawAmount: '0', spendableAmount: '0', mintState, source: result.loan.source, referenceValue: null });
    } catch (error) { discoveryComplete = false; issues.push(`Loan ${selected.vaultId}/${selected.positionId}: ${safeError(error)}`); }
  }
  return { loans, deposited, receiptMints, issues, status: discoveryComplete && !issues.length ? 'ready' as const : loans.length ? 'partial' as const : 'blocked' as const };
}
