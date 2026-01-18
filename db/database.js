const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Ruta segura DB
const dbPath = path.join(__dirname, 'panelceforseg.db');

// Conexión
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error al conectar la base de datos', err);
  } else {
    console.log('Base de datos conectada');
  }
});

/* =========================
   USUARIOS
========================= */
db.run(`
  CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario TEXT UNIQUE,
    password TEXT,
    rol TEXT
  )
`);

/* =========================
   CURSOS
========================= */
db.run(`
  CREATE TABLE IF NOT EXISTS cursos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT,
    descripcion TEXT,
    precio INTEGER,
    activo INTEGER DEFAULT 1
  )
`);

/* =========================
   ESTUDIANTES
========================= */
db.run(`
  CREATE TABLE IF NOT EXISTS estudiantes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT,
    cedula TEXT UNIQUE,
    telefono TEXT,
    ciudad TEXT,
    direccion TEXT,
    estado TEXT DEFAULT 'activo',
    foto TEXT
  )
`);

/* =========================
   ESTUDIANTE ↔ CURSOS
========================= */
db.run(`
  CREATE TABLE IF NOT EXISTS estudiante_cursos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    estudiante_id INTEGER,
    curso_id INTEGER,
    precio INTEGER,
    saldo INTEGER,
    FOREIGN KEY (estudiante_id) REFERENCES estudiantes(id),
    FOREIGN KEY (curso_id) REFERENCES cursos(id)
  )
`);

/* =========================
   ABONOS (POR CURSO)
========================= */
db.run(`
  CREATE TABLE IF NOT EXISTS abonos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    estudiante_id INTEGER,
    curso_id INTEGER,
    valor INTEGER,
    fecha TEXT,
    usuario_id INTEGER,
    nota TEXT,
    rol TEXT,
    FOREIGN KEY (estudiante_id) REFERENCES estudiantes(id),
    FOREIGN KEY (curso_id) REFERENCES cursos(id)
  )
`);

/* =========================
   CERTIFICADOS (NUEVO)
========================= */
db.run(`
  CREATE TABLE IF NOT EXISTS certificados (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    estudiante_id INTEGER,
    curso_id INTEGER,
    archivo_pdf TEXT,
    fecha_emision TEXT,
    estado TEXT DEFAULT 'valido',
    FOREIGN KEY (estudiante_id) REFERENCES estudiantes(id),
    FOREIGN KEY (curso_id) REFERENCES cursos(id)
  )
`);

module.exports = db;
