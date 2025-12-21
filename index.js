const express = require('express');
const app = express();
app.use(express.json());

const path = require('path');
app.use(express.static(path.join(__dirname, 'public')));

const db = require('./db/database');
const { crearUsuario, login } = require('./auth/auth');
const { verificarToken, permitirRoles } = require('./middleware/authMiddleware');

const PORT = process.env.PORT || 3000;

/* ===========================
   RUTAS HTML (SIN TOKEN)
=========================== */
app.get('/', (_, res) => res.redirect('/login'));
app.get('/login', (_, res) => res.sendFile(__dirname + '/public/login.html'));
app.get('/dashboard', (_, res) => res.sendFile(__dirname + '/public/dashboard.html'));
app.get('/usuarios-panel', (_, res) => res.sendFile(__dirname + '/public/usuarios.html'));
app.get('/cursos-panel', (_, res) => res.sendFile(__dirname + '/public/cursos.html'));
app.get('/estudiantes-panel', (_, res) => res.sendFile(__dirname + '/public/estudiantes.html'));
app.get('/matricular', (_, res) => res.sendFile(__dirname + '/public/matricular.html'));

/* ===========================
   LOGIN
=========================== */
app.post('/login', (req, res) => {
  const { usuario, password } = req.body;
  login(usuario, password, data => {
    if (!data) {
      return res.status(401).json({ mensaje: 'Credenciales incorrectas' });
    }
    res.json(data);
  });
});

/* ===========================
   USUARIOS (SOLO GERENTE)
=========================== */
app.get('/usuarios', verificarToken, permitirRoles('gerente'), (req, res) => {
  db.all('SELECT id, usuario, rol FROM usuarios', [], (_, rows) => {
    res.json(rows);
  });
});

app.post('/usuarios', verificarToken, permitirRoles('gerente'), (req, res) => {
  const { usuario, password, rol } = req.body;
  crearUsuario(usuario, password, rol);
  res.json({ mensaje: 'Usuario creado correctamente' });
});

app.delete('/usuarios/:id', verificarToken, permitirRoles('gerente'), (req, res) => {
  const { id } = req.params;

  // No permitir borrar al propio usuario
  if (parseInt(id) === req.usuario.id) {
    return res.status(400).json({ mensaje: 'No puedes eliminar tu propio usuario' });
  }

  // 1️⃣ Obtener el rol del usuario a eliminar
  db.get(
    'SELECT rol FROM usuarios WHERE id = ?',
    [id],
    (err, user) => {
      if (err || !user) {
        return res.status(404).json({ mensaje: 'Usuario no encontrado' });
      }

      // 2️⃣ Si NO es gerente → eliminar directo
      if (user.rol !== 'gerente') {
        db.run(
          'DELETE FROM usuarios WHERE id = ?',
          [id],
          () => res.json({ mensaje: 'Usuario eliminado correctamente' })
        );
        return;
      }

      // 3️⃣ Si ES gerente → verificar que no sea el último
      db.get(
        'SELECT COUNT(*) AS total FROM usuarios WHERE rol = "gerente"',
        [],
        (_, row) => {
          if (row.total <= 1) {
            return res.status(400).json({
              mensaje: 'Debe existir al menos un gerente en el sistema'
            });
          }

          db.run(
            'DELETE FROM usuarios WHERE id = ?',
            [id],
            () => res.json({ mensaje: 'Gerente eliminado correctamente' })
          );
        }
      );
    }
  );
});

/* ===========================
   CURSOS
=========================== */
app.get('/cursos', verificarToken, permitirRoles('gerente','secretaria'), (req, res) => {
  db.all('SELECT * FROM cursos WHERE activo = 1', [], (_, rows) => {
    res.json(rows);
  });
});

app.post('/cursos', verificarToken, permitirRoles('gerente','secretaria'), (req, res) => {
  const { nombre, descripcion, precio } = req.body;
  if (!nombre || !precio) {
    return res.status(400).json({ mensaje: 'Datos incompletos' });
  }

  db.run(
    'INSERT INTO cursos (nombre, descripcion, precio) VALUES (?,?,?)',
    [nombre, descripcion || '', precio],
    function () {
      res.json({ mensaje: 'Curso creado correctamente', id: this.lastID });
    }
  );
});

app.put('/cursos/:id/desactivar', verificarToken, permitirRoles('gerente'), (req, res) => {
  db.run('UPDATE cursos SET activo = 0 WHERE id = ?', [req.params.id]);
  res.json({ mensaje: 'Curso desactivado' });
});

/* ===========================
   ESTUDIANTES
=========================== */
app.get('/estudiantes', verificarToken, permitirRoles('gerente','secretaria'), (req, res) => {
  db.all(
    `SELECT e.*, c.nombre AS curso_nombre
     FROM estudiantes e
     JOIN cursos c ON e.curso_id = c.id`,
    [],
    (_, rows) => res.json(rows)
  );
});

app.post('/estudiantes', verificarToken, permitirRoles('gerente','secretaria'), (req, res) => {
  const { nombre, cedula, telefono, ciudad, vivienda, curso_id } = req.body;

  if (!nombre || !cedula || !curso_id) {
    return res.status(400).json({ mensaje: 'Datos obligatorios faltantes' });
  }

  db.get('SELECT precio FROM cursos WHERE id = ?', [curso_id], (_, curso) => {
    if (!curso) {
      return res.status(400).json({ mensaje: 'Curso no válido' });
    }

    db.run(
      `INSERT INTO estudiantes
      (nombre, cedula, telefono, ciudad, direccion, curso_id, precio_curso, saldo)
      VALUES (?,?,?,?,?,?,?,?)`,
      [
        nombre,
        cedula,
        telefono || '',
        ciudad || '',
        vivienda || '',
        curso_id,
        curso.precio,
        curso.precio
      ],
      function () {
        res.json({ mensaje: 'Estudiante matriculado correctamente', id: this.lastID });
      }
    );
  });
});

/* ===========================
   ABONOS
=========================== */
app.post('/abonos', verificarToken, permitirRoles('gerente','secretaria'), (req, res) => {
  const { estudiante_id, valor } = req.body;

  if (!estudiante_id || !valor) {
    return res.status(400).json({ mensaje: 'Datos incompletos' });
  }

  db.get('SELECT saldo FROM estudiantes WHERE id = ?', [estudiante_id], (_, est) => {
    if (!est || valor > est.saldo) {
      return res.status(400).json({ mensaje: 'Abono inválido' });
    }

    const nuevoSaldo = est.saldo - valor;

    db.run(
      'INSERT INTO abonos (estudiante_id, valor, fecha, usuario_id) VALUES (?,?,?,?)',
      [estudiante_id, valor, new Date().toISOString(), req.usuario.id]
    );

    db.run(
      'UPDATE estudiantes SET saldo = ? WHERE id = ?',
      [nuevoSaldo, estudiante_id]
    );

    res.json({ mensaje: 'Abono registrado', saldo_actual: nuevoSaldo });
  });
});

app.get('/abonos/:id', verificarToken, permitirRoles('gerente','secretaria'), (req, res) => {
  db.all(
    `SELECT a.fecha, a.valor, u.usuario
     FROM abonos a
     LEFT JOIN usuarios u ON a.usuario_id = u.id
     WHERE a.estudiante_id = ?`,
    [req.params.id],
    (_, rows) => res.json(rows)
  );
});

/* ===========================
   SERVER
=========================== */
app.listen(PORT, () => {
  console.log('Servidor OK en puerto', PORT);
});
