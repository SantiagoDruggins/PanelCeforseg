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
    foto TEXT,
    email TEXT,
    contacto_emergencia TEXT,
    fecha_matricula TEXT
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
    metodo_pago TEXT DEFAULT 'efectivo',
    numero_factura TEXT,
    FOREIGN KEY (estudiante_id) REFERENCES estudiantes(id),
    FOREIGN KEY (curso_id) REFERENCES cursos(id)
  )
`);

// Añadir metodo_pago si la tabla ya existía sin esa columna
db.run(`ALTER TABLE abonos ADD COLUMN metodo_pago TEXT DEFAULT 'efectivo'`, (err) => {
  if (err && !err.message.includes('duplicate column')) console.log('abonos.metodo_pago:', err.message);
});
db.run(`ALTER TABLE abonos ADD COLUMN numero_factura TEXT`, (err) => {
  if (err && !err.message.includes('duplicate column')) console.log('abonos.numero_factura:', err.message);
});
// Estudiantes: nuevos campos matrícula
db.run(`ALTER TABLE estudiantes ADD COLUMN email TEXT`, (err) => {
  if (err && !err.message.includes('duplicate column')) console.log('estudiantes.email:', err.message);
});
db.run(`ALTER TABLE estudiantes ADD COLUMN contacto_emergencia TEXT`, (err) => {
  if (err && !err.message.includes('duplicate column')) console.log('estudiantes.contacto_emergencia:', err.message);
});
db.run(`ALTER TABLE estudiantes ADD COLUMN fecha_matricula TEXT`, (err) => {
  if (err && !err.message.includes('duplicate column')) console.log('estudiantes.fecha_matricula:', err.message);
});
db.run(`ALTER TABLE estudiantes ADD COLUMN usuario_matricula_id INTEGER REFERENCES usuarios(id)`, (err) => {
  if (err && !err.message.includes('duplicate column')) console.log('estudiantes.usuario_matricula_id:', err.message);
});

/* =========================
   COMISIONES / NÓMINA
========================= */
db.run(`
  CREATE TABLE IF NOT EXISTS comisiones_curso (
    curso_id INTEGER PRIMARY KEY,
    valor_comision INTEGER DEFAULT 0,
    FOREIGN KEY (curso_id) REFERENCES cursos(id)
  )
`);
db.run(`
  CREATE TABLE IF NOT EXISTS config (
    clave TEXT PRIMARY KEY,
    valor TEXT
  )
`);
db.run(`
  CREATE TABLE IF NOT EXISTS nomina_basico (
    usuario_id INTEGER PRIMARY KEY,
    valor_basico INTEGER DEFAULT 0,
    tipo_basico TEXT DEFAULT 'mensual',
    FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
  )
`);

/* =========================
   CIERRES DE CAJA
========================= */
db.run(`
  CREATE TABLE IF NOT EXISTS cierres_caja (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha TEXT,
    efectivo_sistema REAL DEFAULT 0,
    nequi_sistema REAL DEFAULT 0,
    total_sistema REAL DEFAULT 0,
    efectivo_reportado REAL DEFAULT 0,
    nequi_reportado REAL DEFAULT 0,
    diferencia REAL DEFAULT 0,
    usuario_id INTEGER,
    creado_en TEXT,
    FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
  )
`);

/* =========================
   CERTIFICADOS (NUEVO)
========================= */
db.run(`
  CREATE TABLE IF NOT EXISTS certificados (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    estudiante_id INTEGER,
    cedula TEXT NOT NULL,
    nombre TEXT NOT NULL,
    curso TEXT NOT NULL,
    fecha_diploma TEXT NOT NULL,
    tipo TEXT NOT NULL DEFAULT 'nuevo',
    archivo_pdf TEXT,
    fecha_subida TEXT NOT NULL,
    curso_id INTEGER,
    fecha_emision TEXT,
    FOREIGN KEY (estudiante_id) REFERENCES estudiantes(id),
    FOREIGN KEY (curso_id) REFERENCES cursos(id)
  )
`);

// Asegurar columnas nuevas en bases antiguas
db.run(`ALTER TABLE certificados ADD COLUMN curso_id INTEGER`, (err) => {
  if (err && !err.message.includes('duplicate column')) {
    console.log('certificados.curso_id:', err.message);
  }
});

db.run(`ALTER TABLE certificados ADD COLUMN fecha_emision TEXT`, (err) => {
  if (err && !err.message.includes('duplicate column')) {
    console.log('certificados.fecha_emision:', err.message);
  }
});

db.run(`ALTER TABLE certificados ADD COLUMN cedula TEXT`, (err) => {
  if (err && !err.message.includes('duplicate column')) {
    console.log('certificados.cedula:', err.message);
  }
});

db.run(`ALTER TABLE certificados ADD COLUMN nombre TEXT`, (err) => {
  if (err && !err.message.includes('duplicate column')) {
    console.log('certificados.nombre:', err.message);
  }
});

db.run(`ALTER TABLE certificados ADD COLUMN curso TEXT`, (err) => {
  if (err && !err.message.includes('duplicate column')) {
    console.log('certificados.curso:', err.message);
  }
});

db.run(`ALTER TABLE certificados ADD COLUMN fecha_diploma TEXT`, (err) => {
  if (err && !err.message.includes('duplicate column')) {
    console.log('certificados.fecha_diploma:', err.message);
  }
});

/* =========================
   AUDITORÍA (blindaje anti-fraude)
========================= */
db.run(`
  CREATE TABLE IF NOT EXISTS auditoria (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id INTEGER,
    usuario_nombre TEXT,
    rol TEXT,
    accion TEXT NOT NULL,
    tabla_afectada TEXT,
    registro_id INTEGER,
    detalles TEXT,
    creado_en TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
  )
`);

module.exports = db;
