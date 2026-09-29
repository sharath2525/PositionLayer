import 'server-only';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { PublishedMarketSnapshotSchema, type PublishedMarketSnapshot } from '@/domain/market-snapshot';
import { MemoryMarketSnapshotStore, getProcessMarketSnapshotStore, type MarketSnapshotStore } from './market-snapshot-store';
import { openRichStore, closeRichStore } from './stock-rich-store';

/** One persistent host/volume. The separate lifetime SQLite lock prevents an
 * overlapping process from making provider calls, including during catalog
 * refresh. The OS releases it on crash; never delete a live lock to take over.
 * Independent disks/replicas require a distributed coordinator instead. */
export class DurableMarketSnapshotStore extends MemoryMarketSnapshotStore {
  private readonly database: DatabaseSync;
  private readonly writerLock: DatabaseSync;
  private closed = false;

  constructor(directory: string) {
    const path = resolve(directory);
    mkdirSync(path, { recursive: true });
    const lock = new DatabaseSync(join(path, 'writer-lock.sqlite'));
    try { lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE'); }
    catch { lock.close(); throw new Error('Another market writer owns this persistent volume.'); }
    let database: DatabaseSync | null = null;
    let snapshots: PublishedMarketSnapshot[];
    try {
      database = new DatabaseSync(join(path, 'snapshots.sqlite'));
      database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS snapshots (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, payload TEXT NOT NULL)');
      snapshots = database.prepare('SELECT payload FROM snapshots ORDER BY sequence DESC LIMIT 3').all().flatMap(row => {
        try { return [PublishedMarketSnapshotSchema.parse(JSON.parse(String(row.payload)))]; }
        catch { return []; } // Corrupt newest payload falls back to a separately validated previous bundle.
      });
    } catch (error) { database?.close(); lock.close(); throw error; }
    super(3, snapshots);
    this.database = database;
    this.writerLock = lock;
  }

  protected override beforePublish(snapshot: PublishedMarketSnapshot) {
    if (this.closed) throw new Error('Market store is closed.');
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare('INSERT INTO snapshots (id,payload) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload')
        .run(snapshot.id, JSON.stringify(snapshot));
      this.database.exec('DELETE FROM snapshots WHERE sequence NOT IN (SELECT sequence FROM snapshots ORDER BY sequence DESC LIMIT 3); COMMIT');
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
    this.writerLock.close();
  }
}

type Runtime = typeof globalThis & { __positionLayerDurableMarket?: DurableMarketSnapshotStore };
export function marketWriterAllowed() {
  return process.env.VERCEL !== '1' && process.env.MARKET_V2_WRITER_ENABLED === 'true'
    && !process.env.MARKET_V2_WRITER_ORIGIN;
}
export function marketSnapshotsManaged() {
  return process.env.VERCEL === '1' || process.env.MARKET_V2_WRITER_ENABLED === 'true'
    || Boolean(process.env.MARKET_V2_WRITER_ORIGIN);
}
export function getRuntimeMarketSnapshotStore(): MarketSnapshotStore {
  const global = globalThis as Runtime;
  if (!marketWriterAllowed()) return getProcessMarketSnapshotStore();
  if (!global.__positionLayerDurableMarket) {
    if (process.env.NODE_ENV === 'production' && !process.env.MARKET_SNAPSHOT_DIR) {
      throw new Error('Persistent market writer requires MARKET_SNAPSHOT_DIR on a mounted durable volume.');
    }
    global.__positionLayerDurableMarket = new DurableMarketSnapshotStore(process.env.MARKET_SNAPSHOT_DIR ?? '.market-data');
    try { openRichStore(process.env.MARKET_SNAPSHOT_DIR ?? '.market-data'); } catch { /* optional enrichment cannot block core prices */ }
  }
  return global.__positionLayerDurableMarket;
}
export function closeRuntimeMarketSnapshotStore() {
  closeRichStore();
  const global = globalThis as Runtime;
  global.__positionLayerDurableMarket?.close();
  delete global.__positionLayerDurableMarket;
}
