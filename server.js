const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ message: "Wheely DZ API Running 🚴" });
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("Server running");
});
