const express = require('express');
const app = express();
const path = require('path');
const fs = require('fs');
const multer = require('multer');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const db = require('./db/database');
const { login } = require('./auth/auth');
const { verificarToken, permitirRoles } = require('./middleware/authMiddleware');

const PORT = 3000;

/* =========================
   RUTAS HTML (PANELES)
========================= */
app.get('/', (_, res) => res.redirect('/login'));
app.get('/login', (_, res) => res.sendFile(path.join(__dirname, 'public/login.html')));
app.get('/dashboard', (_, res) => res.sendFile(path.join(__dirname, 'public/dashboard.html')));
app.get('/estudiantes-panel', (_, res) => res.sendFile(path.join(__dirname, 'public/estudiantes.html')));
app.get('/estudiante-ficha', (_, res) => res.sendFile(path.join(__dirname, 'public/estudiante-ficha.html')));
app.get('/matricular', (_, res) => res.sendFile(path.join(__dirname, 'public/matricular.html')));
app.get('/cursos-panel', (_, res) => res.sendFile(path.join(__dirname, 'public/cursos.html')));
app.get('/usuarios-panel', (_, res) => res.sendFile(path.join(__dirname, 'public/usuarios.html')));

/* =========================
   LOGIN
========================= */
app.post('/login', (req, res) => {
  login(req.body.usuario, req.body.password, data => {
    if (!data) return res.status(401).json({ mensaje: 'Credenciales incorrectas' });
    res.json(data);
  });
});

/* =========================
   API CURSOS
========================= */
app.get('/api/cursos', verificarToken, permitirRoles('gerente','secretaria'), (req, res) => {
  db.all('SELECT * FROM cursos WHERE activo = 1 ORDER BY id DESC', [], (_, rows) => {
    res.json(rows);
  });
});

/* =========================
   FOTO ESTUDIANTE
========================= */
const FOTO_DIR = path.join(__dirname, 'public/uploads/fotos');
fs.mkdirSync(FOTO_DIR, { recursive: true });

const uploadFoto = multer({
  storage: multer.diskStorage({
    destination: FOTO_DIR,
    filename: (_, file, cb) => cb(null, Date.now() + '_' + file.originalname)
  })
});

/* =========================
   API ESTUDIANTES
========================= */
app.get('/api/estudiantes', verificarToken, permitirRoles('gerente','secretaria'), (req, res) => {
  db.all(`
    SELECT e.*, c.nombre AS curso_nombre
    FROM estudiantes e
    JOIN cursos c ON e.curso_id = c.id
  `, [], (_, rows) => res.json(rows));
});

app.post(
  '/api/estudiantes',
  verificarToken,
  permitirRoles('gerente','secretaria'),
  uploadFoto.single('foto'),
  (req, res) => {
    const { nombre, cedula, telefono, ciudad, direccion, curso_id } = req.body;
    const foto = req.file ? `/uploads/fotos/${req.file.filename}` : null;

    db.get('SELECT precio FROM cursos WHERE id=? AND activo=1', [curso_id], (_, c) => {
      if (!c) return res.status(400).json({ mensaje: 'Curso inválido' });

      db.run(`
        INSERT INTO estudiantes
        (nombre, cedula, telefono, ciudad, direccion, curso_id, precio_curso, saldo, foto)
        VALUES (?,?,?,?,?,?,?,?,?)
      `, [
        nombre, cedula, telefono, ciudad, direccion,
        curso_id, c.precio, c.precio, foto
      ], function () {
        res.json({ mensaje: 'Estudiante matriculado', id: this.lastID });
      });
    });
  }
);
// OBTENER FICHA DE ESTUDIANTE
app.get('/api/estudiantes/:id', verificarToken, permitirRoles('gerente','secretaria'), (req, res) => {
  db.get(`
    SELECT e.*, c.nombre AS curso_nombre
    FROM estudiantes e
    JOIN cursos c ON e.curso_id = c.id
    WHERE e.id = ?
  `, [req.params.id], (err, row) => {
    if (err || !row) {
      return res.status(404).json({ mensaje: 'Estudiante no encontrado' });
    }
    res.json(row);
  });
});

// ELIMINAR ESTUDIANTE (solo gerente)
app.delete('/api/estudiantes/:id', verificarToken, permitirRoles('gerente'), (req, res) => {
  db.run(
    'DELETE FROM estudiantes WHERE id=?',
    [req.params.id],
    () => res.json({ mensaje: 'Estudiante eliminado' })
  );
});

/* =========================
   API ABONOS (CON NOTAS Y ROL)
========================= */

// LISTAR ABONOS POR ESTUDIANTE
app.get('/api/abonos/:id', verificarToken, permitirRoles('gerente','secretaria'), (req, res) => {
  db.all(
    `
    SELECT 
      a.valor,
      a.fecha,
      a.nota,
      a.rol,
      u.usuario
    FROM abonos a
    LEFT JOIN usuarios u ON u.id = a.usuario_id
    WHERE a.estudiante_id = ?
    ORDER BY a.fecha DESC
    `,
    [req.params.id],
    (err, rows) => {
      if (err) return res.status(500).json({ mensaje: 'Error cargando abonos' });
      res.json(rows);
    }
  );
});

// REGISTRAR ABONO
app.post('/api/abonos', verificarToken, permitirRoles('gerente','secretaria'), (req, res) => {
  const { estudiante_id, valor, nota } = req.body;

  if (!valor || !nota) {
    return res.status(400).json({ mensaje: 'Valor y nota son obligatorios' });
  }

  db.get('SELECT saldo FROM estudiantes WHERE id=?', [estudiante_id], (_, e) => {
    if (!e) return res.status(404).json({ mensaje: 'Estudiante no encontrado' });

    const nuevoSaldo = e.saldo - valor;

    db.run(
      `
      INSERT INTO abonos 
      (estudiante_id, valor, fecha, usuario_id, nota, rol)
      VALUES (?,?,?,?,?,?)
      `,
      [
        estudiante_id,
        valor,
        new Date().toISOString(),
        req.usuario.id,
        nota,
        req.usuario.rol
      ]
    );

    db.run(
      'UPDATE estudiantes SET saldo=? WHERE id=?',
      [nuevoSaldo, estudiante_id],
      () => {
        res.json({
          mensaje: 'Abono registrado',
          saldo: nuevoSaldo
        });
      }
    );
  });
});


app.listen(PORT, () => console.log('Servidor OK en puerto', PORT));
