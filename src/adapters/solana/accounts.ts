import { Connection, PublicKey } from '@solana/web3.js';
import { unpackAccount, unpackMint, getScaledUiAmountConfig, getInterestBearingMintConfigState, getExtensionTypes, ExtensionType,
  amountToUiAmountForInterestBearingMintWithoutSimulation } from '@solana/spl-token';
import { TOKEN_PROGRAM, TOKEN_2022_PROGRAM, byId, identify, instruments } from '@/config/instruments';
import { decimal, fromBaseUnits, scaledDisplay, effectiveMultiplier, sum } from '@/domain/amounts';
import type { Holding, MintState, Source } from '@/domain/types';

export type TokenAccount = { address: string; mint: string; owner: string; tokenProgram: string; raw: string; frozen: boolean };
export type WalletAmountState = { unscaledAmount: string; amount: string; spendableAmount: string; convention: 'base-decimals' | 'scaled-ui' | 'interest-bearing' };
export function normalizeAccounts(accounts: TokenAccount[], owner: string, states: MintState[], source: Source, receiptMints = new Set<string>()) {
  const holdings: Holding[] = [];
  const unsupported: { mint: string; accountCount: number; reason: string }[] = [];
  const groups = new Map<string, TokenAccount[]>();
  const seen = new Set<string>();
  for (const account of accounts) {
    if (account.owner !== owner) throw Error('Token account owner mismatch');
    if (seen.has(account.address)) throw Error('Duplicate token account');
    seen.add(account.address);
    if (BigInt(account.raw) === 0n) continue;
    const group = groups.get(account.mint) || []; group.push(account); groups.set(account.mint, group);
  }
  for (const [mint, group] of groups) {
    if (receiptMints.has(mint)) { unsupported.push({ mint, accountCount: group.length, reason: 'Position receipt excluded from asset value; collateral is counted at the loan.' }); continue; }
    const state = states.find(s => s.mint === mint);
    const instrument = state && identify('solana:mainnet', mint, state.tokenProgram, state.decimals);
    if (!state || !instrument || group.some(a => a.tokenProgram !== instrument.tokenProgram)) {
      unsupported.push({ mint, accountCount: group.length, reason: 'Unsupported mint or unverified mint state; excluded from totals.' }); continue;
    }
    const rawAmount = group.reduce((a,c) => a + BigInt(c.raw), 0n).toString();
    const spendableRaw = group.filter(a => !a.frozen).reduce((a,c) => a + BigInt(c.raw), 0n).toString();
    holdings.push({ id: `wallet:${mint}`, owner, instrumentId: instrument.id, scope: 'wallet',
      accountIds: group.map(a => a.address), positionId: null, rawAmount, rawUnit: 'token-base-unit', decimals: state.decimals,
      unscaledAmount: fromBaseUnits(rawAmount, state.decimals), displayAmount: scaledDisplay(rawAmount, state.decimals, state.multiplier),
      spendable: BigInt(spendableRaw) > 0n, spendableRawAmount: spendableRaw,
      spendableAmount: scaledDisplay(spendableRaw, state.decimals, state.multiplier),
      mintState: state, source, referenceValue: null });
  }
  return { holdings, unsupported };
}

