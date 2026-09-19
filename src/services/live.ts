import 'server-only';
import { PublicKey } from '@solana/web3.js';
import { createConnection, safeError, verifyCluster } from '@/adapters/solana/connection';
import { normalizeAccounts, readMintStates, readWalletAccounts, readWalletAssetAmounts } from '@/adapters/solana/accounts';
import { holdingsSnapshots } from '@/adapters/holdings/snapshots';
import { normalizeOtherWalletAssets, readJupiterAccount, readJupiterPrices, readTokenMetadata, type JupiterTokenMetadata } from '@/adapters/jupiter-api/read';
import { byId } from '@/config/instruments';
import { readXstockIdentities } from '@/adapters/xstocks/assets';
import { decimal, fromBaseUnits, scaledDisplay } from '@/domain/amounts';
import { referenceValue } from '@/domain/valuation';
import { PortfolioResultSchema, type Holding, type Portfolio, type PortfolioProvider, type PriceObservation, type WalletAsset } from '@/domain/types';

export const liveProvider: PortfolioProvider = {
  async read(owner, signal, selection) {
    if (!owner) return { status: 'error', code: 'WALLET_REQUIRED', message: 'Connect a wallet to read live accounts.' };
    try { new PublicKey(owner); } catch { return { status: 'error', code: 'INVALID_WALLET', message: 'Invalid Solana address.' }; }
    const connection = createConnection(signal);
    const issues: string[] = [];
    const jupiterPromise = readJupiterAccount(owner, signal);
    let wallet: Awaited<ReturnType<typeof readWalletAccounts>> | null = null;
    let mint: Awaited<ReturnType<typeof readMintStates>> = { states: [], issues: [] };
    try {
      await verifyCluster(connection);
      [wallet, mint] = await Promise.all([readWalletAccounts(connection, new PublicKey(owner)), readMintStates(connection)]);
      issues.push(...mint.issues);
    } catch (error) {
      if (error instanceof Error && error.message.includes('RPC cluster does not match')) {
        return { status: 'error', code: 'WRONG_CLUSTER', message: 'Configured RPC cluster does not match Solana mainnet.' };
      }
      issues.push(`Solana wallet-account read unavailable: ${safeError(error)}. Jupiter protocol positions are still shown when its API succeeds.`);
    }
    const jupiter = await jupiterPromise;
    issues.push(...jupiter.issues);
    let loans = jupiter.loans;
    let unmodeledLoans = jupiter.unmodeledLoans;
    if (selection) {
      loans = loans.filter(loan => loan.vaultId === selection.vaultId && loan.positionId === selection.positionId);
      unmodeledLoans = unmodeledLoans.filter(loan => loan.vaultId === selection.vaultId && loan.positionId === selection.positionId);
      issues.push('Reading only the selected position. Other loans are outside this snapshot coverage.');
      if (!loans.length && !unmodeledLoans.length) issues.push(`Jupiter position ${selection.vaultId}/${selection.positionId} was not returned for this owner.`);
    }
    const deposited: Holding[] = [];
    for (const loan of loans) {
      const instrument = byId[loan.collateralInstrumentId];
      const state = mint.states.find(row => row.mint === instrument.mint);
      if (!state) { issues.push(`${instrument.symbol} posted quantity is not in the holdings total because its onchain mint state was unavailable.`); continue; }
      deposited.push({ id: `deposited:${loan.id}`, owner, instrumentId: instrument.id, scope: 'deposited', accountIds: [loan.positionAddress], positionId: loan.id,
        rawAmount: loan.collateralAccountingRaw, rawUnit: 'protocol-1e9', decimals: 9, unscaledAmount: loan.collateralUnscaled,
        displayAmount: scaledDisplay(loan.collateralAccountingRaw, 9, state.multiplier), spendable: false, spendableRawAmount: '0', spendableAmount: '0',
        mintState: state, source: loan.source, referenceValue: null });
    }
    let holdings: Holding[] = [...deposited];
    let walletAssets: WalletAsset[] = [];
    let unsupported: { mint: string; accountCount: number; reason: string }[] = [];
    let prices: Portfolio['prices'] = [];
    if (wallet) {
      const normalized = normalizeAccounts(wallet.accounts, owner, mint.states, wallet.source, jupiter.receiptMints);
      holdings = [...normalized.holdings, ...deposited];
      const registeredMints = new Set(Object.values(byId).map(instrument => instrument.mint));
      const otherMints = [...new Set(wallet.accounts.filter(account => BigInt(account.raw) > 0n && !registeredMints.has(account.mint) && !jupiter.receiptMints.has(account.mint)).map(account => account.mint))];
      const metadataMints = [...new Set([...otherMints, ...holdings.map(holding => holding.mintState.mint), ...(BigInt(wallet.nativeLamports) > 0n ? [byId.SOL.mint] : [])])];
      let metadata = new Map<string, JupiterTokenMetadata>();
      try { metadata = await readTokenMetadata(metadataMints, signal); }
      catch (error) { issues.push(`Jupiter Tokens API unavailable: ${safeError(error)}. Other wallet tokens remain identified by mint only.`); }
      const amountDescriptors = otherMints.flatMap(address => { const token = metadata.get(address); return token ? [{ mint: address, tokenProgram: token.tokenProgram, decimals: token.decimals }] : []; });
      const [amountResult, xstockResult] = await Promise.allSettled([
        readWalletAssetAmounts(connection, wallet.accounts, amountDescriptors),
        readXstockIdentities(otherMints.flatMap(address => { const token = metadata.get(address); return token ? [{ mint: address, symbol: token.symbol, verified: token.isVerified === true }] : []; }), signal),
      ]);
      const walletAmounts = amountResult.status === 'fulfilled' ? amountResult.value.amounts : new Map();
      if (amountResult.status === 'fulfilled' && amountResult.value.issues.length) issues.push(`${amountResult.value.issues.length} wallet token amount convention${amountResult.value.issues.length===1?' could':'s could'} not be verified onchain; those balances remain visible without a quantity.`);
      if (amountResult.status === 'rejected') issues.push(`Wallet token amount conventions unavailable: ${safeError(amountResult.reason)}. Those balances remain visible without a quantity.`);
      const xstocks = xstockResult.status === 'fulfilled' ? xstockResult.value : new Map();
      const priceRequests = [
        ...holdings.map(holding => ({ instrumentId: holding.instrumentId, mint: holding.mintState.mint, decimals: holding.mintState.decimals })),
        ...otherMints.flatMap(address => { const token = metadata.get(address); const suspicious = token?.audit?.isSus === true || token?.tags?.includes('banned') === true;
          return token?.isVerified === true && !suspicious ? [{ instrumentId: `mint:${address}`, mint: address, decimals: token.decimals }] : []; }),
        ...(BigInt(wallet.nativeLamports) > 0n ? [{ instrumentId: 'SOL', mint: byId.SOL.mint, decimals: byId.SOL.decimals }] : []),
      ];
      let byMint = new Map<string, PriceObservation>();
      try {
        const market = await readJupiterPrices(priceRequests, metadata, signal);
        prices = market.prices; byMint = market.byMint; issues.push(...market.issues);
      } catch (error) { issues.push(`Jupiter reference prices unavailable: ${safeError(error)}.`); }
      holdings.forEach(holding => { holding.referenceValue = referenceValue(holding, prices.find(price => price.instrumentId === holding.instrumentId)); });
      const other = normalizeOtherWalletAssets(wallet.accounts, owner, metadata, byMint, wallet.source, jupiter.receiptMints, walletAmounts, xstocks);
      walletAssets = other.assets; unsupported = other.unsupported;
      if (BigInt(wallet.nativeLamports) > 0n) {
        const amount = fromBaseUnits(wallet.nativeLamports, 9); const price = byMint.get(byId.SOL.mint);
        walletAssets.unshift({ id: 'wallet-native:SOL', owner, mint: byId.SOL.mint, symbol: 'SOL', name: 'Native Solana', tokenProgram: 'native', decimals: 9,
          accountCount: 1, rawAmount: wallet.nativeLamports, unscaledAmount: amount, amount, spendableAmount: amount, verification: 'verified', assetClass: 'crypto',
          companyId: null, sector: null, securityId: null, identitySource: 'https://solana.com/docs', amountConvention: 'base-decimals',
          underlyingSymbol: null, logoUrl: metadata.get(byId.SOL.mint)?.icon || null,
          referenceValue: price ? { amount: decimal(amount).mul(price.value).toFixed(), currency: 'USD', basis: 'reference', source: price.source } : null, source: wallet.source });
      }
      unsupported.push(...normalized.unsupported.filter(row => registeredMints.has(row.mint) || jupiter.receiptMints.has(row.mint)));
    }
    if (unsupported.length) issues.push('Unrecognized mint identities and protocol receipt tokens are listed separately; they are never hidden or included in asset totals.');
    if (holdings.some(holding => holding.instrumentId === 'QQQx')) issues.push('QQQ holdings are unavailable; QQQ remains undecomposed.');
    const observedAt = wallet?.source.observedAt || loans[0]?.source.observedAt || jupiter.earnPositions[0]?.source.observedAt;
    if (!observedAt) return { status: 'error', code: 'LIVE_READ_FAILED', message: issues.join(' ') || 'No live source returned an account observation.' };
    const data: Portfolio = { id: `live-${owner}-${observedAt}`, mode: 'live', owner, cluster: 'solana:mainnet', observedAt,
      holdings, loans, prices, etfs: holdingsSnapshots(), walletAssets, earnPositions: jupiter.earnPositions,
      unmodeledLoans, indexedPositions: jupiter.indexedPositions, unsupported,
      loanRead: selection && !loans.length && !unmodeledLoans.length ? 'blocked' : jupiter.status, issues,
      capabilities: Object.fromEntries(Object.keys(byId).map(id => [id, {
        positionReadable: loans.some(loan => loan.collateralInstrumentId === id), exposureAvailable: holdings.some(holding => holding.instrumentId === id && holding.referenceValue !== null),
        reason: 'Live read coverage only. Values remain subject to source identity and freshness checks.' }])) };
    const hasData = holdings.length || walletAssets.length || loans.length || unmodeledLoans.length || jupiter.earnPositions.length || jupiter.indexedPositions.length;
    const status = issues.length ? 'partial' : hasData ? 'ready' : 'empty';
    return PortfolioResultSchema.parse({ status, data });
  },
};
