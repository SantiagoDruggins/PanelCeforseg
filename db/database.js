const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Ruta segura (Windows / Linux)
const dbPath = path.join(__dirname, 'panelceforseg.db');

// Crear / conectar base de datos
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error al conectar la base de datos', err);
  } else {
    console.log('Base de datos conectada');
  }
});

// Crear tabla usuarios
db.run(`
  CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario TEXT UNIQUE,
    password TEXT,
    rol TEXT
  )
`);

// Crear tabla cursos
db.run(`
  CREATE TABLE IF NOT EXISTS cursos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT,
    descripcion TEXT,
    precio INTEGER,
    activo INTEGER DEFAULT 1
  )
`);


// Crear tabla estudiantes
db.run(`
  CREATE TABLE IF NOT EXISTS estudiantes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT,
    cedula TEXT UNIQUE,
    telefono TEXT,
    ciudad TEXT,
    direccion TEXT,
    curso_id INTEGER,
    precio_curso INTEGER,
    saldo INTEGER,
    estado TEXT DEFAULT 'activo',
    FOREIGN KEY (curso_id) REFERENCES cursos(id)
  )
`);



// Crear tabla abonos
db.run(`
  CREATE TABLE IF NOT EXISTS abonos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    estudiante_id INTEGER,
    valor INTEGER,
    fecha TEXT,
    usuario_id INTEGER,
    FOREIGN KEY (estudiante_id) REFERENCES estudiantes(id)
  )
`);


db.run(`
  ALTER TABLE estudiantes ADD COLUMN foto TEXT
`, () => {});

// ✅ Intentar agregar columna foto (si ya existe, no pasa nada)
db.run(`ALTER TABLE estudiantes ADD COLUMN foto TEXT`, (err) => {
  // Si ya existe, SQLite tira error, pero lo ignoramos
});




module.exports = db;

