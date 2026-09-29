import 'server-only';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { StockRichDataSchema, type StockRichData } from '@/domain/stock-rich-data';

/** Additive store; corrupt enrichment cannot invalidate the core price database.
 * The caller owns the existing market writer's lifetime volume lock. */
export class StockRichStore {
  private db: DatabaseSync;
  readonly rows = new Map<string, StockRichData>();
  version = 'empty';
  constructor(directory: string) {
    mkdirSync(resolve(directory), { recursive: true });
    this.db = new DatabaseSync(join(resolve(directory), 'enrichment.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS observations (seq INTEGER PRIMARY KEY AUTOINCREMENT, mint TEXT NOT NULL, payload TEXT NOT NULL); CREATE INDEX IF NOT EXISTS enrichment_mint ON observations(mint,seq)');
    for (const row of this.db.prepare('SELECT seq,mint,payload FROM observations ORDER BY seq DESC').all()) {
      if (this.rows.has(String(row.mint))) continue;
      try {
        const parsed = StockRichDataSchema.parse(JSON.parse(String(row.payload)));
        if (parsed.mint !== row.mint) continue;
        this.rows.set(parsed.mint, parsed);
        if (this.version === 'empty') this.version = `enrichment-${row.seq}`;
      } catch { /* try the preceding version of this mint */ }
    }
  }
  put(values: StockRichData[]) {
    const rows = values.map(value => StockRichDataSchema.parse(value));
    this.db.exec('BEGIN IMMEDIATE');
    let version = this.version;
    try {
      for (const row of rows) {
        const saved = this.db.prepare('INSERT INTO observations(mint,payload) VALUES (?,?)').run(row.mint, JSON.stringify(row));
        version = `enrichment-${saved.lastInsertRowid}`;
        this.db.prepare('DELETE FROM observations WHERE mint=? AND seq NOT IN (SELECT seq FROM observations WHERE mint=? ORDER BY seq DESC LIMIT 3)').run(row.mint,row.mint);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    for (const row of rows) this.rows.set(row.mint, row);
    this.version = version;
  }
  close() { this.db.close(); }
}
type Root = typeof globalThis & { __stockRichStore?: StockRichStore };
export function currentRichStore() { return (globalThis as Root).__stockRichStore; }
export function openRichStore(directory: string) {
  return (globalThis as Root).__stockRichStore ??= new StockRichStore(directory);
}
export function closeRichStore() {
  (globalThis as Root).__stockRichStore?.close(); delete (globalThis as Root).__stockRichStore;
}