export async function readMintStates(connection: Connection, ids = instruments.map(i => i.id)) {
  const selected = ids.map(id => byId[id]);
  const result = await connection.getMultipleAccountsInfoAndContext(selected.map(i => new PublicKey(i.mint)));
  const chainTime = await connection.getBlockTime(result.context.slot);
  if (chainTime === null) throw Error('Chain time unavailable; multiplier state cannot be verified');
  const observedAt = new Date(chainTime * 1000).toISOString();
  const source: Source = { id: `mint-slot-${result.context.slot}`, label: 'Solana mint accounts', url: 'https://explorer.solana.com', observedAt,
    retrievedAt: new Date().toISOString(), slot: result.context.slot, endSlot: result.context.slot, kind: 'live', validity: 'valid' };
  const states: MintState[] = [];
  const issues: string[] = [];
  result.value.forEach((account, i) => {
    const instrument = selected[i];
    try {
      if (!account) throw Error('Mint is missing');
      if (account.owner.toBase58() !== instrument.tokenProgram) throw Error('Mint program mismatch');
      const mint = unpackMint(new PublicKey(instrument.mint), account, new PublicKey(instrument.tokenProgram));
      if (mint.decimals !== instrument.decimals || !mint.isInitialized) throw Error('Mint decimals/initialization mismatch');
      const scaled = getScaledUiAmountConfig(mint);
      if (instrument.amountConvention === 'scaled-ui' && !scaled) throw Error('Scaled UI extension missing');
      const extensions = getExtensionTypes(mint.tlvData);
      if (extensions.includes(ExtensionType.InterestBearingConfig) || extensions.includes(ExtensionType.NonTransferable)) throw Error('Unsupported amount/transfer convention');
      const effectiveAt = scaled ? Number(scaled.newMultiplierEffectiveTimestamp) : null;
      if (effectiveAt !== null && !Number.isSafeInteger(effectiveAt)) throw Error('Unsafe multiplier timestamp');
      const multiplier = scaled ? effectiveMultiplier(String(scaled.multiplier), String(scaled.newMultiplier), effectiveAt, chainTime) : '1';
      states.push({ mint: instrument.mint, decimals: mint.decimals, tokenProgram: instrument.tokenProgram, multiplier,
        pendingMultiplier: scaled && effectiveAt !== null && effectiveAt > chainTime ? String(scaled.newMultiplier) : null,
        effectiveAt, chainTime, source });
    } catch (error) { issues.push(`${instrument.symbol}: ${error instanceof Error ? error.message : 'Mint validation failed'}`); }
  });
  return { states, issues };
}
export async function readWalletAccounts(connection: Connection, owner: PublicKey) {
  const readProgram = async (program: string) => ({
    ...await connection.getTokenAccountsByOwner(owner, { programId: new PublicKey(program) }),
    program,
  });
  const [legacy, token2022, native] = await Promise.all([
    readProgram(TOKEN_PROGRAM), readProgram(TOKEN_2022_PROGRAM), connection.getBalanceAndContext(owner),
  ]);
  const results = [legacy, token2022];
  const accounts = results.flatMap(result => result.value.map(a => {
    const decoded = unpackAccount(a.pubkey, a.account, new PublicKey(result.program));
    if (!decoded.isInitialized) throw Error('Uninitialized token account');
    return { address: a.pubkey.toBase58(), mint: decoded.mint.toBase58(), owner: decoded.owner.toBase58(),
      tokenProgram: result.program, raw: decoded.amount.toString(), frozen: decoded.isFrozen };
  }));
  const slot = Math.min(native.context.slot, ...results.map(r => r.context.slot));
  const endSlot = Math.max(native.context.slot, ...results.map(r => r.context.slot));
  const chainTime = await connection.getBlockTime(slot);
  if (chainTime === null) throw Error('Token account observation time unavailable');
  const source: Source = { id: `wallet-${slot}-${endSlot}`, label: 'Solana token accounts', url: 'https://explorer.solana.com/address/' + owner.toBase58(),
    observedAt: new Date(chainTime * 1000).toISOString(), retrievedAt: new Date().toISOString(), slot, endSlot, kind: 'live', validity: 'valid' };
  return { accounts, nativeLamports: String(native.value), source };
}
export async function readWalletAssetAmounts(connection: Connection, accounts: TokenAccount[], descriptors: { mint: string; tokenProgram: string; decimals: number }[]) {
  const selected = [...new Map(descriptors.map(row => [row.mint, row])).values()];
  if (!selected.length) return { amounts: new Map<string, WalletAmountState>(), issues: [] as string[] };
  const result = await connection.getMultipleAccountsInfoAndContext(selected.map(row => new PublicKey(row.mint)));
  const chainTime = await connection.getBlockTime(result.context.slot);
  if (chainTime === null) throw Error('Chain time unavailable for Token-2022 display amounts');
  const groups = new Map<string, TokenAccount[]>();
  for (const account of accounts) {
    const group = groups.get(account.mint) || []; group.push(account); groups.set(account.mint, group);
  }
  const amounts = new Map<string, WalletAmountState>();
  const issues: string[] = [];
  selected.forEach((descriptor, index) => {
    try {
      const account = result.value[index];
      if (!account) throw Error('mint account is missing');
      if (account.owner.toBase58() !== descriptor.tokenProgram) throw Error('mint program differs from Jupiter identity');
      const mint = unpackMint(new PublicKey(descriptor.mint), account, account.owner);
      if (!mint.isInitialized || mint.decimals !== descriptor.decimals) throw Error('mint decimals or initialization differs from Jupiter identity');
      const group = groups.get(descriptor.mint) || [];
      const raw = group.reduce((sum, row) => sum + BigInt(row.raw), 0n);
      const spendableRaw = group.filter(row => !row.frozen).reduce((sum, row) => sum + BigInt(row.raw), 0n);
      const scaled = getScaledUiAmountConfig(mint);
      const interest = getInterestBearingMintConfigState(mint);
      let amount: string; let spendableAmount: string; let convention: WalletAmountState['convention'];
      if (scaled) {
        const effectiveAt = Number(scaled.newMultiplierEffectiveTimestamp);
        if (!Number.isSafeInteger(effectiveAt)) throw Error('scaled UI timestamp is unsafe');
        const multiplier = effectiveMultiplier(String(scaled.multiplier), String(scaled.newMultiplier), effectiveAt, chainTime);
        amount = scaledDisplay(raw.toString(), mint.decimals, multiplier);
        spendableAmount = scaledDisplay(spendableRaw.toString(), mint.decimals, multiplier);
        convention = 'scaled-ui';
      } else if (interest) {
        if (raw > BigInt(Number.MAX_SAFE_INTEGER) || spendableRaw > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('interest-bearing amount exceeds the installed SDK precision boundary');
        const convert = (value: bigint) => amountToUiAmountForInterestBearingMintWithoutSimulation(value, mint.decimals, chainTime,
          Number(interest.lastUpdateTimestamp), Number(interest.initializationTimestamp), interest.preUpdateAverageRate, interest.currentRate);
        amount = decimal(convert(raw)).toFixed(); spendableAmount = decimal(convert(spendableRaw)).toFixed(); convention = 'interest-bearing';
      } else {
        amount = fromBaseUnits(raw.toString(), mint.decimals); spendableAmount = fromBaseUnits(spendableRaw.toString(), mint.decimals); convention = 'base-decimals';
      }
      amounts.set(descriptor.mint, { unscaledAmount: fromBaseUnits(raw.toString(), mint.decimals), amount, spendableAmount, convention });
    } catch (error) {
      issues.push(`${descriptor.mint}: ${error instanceof Error ? error.message : 'amount convention could not be resolved'}`);
    }
  });
  return { amounts, issues };
}
export function freeCash(holdings: Holding[]): string {
  return sum(holdings.filter(h => h.scope === 'wallet' && h.instrumentId === 'USDC').map(h => h.spendableAmount));
}
