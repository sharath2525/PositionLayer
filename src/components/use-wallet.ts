'use client';
import { useEffect, useRef, useState } from 'react';
import { getWallets } from '@wallet-standard/app';
import type { Wallet, WalletAccount } from '@wallet-standard/base';
import { StandardConnect, StandardDisconnect, StandardEvents, type StandardConnectFeature, type StandardDisconnectFeature, type StandardEventsFeature } from '@wallet-standard/features';

const SESSION_KEY = 'positionlayer:wallet:v1';
type SavedWallet = { name: string; address: string };
function readSaved(): SavedWallet | null {
  try {
    const value = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null') as Partial<SavedWallet> | null;
    return value && typeof value.name === 'string' && typeof value.address === 'string' ? { name: value.name, address: value.address } : null;
  } catch { return null; }
}
function save(selected: Wallet, account: WalletAccount) {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ name: selected.name, address: account.address } satisfies SavedWallet));
}

export function useWallet() {
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [account, setAccount] = useState<WalletAccount | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [rememberedAddress, setRememberedAddress] = useState<string | null>(null);
  const generation = useRef(0);
  const walletRef = useRef<Wallet | null>(null);
  const restoreInFlight = useRef(false);
  useEffect(() => { walletRef.current = wallet; }, [wallet]);
  useEffect(() => {
    const registry = getWallets();
    const restore = async (available: Wallet[]) => {
      const remembered = readSaved();
      setRememberedAddress(remembered?.address || null);
      if (!remembered) { setRestoring(false); return; }
      const selected = available.find(candidate => candidate.name === remembered.name);
      if (!selected || restoreInFlight.current || walletRef.current) return;
      restoreInFlight.current = true;
      const request = ++generation.current;
      try {
        const existing = selected.accounts.find(candidate => candidate.chains.includes('solana:mainnet') && candidate.address === remembered.address);
        const feature = selected.features[StandardConnect] as StandardConnectFeature[typeof StandardConnect];
        const result = existing ? { accounts: [existing] } : await feature.connect({ silent: true });
        if (request !== generation.current) return;
        const next = result.accounts.find(candidate => candidate.chains.includes('solana:mainnet') && candidate.address === remembered.address);
        if (!next) throw Error('Saved account was not returned');
        setWallet(selected); setAccount(next); setError(null); save(selected, next);
      } catch {
        if (request === generation.current) setError('Saved wallet access could not be restored. Live data remains available by public address.');
      } finally {
        restoreInFlight.current = false;
        if (request === generation.current) setRestoring(false);
      }
    };
    const update = () => {
      const available = registry.get().filter(candidate => candidate.chains.includes('solana:mainnet') && StandardConnect in candidate.features && StandardEvents in candidate.features);
      setWallets(available); void restore(available);
    };
    void Promise.resolve().then(update);
    const offRegister = registry.on('register', update);
    const offUnregister = registry.on('unregister', (...removed) => {
      update();
      if (walletRef.current && removed.includes(walletRef.current)) { generation.current++; setWallet(null); setAccount(null); }
    });
    return () => { offRegister(); offUnregister(); };
  }, []);
  useEffect(() => {
    if (!wallet) return;
    const events = wallet.features[StandardEvents] as StandardEventsFeature[typeof StandardEvents];
    return events.on('change', ({ accounts, chains }) => {
      generation.current++;
      if (chains && !chains.includes('solana:mainnet')) { setAccount(null); setError('Wallet no longer supports Solana mainnet.'); return; }
      if (accounts) {
        const next = accounts.find(candidate => candidate.chains.includes('solana:mainnet')) || null;
        setAccount(next);
        if (next) { save(wallet, next); setRememberedAddress(next.address); setError(null); }
        else setError('Wallet disconnected or no mainnet account is available. Live data remains available by public address.');
      }
    });
  }, [wallet]);
  async function connect(selected: Wallet) {
    const request = ++generation.current;
    setConnecting(true); setError(null); setAccount(null); setWallet(null);
    try {
      const feature = selected.features[StandardConnect] as StandardConnectFeature[typeof StandardConnect];
      const result = await feature.connect();
      if (request !== generation.current) return;
      const next = result.accounts.find(candidate => candidate.chains.includes('solana:mainnet'));
      if (!next) throw Error('This wallet did not authorize a Solana mainnet account.');
      setWallet(selected); setAccount(next); setRememberedAddress(next.address); save(selected, next);
    } catch { if (request === generation.current) setError('Connection was cancelled or unavailable. Try again in your wallet.'); }
    finally { if (request === generation.current) { setConnecting(false); setRestoring(false); } }
  }
  async function disconnect() {
    generation.current++; setAccount(null); setWallet(null); setError(null); setConnecting(false); setRememberedAddress(null); setRestoring(false);
    localStorage.removeItem(SESSION_KEY);
    const disconnectFeature = wallet?.features[StandardDisconnect] as StandardDisconnectFeature[typeof StandardDisconnect] | undefined;
    try { await disconnectFeature?.disconnect(); } catch { setError('Local connection cleared. Wallet disconnect request was unavailable.'); }
  }
  return { wallets, wallet, account, error, connecting, restoring, rememberedAddress, connect, disconnect };
}
