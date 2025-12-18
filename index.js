const express = require('express');
const app = express();
app.use(express.json());

require('./db/database');
const db = require('./db/database');

const { crearUsuario } = require('./auth/auth');
const { login } = require('./auth/auth');
const { verificarToken, soloGerente } = require('./middleware/authMiddleware');
const path = require('path');
app.use(express.static(path.join(__dirname, 'public')));
//--------------------------MATRICULAR - PROCESO DIFICIL JAJA--------------------//
app.get('/matricular', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/matricular.html'));
});
//--------------------------------------------------------------------------------//










// Puerto compatible con Linux / Render
const PORT = process.env.PORT || 3000;

// PAGINA PRINCIPAL LOGIN //
app.get('/', (req, res) => {
  res.redirect('/login');
});
//----------------------------------//


app.post('/login', (req, res) => {
  const { usuario, password } = req.body;

  if (!usuario || !password) {
    return res.status(400).json({ mensaje: 'Datos incompletos' });
  }

  login(usuario, password, (resultado) => {
    if (!resultado) {
      return res.status(401).json({ mensaje: 'Credenciales incorrectas' });
    }

    res.json(resultado);
  });
});


app.get('/admin', verificarToken, soloGerente, (req, res) => {
  res.json({
    mensaje: 'Bienvenido al panel de gerente',
    usuario: req.usuario
  });
});

app.post('/usuarios/secretaria', verificarToken, soloGerente, (req, res) => {
  const { usuario, password } = req.body;

  if (!usuario || !password) {
    return res.status(400).json({ mensaje: 'Datos incompletos' });
  }

  crearUsuario(usuario, password, 'secretaria');
  res.json({ mensaje: 'Secretaria creada correctamente' });
});

//ruta gerente protegida
app.get('/panel-gerente', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/admin.html'));
});


//ruta login fronted
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/login.html'));
});

//CREACION DE CURSOS, SOLO GERENTE.
app.post('/cursos', verificarToken, soloGerente, (req, res) => {
  const { nombre, descripcion, precio } = req.body;

  if (!nombre || !precio) {
    return res.status(400).json({ mensaje: 'Nombre y precio son obligatorios' });
  }

  db.run(
    'INSERT INTO cursos (nombre, descripcion, precio) VALUES (?, ?, ?)',
    [nombre, descripcion || '', precio],
    function (err) {
      if (err) {
        return res.status(500).json({ mensaje: 'Error al crear curso' });
      }

      res.json({
        mensaje: 'Curso creado correctamente',
        id: this.lastID
      });
    }
  );
});

//VER CURSOS Y ASIGNAR SECRETARIA
app.get('/cursos', verificarToken, (req, res) => {
  db.all(
    'SELECT * FROM cursos WHERE activo = 1',
    [],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ mensaje: 'Error al obtener cursos' });
      }
      res.json(rows);
    }
  );
});

//DESACTIVAR CURSOS O ACTIVAR - GERENTE
app.put('/cursos/:id/desactivar', verificarToken, soloGerente, (req, res) => {
  const { id } = req.params;

  db.run(
    'UPDATE cursos SET activo = 0 WHERE id = ?',
    [id],
    function (err) {
      if (err) {
        return res.status(500).json({ mensaje: 'Error al desactivar curso' });
      }

      res.json({ mensaje: 'Curso desactivado' });
    }
  );
});

//MATRICULAR ESTUDIANTE, GERENTE Y SECRETARIA
app.post('/estudiantes', verificarToken, (req, res) => {
  const { nombre, cedula, telefono, ciudad, direccion, curso_id } = req.body;

  if (!nombre || !cedula || !curso_id) {
    return res.status(400).json({ mensaje: 'Datos obligatorios faltantes' });
  }

  // Obtener precio del curso
  db.get(
    'SELECT precio FROM cursos WHERE id = ? AND activo = 1',
    [curso_id],
    (err, curso) => {
      if (err || !curso) {
        return res.status(400).json({ mensaje: 'Curso no válido' });
      }

      const precio = curso.precio;

      db.run(
        `INSERT INTO estudiantes 
        (nombre, cedula, telefono, ciudad, direccion, curso_id, precio_curso, saldo)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          nombre,
          cedula,
          telefono || '',
          ciudad || '',
          direccion || '',
          curso_id,
          precio,
          precio
        ],
        function (err) {
          if (err) {
            return res.status(500).json({ mensaje: 'Error al matricular estudiante' });
          }

          res.json({
            mensaje: 'Estudiante matriculado correctamente',
            id: this.lastID
          });
        }
      );
    }
  );
});

//LISTA O VER ESTUDIANTES - AMBOS ROLES
app.get('/estudiantes', verificarToken, (req, res) => {
  db.all(
    `SELECT e.*, c.nombre AS curso_nombre
     FROM estudiantes e
     JOIN cursos c ON e.curso_id = c.id`,
    [],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ mensaje: 'Error al obtener estudiantes' });
      }
      res.json(rows);
    }
  );
});
// registrar abono !!
app.post('/abonos', verificarToken, (req, res) => {
  const { estudiante_id, valor } = req.body;

  if (!estudiante_id || !valor) {
    return res.status(400).json({ mensaje: 'Datos incompletos' });
  }

  db.get(
    'SELECT saldo FROM estudiantes WHERE id = ?',
    [estudiante_id],
    (err, estudiante) => {
      if (err || !estudiante) {
        return res.status(400).json({ mensaje: 'Estudiante no encontrado' });
      }

      if (valor > estudiante.saldo) {
        return res.status(400).json({ mensaje: 'El abono supera el saldo' });
      }

      const nuevoSaldo = estudiante.saldo - valor;
      const fecha = new Date().toISOString();

      db.run(
        'INSERT INTO abonos (estudiante_id, valor, fecha, usuario_id) VALUES (?, ?, ?, ?)',
        [estudiante_id, valor, fecha, req.usuario.id],
        function (err) {
          if (err) {
            return res.status(500).json({ mensaje: 'Error al registrar abono' });
          }

          db.run(
            'UPDATE estudiantes SET saldo = ? WHERE id = ?',
            [nuevoSaldo, estudiante_id],
            function (err) {
              if (err) {
                return res.status(500).json({ mensaje: 'Error al actualizar saldo' });
              }

              res.json({
                mensaje: 'Abono registrado correctamente',
                saldo_actual: nuevoSaldo
              });
            }
          );
        }
      );
    }
  );
});

// ver abonos
app.get('/abonos/:estudiante_id', verificarToken, (req, res) => {
  const { estudiante_id } = req.params;

  db.all(
    `SELECT a.id, a.valor, a.fecha, u.usuario AS registrado_por
     FROM abonos a
     LEFT JOIN usuarios u ON a.usuario_id = u.id
     WHERE a.estudiante_id = ?`,
    [estudiante_id],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ mensaje: 'Error al obtener abonos' });
      }
      res.json(rows);
    }
  );
});

//--------------------------------ESTUDIANTES PAGINA--------------------------------
app.get('/estudiantes-panel', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/estudiantes.html'));
});

//ver cursos//
app.get('/cursos-panel', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/cursos.html'));
});
//ver cursos//

//------------------------------------------------------------------------//

//---------RUTA PARA EL DASHBOARD------------//
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/dashboard.html'));
});
//---------------------------------------------//


// Arrancar servidor
app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
