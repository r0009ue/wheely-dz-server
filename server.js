const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

/* ================= DATABASE ================= */

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/* ================= ROOT ================= */

app.get("/", (req, res) => {
  res.send("Wheely DZ API Running 🚴");
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
        montant INTEGER DEFAULT 0,
        code VARCHAR(6),
        used BOOLEAN DEFAULT false,
        started_at TIMESTAMP,
        ended_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    res.json({ message: "Database ready ✅" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ================= REGISTER ================= */

app.post("/register", async (req, res) => {
  try {
    const { nom, email, password } = req.body;

    const exist = await pool.query(
      "SELECT * FROM users WHERE email=$1",
      [email]
    );

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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ================= LOGIN ================= */

app.post("/login", async (req, res) => {
  try {
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ================= PROFILE ================= */

app.get("/profile", authenticateToken, async (req, res) => {
  try {
    const user = await pool.query(
      "SELECT nom,email,solde FROM users WHERE id=$1",
      [req.user.id]
    );
    res.json(user.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ================= DEPOSIT ================= */

app.post("/deposit", authenticateToken, async (req, res) => {
  try {
    const { amount } = req.body;

    await pool.query(
      "UPDATE users SET solde = solde + $1 WHERE id = $2",
      [amount, req.user.id]
    );

    res.json({ message: "Solde mis à jour" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ================= RESERVE ================= */

app.post("/reserve", authenticateToken, async (req, res) => {
  try {
    const code = Math.floor(100000 + Math.random() * 900000).toString();

    // Ajouter un montant par défaut (exemple: 70 DA)
    const montant = 70;  // Ou définis-le en fonction de la durée ou du plan de location

    await pool.query(
      `INSERT INTO reservations (user_id, montant, code)
       VALUES ($1, $2, $3)`,
      [req.user.id, montant, code]
    );

    res.json({ code });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ================= UNLOCK ================= */

app.post("/unlock", authenticateToken, async (req, res) => {
  try {
    const { code } = req.body;

    await pool.query(
      `UPDATE reservations
       SET used=true, started_at=NOW()
       WHERE user_id=$1 AND code=$2`,
      [req.user.id, code]
    );

    res.json({ message: "Vélo déverrouillé 🚴" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ================= END RIDE ================= */

app.post("/end-ride", authenticateToken, async (req, res) => {
  try {
    const ride = await pool.query(
      `SELECT * FROM reservations
       WHERE user_id=$1 AND ended_at IS NULL
       ORDER BY started_at DESC LIMIT 1`,
      [req.user.id]
    );

    if (ride.rows.length === 0)
      return res.status(400).json({ error: "Aucune course active" });

    const start = ride.rows[0].started_at;
    const duration = Math.max(
      1,
      Math.floor((new Date() - start) / 60000)
    );

    await pool.query(
      `UPDATE reservations SET ended_at=NOW()
       WHERE id=$1`,
      [ride.rows[0].id]
    );

    await pool.query(
      `UPDATE users SET solde = solde - $1
       WHERE id=$2`,
      [duration * 5, req.user.id]
    );

    res.json({ duration });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ================= START ================= */

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
