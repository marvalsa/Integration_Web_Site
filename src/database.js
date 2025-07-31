// src/database.js
const { Pool } = require("pg");
require("dotenv").config();

console.log("🐘 Creando pool de conexiones PostgreSQL para la aplicación...");

const pool = new Pool({
  host: process.env.PG_HOST,
  database: process.env.PG_DATABASE,
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  port: process.env.PG_PORT || 5432,
  ssl: process.env.PG_SSL === "true" ? { rejectUnauthorized: false } : false,

  // --- Configuraciones clave para robustez y eficiencia ---
  max: 10, // Máximo de conexiones en el pool.
  idleTimeoutMillis: 30000, // Cierra conexiones inactivas después de 30s.
  connectionTimeoutMillis: 5000, // Falla rápido si no puede obtener una conexión en 5s.
});

// Listener de errores global para el pool.
pool.on('error', (err, client) => {
  console.error('❌ Error inesperado en un cliente inactivo del pool', err);
  process.exit(-1); // Salir si el pool se vuelve inestable
});

// Exportamos la ÚNICA instancia del pool.
module.exports = pool;