import ExcelJS from 'exceljs';
import { createHash } from 'node:crypto';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { parseSpyRows, type SpyRow } from '@/adapters/holdings/parse-spy';

async function main() {
  const path = process.argv[2] || '.research/spy.xlsx';
  const bytes = await readFile(path);
  const checksum = createHash('sha256').update(bytes).digest('hex');
  const book = new ExcelJS.Workbook(); await book.xlsx.readFile(path);
  const sheet = book.getWorksheet('holdings');
  if (!sheet || sheet.getCell('B2').text !== 'SPY') throw Error('Wrong workbook');
  const date = /^As of (\d{2})-([A-Za-z]{3})-(\d{4})$/.exec(sheet.getCell('B3').text);
  if (!date) throw Error('Unknown holdings date format');
  const month = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].indexOf(date[2]) + 1;
  if (!month) throw Error('Invalid month');
  const holdingsDate = `${date[3]}-${String(month).padStart(2,'0')}-${date[1]}`;
  const expected = ['Name','Ticker','Identifier','SEDOL','Weight','Sector','Shares Held','Local Currency'];
  if (expected.some((name,i) => sheet.getRow(5).getCell(i+1).text !== name)) throw Error('Issuer column schema changed');
  const rows: SpyRow[] = [];
  sheet.eachRow((row, index) => {
    if (index <= 5) return;
    const weight = row.getCell(5).value;
    if (typeof weight !== 'number') return;
    rows.push({ name: row.getCell(1).text, ticker: row.getCell(2).text, identifier: row.getCell(3).text, weightPercent: String(weight) });
  });
  const snapshot = parseSpyRows(rows, holdingsDate, (await stat(path)).mtime.toISOString(), checksum);
  await writeFile('data/holdings/spy.json', JSON.stringify(snapshot, null, 2) + '\n');
  console.log(JSON.stringify({ holdingsDate, rows: rows.length, total: snapshot.reportedWeight, residual: snapshot.residualWeight, coverage: snapshot.coverageWeight, checksum }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
