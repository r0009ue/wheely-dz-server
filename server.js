const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ================= JWT =================
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

// ================= INIT DB =================
app.get("/init-db", async (req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        nom VARCHAR(100),
        email VARCHAR(100) UNIQUE NOT NULL,
        telephone VARCHAR(20),
        password_hash TEXT NOT NULL,
        solde INTEGER DEFAULT 0,
        role VARCHAR(20) DEFAULT 'user',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS reservations (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        montant INTEGER NOT NULL,
        code VARCHAR(6),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    res.json({ message: "Tables créées ✅" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ================= REGISTER =================
app.post("/register", async (req, res) => {
  try {
    const { nom, email, password } = req.body;

    const userExist = await pool.query(
      "SELECT * FROM users WHERE email = $1",
      [email]
    );

    if (userExist.rows.length > 0) {
      return res.status(400).json({ error: "Email déjà utilisé" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const newUser = await pool.query(
      "INSERT INTO users (nom, email, password_hash) VALUES ($1, $2, $3) RETURNING id, nom, email, solde, role",
      [nom, email, hashedPassword]
    );

    res.status(201).json({ user: newUser.rows[0] });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ================= LOGIN =================
app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await pool.query(
      "SELECT * FROM users WHERE email = $1",
      [email]
    );

    if (user.rows.length === 0)
      return res.status(400).json({ error: "Utilisateur introuvable" });

    const validPassword = await bcrypt.compare(
      password,
      user.rows[0].password_hash
    );

    if (!validPassword)
      return res.status(400).json({ error: "Mot de passe incorrect" });

    const token = jwt.sign(
      { id: user.rows[0].id, role: user.rows[0].role },
      process.env.JWT_SECRET,
      { expiresIn: "24h" }
    );

    res.json({
      token,
      user: {
        id: user.rows[0].id,
        nom: user.rows[0].nom,
        email: user.rows[0].email,
        solde: user.rows[0].solde,
        role: user.rows[0].role,
      },
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ================= PROFILE =================
app.get("/profile", authenticateToken, async (req, res) => {
  const user = await pool.query(
    "SELECT id, nom, email, solde FROM users WHERE id = $1",
    [req.user.id]
  );

  res.json(user.rows[0]);
});

// ================= DEPOSIT =================
app.post("/deposit", authenticateToken, async (req, res) => {
  const { amount } = req.body;

  if (!amount || amount <= 0)
    return res.status(400).json({ error: "Montant invalide" });

  await pool.query(
    "UPDATE users SET solde = solde + $1 WHERE id = $2",
    [amount, req.user.id]
  );

  res.json({ message: "Solde mis à jour ✅" });
});

// ================= RESERVE =================
app.post("/reserve", authenticateToken, async (req, res) => {
  const client = await pool.connect();

  try {
    const { montant } = req.body;

    if (!montant || montant <= 0)
      return res.status(400).json({ error: "Montant invalide" });

    const user = await client.query(
      "SELECT solde FROM users WHERE id = $1",
      [req.user.id]
    );

    if (user.rows[0].solde < montant)
      return res.status(400).json({ error: "Solde insuffisant" });

    const code = Math.floor(100000 + Math.random() * 900000).toString();

    await client.query("BEGIN");

    await client.query(
      "UPDATE users SET solde = solde - $1 WHERE id = $2",
      [montant, req.user.id]
    );

    await client.query(
      "INSERT INTO reservations (user_id, montant, code) VALUES ($1, $2, $3)",
      [req.user.id, montant, code]
    );

    await client.query("COMMIT");

    res.json({ message: "Réservation confirmée ✅", code });

  } catch (error) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

app.listen(process.env.PORT || 10000, () => {
  console.log("Server running");
});
