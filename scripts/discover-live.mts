import { Connection, PublicKey } from '@solana/web3.js';
import { Client } from '@jup-ag/lend-read';
import { getVaultsProgram } from '@jup-ag/lend/borrow';
import { unpackMint, getScaledUiAmountConfig } from '@solana/spl-token';
import { writeFile } from 'node:fs/promises';

const connection = new Connection(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com', {
  commitment: 'confirmed', disableRetryOnRateLimit: true,
  fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(20000) }),
});
const evidence: Record<string, unknown> = { observedAt: new Date().toISOString(), method: 'Public mainnet RPC, official SDK. Read only.', sdk: { read: '0.0.14', write: '0.2.0' } };
async function main() {
  evidence.genesisHash = await connection.getGenesisHash();
  const symbols = ['NVDAx', 'TSLAx', 'SPYx', 'QQQx'];
  const assets = await Promise.all(symbols.map(async symbol => {
    const response = await fetch(`https://api.xstocks.fi/api/v2/public/assets/${symbol}`, { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw Error(`Issuer identity request failed: ${response.status}`);
    return response.json();
  }));
  const mints = assets.map(a => new PublicKey(a.deployments.find((d: { network: string }) => d.network === 'Solana').address));
  mints.push(new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'));
  const mintAccounts = await connection.getMultipleAccountsInfoAndContext(mints);
  evidence.mintSlot = mintAccounts.context.slot;
  evidence.mints = mintAccounts.value.map((a, i) => {
    if (!a) throw Error('Mint missing');
    const mint = unpackMint(mints[i], a, a.owner);
    return { symbol: [...symbols, 'USDC'][i], mint: mints[i].toBase58(), decimals: mint.decimals, program: a.owner.toBase58(), scaled: getScaledUiAmountConfig(mint) };
  });
  console.log(JSON.stringify({ mintSlot: evidence.mintSlot, mints: evidence.mints }, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2));
  const client = new Client(connection);
  evidence.totalVaults = await client.vault.getTotalVaults();
  console.log('Total vaults', evidence.totalVaults);
  const program = getVaultsProgram({ connection });
  const configs = await program.account.vaultConfig.all();
  evidence.configCount = configs.length;
  const supported = configs.filter(c => mints.slice(0, 4).some(m => m.equals(c.account.supplyToken)) && mints[4].equals(c.account.borrowToken));
  evidence.supportedVaults = supported.map(c => ({ address: c.publicKey.toBase58(), ...c.account }));
  console.log('Supported vaults', JSON.stringify(evidence.supportedVaults, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2));
}
main().catch(error => {
  const message = String(error.message).replace(/https?:\/\/\S+/g, '[RPC URL redacted]');
  evidence.error = message; console.error(message); process.exitCode = 1;
}).finally(async () => { await writeFile('docs/evidence/discovery.json', JSON.stringify(evidence, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n'); });
