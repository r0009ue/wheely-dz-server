const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json());

// ================= DATABASE =================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ================= JWT MIDDLEWARE =================
function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token)
    return res.status(401).json({ error: "Token manquant" });

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err)
      return res.status(403).json({ error: "Token invalide" });

    req.user = user;
    next();
  });
}

// ================= ROOT =================
app.get("/", (req, res) => {
  res.json({ message: "Wheely DZ API Running 🚴" });
});

// ================= INIT DB =================
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
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      ALTER TABLE reservations
      ADD COLUMN IF NOT EXISTS used BOOLEAN DEFAULT false;
    `);
    await pool.query(`
      ALTER TABLE reservations
      ADD COLUMN IF NOT EXISTS started_at TIMESTAMP;
      `);

    res.json({ message: "Tables prêtes ✅" });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ================= REGISTER =================
app.post("/register", async (req, res) => {
  try {
    const { nom, email, password } = req.body;

    if (!nom || !email || !password) {
      return res.status(400).json({ error: "Champs requis manquants" });
    }

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
  try {
    const user = await pool.query(
      "SELECT id, nom, email, solde FROM users WHERE id = $1",
      [req.user.id]
    );

    res.json(user.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ================= DEPOSIT =================
app.post("/deposit", authenticateToken, async (req, res) => {
  try {
    const { amount } = req.body;

    if (!amount || amount <= 0)
      return res.status(400).json({ error: "Montant invalide" });

    await pool.query(
      "UPDATE users SET solde = solde + $1 WHERE id = $2",
      [amount, req.user.id]
    );

    const updatedUser = await pool.query(
      "SELECT solde FROM users WHERE id = $1",
      [req.user.id]
    );

    res.json({
      message: "Paiement confirmé 💳",
      newSolde: updatedUser.rows[0].solde
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
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

    if (user.rows.length === 0)
      return res.status(404).json({ error: "Utilisateur introuvable" });

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

// ================= UNLOCK =================
app.post("/unlock", authenticateToken, async (req, res) => {
  try {
    const { code } = req.body;

    if (!code)
      return res.status(400).json({ error: "Code requis" });

    const reservation = await pool.query(
      `SELECT * FROM reservations 
       WHERE code = $1 
       AND user_id = $2 
       AND used = false`,
      [code, req.user.id]
    );

    if (reservation.rows.length === 0) {
      return res.status(400).json({
        error: "Code invalide ou déjà utilisé"
      });
    }

    await pool.query(
      "UPDATE reservations SET used = true, started_at = NOW() WHERE id = $1",
      [reservation.rows[0].id]
    );

    res.json({ message: "🚴 Vélo déverrouillé avec succès !" });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ================= START SERVER =================
const PORT = process.env.PORT || 10000;

// ================= ADMIN STATS =================
app.get("/admin/stats", authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ error: "Accès refusé" });
    }

    const users = await pool.query("SELECT COUNT(*) FROM users");
    const reservations = await pool.query("SELECT COUNT(*) FROM reservations");
    const revenue = await pool.query("SELECT COALESCE(SUM(montant),0) FROM reservations");

    res.json({
      totalUsers: users.rows[0].count,
      totalReservations: reservations.rows[0].count,
      totalRevenue: revenue.rows[0].coalesce
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
// ================= MY RESERVATIONS =================
app.get("/my-reservations", authenticateToken, async (req, res) => {
  try {
    const reservations = await pool.query(
      `SELECT montant, code, used, created_at
       FROM reservations
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [req.user.id]
    );

    res.json(reservations.rows);

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
app.post("/end-ride", authenticateToken, async (req, res) => {

  try {

    const ride = await pool.query(
      `SELECT * FROM reservations 
       WHERE user_id = $1 
       AND used = true 
       AND started_at IS NOT NULL
       ORDER BY started_at DESC
       LIMIT 1`,
      [req.user.id]
    );

    if (ride.rows.length === 0)
      return res.status(400).json({ error: "Aucune course active" });

    const startTime = ride.rows[0].started_at;
    const now = new Date();

    const durationMinutes =
      Math.floor((now - startTime) / 60000);

    res.json({
      message: "Course terminée",
      duration: durationMinutes
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }

});

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
