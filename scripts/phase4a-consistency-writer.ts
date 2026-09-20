// Phase 4A — كاتب الكتابة المتزامنة: عملية bun منفصلة (تزامن حقيقي على مستوى OS).
// الاستخدام: bun phase4a-consistency-writer.ts <clonePath> <batches> <batch>
// يطبع "DONE <n>" عند الانتهاء.

import { Database } from "bun:sqlite";

const clonePath = process.argv[2]!;
const batches = parseInt(process.argv[3] ?? "20000", 10);
const batch = parseInt(process.argv[4] ?? "5", 10);

const w = new Database(clonePath);
w.exec("PRAGMA journal_mode=WAL");
w.exec("PRAGMA busy_timeout=15000");
const upd = w.prepare(`UPDATE __c4a_counter SET v = v + ${batch} WHERE id = 1`);
const ins = w.prepare(`INSERT INTO __c4a_rows (batch) VALUES (?)`);

let done = 0;
for (let b = 0; b < batches; b++) {
  w.exec("BEGIN IMMEDIATE");
  upd.run();
  for (let i = 0; i < batch; i++) ins.run(b);
  w.exec("COMMIT");
  done++;
}
w.close();
console.log(`DONE ${done}`);
