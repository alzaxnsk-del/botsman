// Reference service for the deploy vertical (§8 step 1): Express + Postgres,
// honours the Botsman deploy contract (PORT env, GET / => 200, env-only config).
import express from 'express';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const app = express();
app.use(express.urlencoded({ extended: false }));

await pool.query(`CREATE TABLE IF NOT EXISTS todos (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  done BOOLEAN NOT NULL DEFAULT FALSE
)`);

app.get('/', async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM todos ORDER BY id');
  res.send(`<!doctype html><html><head><meta charset="utf-8"><title>TODO</title></head><body>
  <h1>TODO</h1>
  <form method="post" action="/add"><input name="title" required><button>Add</button></form>
  <ul>${rows.map((t) => `<li>${t.done ? '✅' : '⬜️'} ${escapeHtml(t.title)}
    <form style="display:inline" method="post" action="/toggle/${t.id}"><button>toggle</button></form></li>`).join('')}
  </ul></body></html>`);
});

app.post('/add', async (req, res) => {
  await pool.query('INSERT INTO todos (title) VALUES ($1)', [req.body.title ?? '']);
  res.redirect('/');
});

app.post('/toggle/:id', async (req, res) => {
  await pool.query('UPDATE todos SET done = NOT done WHERE id = $1', [req.params.id]);
  res.redirect('/');
});

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`example-todo listening on ${port}`));
