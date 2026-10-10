import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

// This development-only adapter applies the generated Drizzle SQL unchanged.
// It is imported by the preview server/tests, never by the hosted Worker.
export function createLocalDatabase(filename = ":memory:") {
  const database = new DatabaseSync(filename);
  try {
    const journal = JSON.parse(readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
    if (!Array.isArray(journal.entries)) throw new Error("Invalid migration journal.");
    database.exec("CREATE TABLE IF NOT EXISTS local_migrations (name TEXT PRIMARY KEY, hash TEXT NOT NULL)");
    for (const entry of journal.entries) {
      if (typeof entry.tag !== "string" || !/^\d{4}_[a-zA-Z0-9_]+$/.test(entry.tag)) throw new Error("Invalid migration name.");
      const sql = readFileSync(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8");
      const hash = createHash("sha256").update(sql).digest("hex");
      const applied = database.prepare("SELECT hash FROM local_migrations WHERE name = ?").get(entry.tag);
      if (applied) {
        if (applied.hash !== hash) throw new Error("An applied migration changed. Append a new generated migration instead.");
        continue;
      }
      database.exec("BEGIN");
      try {
        database.exec(sql);
        database.prepare("INSERT INTO local_migrations (name, hash) VALUES (?, ?)").run(entry.tag, hash);
        database.exec("COMMIT");
      } catch (error) { database.exec("ROLLBACK"); throw error; }
    }
  } catch (error) { database.close(); throw error; }

  return {
    prepare(sql) {
      const statement = database.prepare(sql);
      const prepared = (args) => ({
        bind: (...values) => prepared(values),
        async first(column) {
          const row = statement.get(...args) ?? null;
          return column === undefined ? row : row?.[column] ?? null;
        },
        async all() { return { success: true, results: statement.all(...args) }; },
        async run() {
          const result = statement.run(...args);
          return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
        },
      });
      return prepared([]);
    },
    close() { database.close(); },
  };
}
