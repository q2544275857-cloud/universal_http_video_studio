import { db, normalizeCardPositions } from '../server/db.js';
import { nowIso } from '../server/utils.js';

const rows = db.prepare(`
  SELECT DISTINCT t.prompt_card_id AS card_id
  FROM generation_tasks t
  JOIN prompt_cards c ON c.id=t.prompt_card_id
  WHERE t.status='submit_failed'
    AND t.remote_task_id IS NULL
    AND c.active=0
  ORDER BY t.created_at
`).all();

let nextPosition = Number(db.prepare('SELECT COALESCE(MAX(position),0)+1 AS next FROM prompt_cards WHERE active=1').get().next);
const update = db.prepare('UPDATE prompt_cards SET active=1,position=?,updated_at=? WHERE id=?');
for (const row of rows) {
  update.run(nextPosition, nowIso(), row.card_id);
  nextPosition += 1;
}
normalizeCardPositions();

console.log(JSON.stringify({
  ok: true,
  restoredCount: rows.length,
  restoredCardIds: rows.map(row => row.card_id)
}, null, 2));
