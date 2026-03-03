const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());
app.get("/", (req, res) => {
  res.send("Wheely DZ API Running 🚴");
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/* ================= JWT ================= */

function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) return res.status(401).json({ error: "Token manquant" });

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Token invalide" });
    req.user = user;
    next();
  });
}

/* ================= INIT DB ================= */

app.get("/init-db", async (req, res) => {
  try {

    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        nom VARCHAR(100),
        email VARCHAR(100) UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        solde INTEGER DEFAULT 0,
        role VARCHAR(20) DEFAULT 'user',
        subscription_type VARCHAR(50),
        subscription_expires TIMESTAMP,
        subscription_minutes_left INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS reservations (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        montant INTEGER NOT NULL,
        code VARCHAR(6),
        used BOOLEAN DEFAULT false,
        started_at TIMESTAMP,
        ended_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await pool.query(`
  ALTER TABLE users
  ADD COLUMN IF NOT EXISTS subscription_type VARCHAR(50);
`);

await pool.query(`
  ALTER TABLE users
  ADD COLUMN IF NOT EXISTS subscription_expires TIMESTAMP;
`);

await pool.query(`
  ALTER TABLE users
  ADD COLUMN IF NOT EXISTS subscription_minutes_left INTEGER DEFAULT 0;
`);

    res.json({ message: "Database ready ✅" });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ================= REGISTER ================= */

app.post("/register", async (req, res) => {
  const { nom, email, password } = req.body;

  const exist = await pool.query("SELECT * FROM users WHERE email=$1", [email]);
  if (exist.rows.length > 0)
    return res.status(400).json({ error: "Email déjà utilisé" });

  const hash = await bcrypt.hash(password, 10);

  const user = await pool.query(
    `INSERT INTO users (nom,email,password_hash)
     VALUES ($1,$2,$3)
     RETURNING id,nom,email,solde`,
    [nom, email, hash]
  );

  res.json({ user: user.rows[0] });
});

/* ================= LOGIN ================= */

app.post("/login", async (req, res) => {

  const { email, password } = req.body;

  const user = await pool.query(
    "SELECT * FROM users WHERE email=$1",
    [email]
  );

  if (user.rows.length === 0)
    return res.status(400).json({ error: "Utilisateur introuvable" });

  const valid = await bcrypt.compare(
    password,
    user.rows[0].password_hash
  );

  if (!valid)
    return res.status(400).json({ error: "Mot de passe incorrect" });

  const token = jwt.sign(
    { id: user.rows[0].id },
    process.env.JWT_SECRET,
    { expiresIn: "24h" }
  );

  res.json({
    token,
    user: {
      id: user.rows[0].id,
      nom: user.rows[0].nom,
      email: user.rows[0].email,
      solde: user.rows[0].solde
    }
  });
});

/* ================= PROFILE ================= */

app.get("/profile", authenticateToken, async (req, res) => {

  const user = await pool.query(
    `SELECT nom,email,solde,
            subscription_type,
            subscription_minutes_left,
            subscription_expires
     FROM users WHERE id=$1`,
    [req.user.id]
  );

  res.json(user.rows[0]);
});

/* ================= BUY SUBSCRIPTION ================= */

app.post("/buy-subscription", authenticateToken, async (req, res) => {

  const { type } = req.body;

  let price = 0;
  let minutes = 0;

  if (type === "student") {
    price = 1200;
    minutes = 120;
  }

  if (type === "premium") {
    price = 2500;
    minutes = 240;
  }

  const user = await pool.query(
    "SELECT solde FROM users WHERE id=$1",
    [req.user.id]
  );

  if (user.rows[0].solde < price)
    return res.status(400).json({ error: "Solde insuffisant" });

  await pool.query(
    `UPDATE users
     SET solde = solde - $1,
         subscription_type=$2,
         subscription_expires = NOW() + INTERVAL '30 days',
         subscription_minutes_left=$3
     WHERE id=$4`,
    [price, type, minutes, req.user.id]
  );

  res.json({ message: "Abonnement activé ✅" });
});

/* ================= RESERVE ================= */

app.post("/reserve", authenticateToken, async (req, res) => {

  const active = await pool.query(
    `SELECT * FROM reservations
     WHERE user_id=$1 AND ended_at IS NULL AND started_at IS NOT NULL`,
    [req.user.id]
  );

  if (active.rows.length > 0)
    return res.status(400).json({ error: "Course déjà active" });

  const code = Math.floor(100000 + Math.random() * 900000).toString();

  await pool.query(
    `INSERT INTO reservations (user_id,montant,code)
     VALUES ($1,$2,$3)`,
    [req.user.id, 0, code]
  );

  res.json({ code });
});

/* ================= UNLOCK ================= */

app.post("/unlock", authenticateToken, async (req, res) => {

  const { code } = req.body;

  const reservation = await pool.query(
    `SELECT * FROM reservations
     WHERE user_id=$1 AND code=$2 AND used=false`,
    [req.user.id, code]
  );

  if (reservation.rows.length === 0)
    return res.status(400).json({ error: "Code invalide" });

  await pool.query(
    `UPDATE reservations
     SET used=true, started_at=NOW()
     WHERE id=$1`,
    [reservation.rows[0].id]
  );

  res.json({ message: "Vélo déverrouillé 🚴" });
});

/* ================= END RIDE ================= */

app.post("/end-ride", authenticateToken, async (req, res) => {

  const ride = await pool.query(
    `SELECT * FROM reservations
     WHERE user_id=$1
     AND started_at IS NOT NULL
     AND ended_at IS NULL
     ORDER BY started_at DESC
     LIMIT 1`,
    [req.user.id]
  );

  if (ride.rows.length === 0)
    return res.status(400).json({ error: "Aucune course active" });

  const start = ride.rows[0].started_at;
  const duration = Math.max(
    1,
    Math.floor((new Date() - start) / 60000)
  );

  const user = await pool.query(
    `SELECT solde,
            subscription_type,
            subscription_minutes_left,
            subscription_expires
     FROM users WHERE id=$1`,
    [req.user.id]
  );

  let solde = user.rows[0].solde;
  let minutesLeft = user.rows[0].subscription_minutes_left;

  if (
    user.rows[0].subscription_type &&
    new Date(user.rows[0].subscription_expires) > new Date()
  ) {

    if (minutesLeft >= duration) {

      minutesLeft -= duration;

      await pool.query(
        `UPDATE users
         SET subscription_minutes_left=$1
         WHERE id=$2`,
        [minutesLeft, req.user.id]
      );

    } else {

      const extra = duration - minutesLeft;
      const cost = extra * 5;

      if (solde < cost)
        return res.status(400).json({ error: "Solde insuffisant" });

      await pool.query(
        `UPDATE users
         SET solde = solde - $1,
             subscription_minutes_left=0
         WHERE id=$2`,
        [cost, req.user.id]
      );
    }

  } else {

    const cost = duration * 5;

    if (solde < cost)
      return res.status(400).json({ error: "Solde insuffisant" });

    await pool.query(
      `UPDATE users
       SET solde = solde - $1
       WHERE id=$2`,
      [cost, req.user.id]
    );
  }

  await pool.query(
    `UPDATE reservations
     SET ended_at=NOW()
     WHERE id=$1`,
    [ride.rows[0].id]
  );

  res.json({
    message: "Course terminée",
    duration
  });
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
