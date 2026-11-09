/**
 * Module ids are "<level>.<n>". When modules were inserted into Levels 4, 6, 7, 8 and 10, later modules moved down the
 * list. This maps an id from the earlier numbering to today's, so saved progress, notes and exports keep pointing at the
 * same lesson. Ids in every other level did not change.
 */
export function migrateModuleId(id: string): string {
  const m = id.match(/^(\d+)\.(\d+)$/);
  if (!m) return id;
  const level = Number(m[1]);
  const n = Number(m[2]);
  switch (level) {
    case 4: // chunking onward moved down one place (4.2 became "scheduled ingestion")
      return n >= 2 ? `4.${n + 1}` : id;
    case 6: // long-context strategies onward moved after the ten new memory modules
      return n >= 5 ? `6.${n + 10}` : id;
    case 7: // eval suites, evaluating RAG and evaluating agents moved down
      return n === 7 ? "7.9" : n === 8 ? "7.10" : n === 9 ? "7.12" : id;
    case 8: // securing agents onward moved after the two guardrail-framework modules
      return n >= 4 ? `8.${n + 2}` : id;
    case 10: // monitoring onward moved after the three Kubernetes / load-testing / autoscaling modules
      return n >= 9 ? `10.${n + 3}` : id;
    default:
      return id;
  }
}

/** Progress keys look like "4.3", "4.3:read" or "4.3:2". Rewrites the module part and leaves anything else alone. */
export function migrateKey(key: string): string {
  const m = key.match(/^(\d+\.\d+)(:.*)?$/);
  return m ? migrateModuleId(m[1]) + (m[2] ?? "") : key;
}

/** Applies migrateKey to every key of a record. */
export function migrateRecord<T>(rec: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(rec)) out[migrateKey(k)] = v;
  return out;
}
