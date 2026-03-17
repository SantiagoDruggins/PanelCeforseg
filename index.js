const express = require('express');
const app = express();
const path = require('path');
const fs = require('fs');
const multer = require('multer');

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const db = require('./db/database');
const { login } = require('./auth/auth');
const { verificarToken, permitirRoles } = require('./middleware/authMiddleware');

const PORT = 3000;

/* =====================================================
   RUTAS HTML
===================================================== */
app.get('/', (_, res) => res.redirect('/login'));
app.get('/login', (_, res) => res.sendFile(path.join(__dirname, 'public/login.html')));
app.get('/dashboard', (_, res) => res.sendFile(path.join(__dirname, 'public/dashboard.html')));
app.get('/estudiantes-panel', (_, res) => res.sendFile(path.join(__dirname, 'public/estudiantes.html')));
app.get('/estudiante-ficha', (_, res) => res.sendFile(path.join(__dirname, 'public/estudiante-ficha.html')));
app.get('/matricular', (_, res) => res.sendFile(path.join(__dirname, 'public/matricular.html')));
app.get('/cursos-panel', (_, res) => res.sendFile(path.join(__dirname, 'public/cursos.html')));
app.get('/usuarios-panel', (_, res) => res.sendFile(path.join(__dirname, 'public/usuarios.html')));
app.get('/certificados-panel', (_, res) => res.sendFile(path.join(__dirname, 'public/certificados.html')));
app.get('/validar', (_, res) => res.sendFile(path.join(__dirname, 'public/validar.html')));
app.get('/cierre-caja', (_, res) =>
  res.sendFile(path.join(__dirname, 'public/cierre-caja.html'))
);


/* =====================================================
   LOGIN
===================================================== */
app.post('/login', (req, res) => {
  login(req.body.usuario, req.body.password, data => {
    if (!data) return res.status(401).json({ mensaje: 'Credenciales incorrectas' });
    res.json(data);
  });
});

/* =====================================================
   DASHBOARD
===================================================== */
app.get('/api/dashboard',
  verificarToken,
  permitirRoles('gerente','secretaria'),
  (req, res) => {

    db.serialize(() => {

      db.get(
        "SELECT COUNT(*) total FROM estudiantes",
        (_, estudiantes) => {

          db.get(
            "SELECT COUNT(*) total FROM cursos WHERE activo=1",
            (_, cursos) => {

              db.get(
                "SELECT IFNULL(SUM(valor),0) total FROM abonos WHERE DATE(fecha)=DATE('now')",
                (_, hoy) => {

                  db.get(
                    "SELECT IFNULL(SUM(valor),0) total FROM abonos",
                    (_, total) => {

                      db.get(
                        "SELECT IFNULL(SUM(saldo),0) total FROM estudiante_cursos WHERE saldo>0",
                        (_, deuda) => {

                          db.get(
                            "SELECT COUNT(DISTINCT estudiante_id) total FROM estudiante_cursos WHERE saldo>0",
                            (_, deudores) => {

                              res.json({
                                estudiantes: estudiantes.total,
                                cursos: cursos.total,
                                recaudo_hoy: hoy.total,
                                recaudo_total: total.total,
                                deuda_total: deuda.total,
                                alumnos_deudores: deudores.total
                              });

                            }
                          );
                        }
                      );
                    }
                  );
                }
              );
            }
          );
        }
      );
    });
});


/* =====================================================
   CURSOS
===================================================== */
app.get('/api/cursos',
  verificarToken,
  permitirRoles('gerente','secretaria'),
  (_, res) => {
    db.all(
      // 🔥 AQUI SE AGREGA descripcion
      'SELECT id, nombre, descripcion, precio FROM cursos WHERE activo=1 ORDER BY id DESC',
      [],
      (_, rows) => res.json(rows || [])
    );
});

app.post('/api/cursos',
  verificarToken,
  permitirRoles('gerente'),
  (req, res) => {
    const { nombre, descripcion, precio } = req.body;
    db.run(
      'INSERT INTO cursos (nombre, descripcion, precio) VALUES (?,?,?)',
      [nombre, descripcion, precio],
      () => res.json({ mensaje:'Curso creado' })
    );
});

app.delete('/api/cursos/:id',
  verificarToken,
  permitirRoles('gerente'),
  (req, res) => {
    db.run(
      'UPDATE cursos SET activo=0 WHERE id=?',
      [req.params.id],
      () => res.json({ mensaje:'Curso eliminado' })
    );
});

/* =====================================================
   USUARIOS
===================================================== */
const bcrypt = require('bcryptjs');

/* LISTAR USUARIOS */
app.get('/api/usuarios',
  verificarToken,
  permitirRoles('gerente'),
  (_, res) => {
    db.all(
      'SELECT id, usuario, rol FROM usuarios ORDER BY id DESC',
      [],
      (_, rows) => res.json(rows || [])
    );
});

/* CREAR USUARIO */
app.post('/api/usuarios',
  verificarToken,
  permitirRoles('gerente'),
  async (req, res) => {

    const { usuario, password, rol } = req.body;
    if(!usuario || !password || !rol){
      return res.status(400).json({ mensaje:'Datos incompletos' });
    }

    const hash = await bcrypt.hash(password, 10);

    db.run(
      'INSERT INTO usuarios (usuario, password, rol) VALUES (?,?,?)',
      [usuario, hash, rol],
      err => {
        if(err){
          return res.status(400).json({ mensaje:'Usuario ya existe' });
        }
        res.json({ mensaje:'Usuario creado correctamente' });
      }
    );
});

/* ELIMINAR USUARIO (EVITA BORRARSE A SÍ MISMO) */
app.delete('/api/usuarios/:id',
  verificarToken,
  permitirRoles('gerente'),
  (req, res) => {

    db.get(
      'SELECT id, rol FROM usuarios WHERE id=?',
      [req.params.id],
      (_, row) => {

        if(!row){
          return res.status(404).json({ mensaje:'Usuario no encontrado' });
        }

        if(Number(row.id) === Number(req.usuario.id)){
          return res.status(403).json({ mensaje:'No puedes eliminar tu propio usuario' });
        }

        db.run(
          'DELETE FROM usuarios WHERE id=?',
          [req.params.id],
          function(){
            if(this.changes === 0){
              return res.status(404).json({ mensaje:'Usuario no encontrado' });
            }
            res.json({ mensaje:'Usuario eliminado' });
          }
        );
      }
    );
});

/* EDITAR USUARIO (SOLO GERENTE) */
app.put('/api/usuarios/:id',
  verificarToken,
  permitirRoles('gerente'),
  async (req, res) => {

    const { usuario, rol, password } = req.body;
    const id = req.params.id;

    db.get('SELECT id FROM usuarios WHERE id=?', [id], async (err, row) => {
      if (err || !row) return res.status(404).json({ mensaje: 'Usuario no encontrado' });

      const updates = [];
      const values = [];

      if (usuario !== undefined && usuario !== '') {
        updates.push('usuario = ?');
        values.push(usuario);
      }
      if (rol !== undefined && rol !== '') {
        updates.push('rol = ?');
        values.push(rol);
      }
      if (password !== undefined && password !== '') {
        updates.push('password = ?');
        values.push(await bcrypt.hash(password, 10));
      }

      if (updates.length === 0) {
        return res.status(400).json({ mensaje: 'No hay datos para actualizar' });
      }

      values.push(id);
      db.run(
        `UPDATE usuarios SET ${updates.join(', ')} WHERE id=?`,
        values,
        function () {
          if (this.changes === 0) return res.status(404).json({ mensaje: 'Usuario no encontrado' });
          res.json({ mensaje: 'Usuario actualizado' });
        }
      );
    });
  });


/* =====================================================
   FOTO ESTUDIANTE
===================================================== */
const FOTO_DIR = path.join(__dirname, 'public/uploads/fotos');
fs.mkdirSync(FOTO_DIR, { recursive: true });

const uploadFoto = multer({
  storage: multer.diskStorage({
    destination: FOTO_DIR,
    filename: (_, file, cb) => cb(null, Date.now() + '_' + file.originalname)
  })
});

/* =====================================================
   CERTIFICADOS (SUBIDA DE PDF)
===================================================== */
const CERT_DIR = path.join(__dirname, 'public/uploads/certificados');
fs.mkdirSync(CERT_DIR, { recursive: true });

const uploadCert = multer({
  storage: multer.diskStorage({
    destination: CERT_DIR,
    filename: (_, file, cb) => cb(null, Date.now() + '_' + file.originalname)
  })
});

/* =====================================================
   LISTAR ESTUDIANTES
===================================================== */
app.get('/api/estudiantes',
  verificarToken,
  permitirRoles('gerente','secretaria'),
  (_, res) => {
    db.all(`
      SELECT 
        e.id,
        e.nombre,
        e.cedula,
        GROUP_CONCAT(c.nombre, ', ') AS cursos,
        IFNULL(SUM(ec.saldo),0) AS saldo
      FROM estudiantes e
      LEFT JOIN estudiante_cursos ec ON ec.estudiante_id = e.id
      LEFT JOIN cursos c ON c.id = ec.curso_id
      GROUP BY e.id
      ORDER BY e.id DESC
    `, [], (_, rows) => res.json(rows || []));
});

/* =====================================================
   CREAR ESTUDIANTE
===================================================== */
app.post('/api/estudiantes',
  verificarToken,
  permitirRoles('gerente','secretaria'),
  uploadFoto.single('foto'),
  (req, res) => {

    const { nombre, cedula, telefono, ciudad, direccion, email, contacto_emergencia, fecha_matricula } = req.body;
    let cursos = req.body.curso_ids || [];
    if (!Array.isArray(cursos)) cursos = [cursos];

    const foto = req.file ? `/uploads/fotos/${req.file.filename}` : null;
    const fechaMat = fecha_matricula || new Date().toISOString().slice(0, 10);

    db.run(`
      INSERT INTO estudiantes
      (nombre, cedula, telefono, ciudad, direccion, foto, email, contacto_emergencia, fecha_matricula)
      VALUES (?,?,?,?,?,?,?,?,?)
    `,
    [nombre, cedula, telefono, ciudad, direccion, foto, email || null, contacto_emergencia || null, fechaMat],
    function(err){
      if(err) return res.status(400).json({ mensaje:'Cédula ya registrada' });

      const estudianteId = this.lastID;

      cursos.forEach(cursoId => {
        db.get(
          'SELECT precio FROM cursos WHERE id=? AND activo=1',
          [cursoId],
          (_, curso) => {
            if(!curso) return;
            db.run(`
              INSERT INTO estudiante_cursos
              (estudiante_id, curso_id, precio, saldo)
              VALUES (?,?,?,?)
            `,
            [estudianteId, cursoId, curso.precio, curso.precio]);
          }
        );
      });

      res.json({ mensaje:'Estudiante creado' });
    });
});



/* =====================================================
   OBTENER FICHA ESTUDIANTE
===================================================== */
app.get('/api/estudiantes/:id',
  verificarToken,
  permitirRoles('gerente','secretaria'),
  (req, res) => {

    db.get(
      'SELECT * FROM estudiantes WHERE id=?',
      [req.params.id],
      (_, est) => {
        if(!est) return res.status(404).json({ mensaje:'No encontrado' });

        db.all(`
          SELECT 
            ec.curso_id,
            c.nombre,
            c.descripcion,   -- 🔥 AQUI SE AGREGA
            ec.precio,
            ec.saldo
          FROM estudiante_cursos ec
          JOIN cursos c ON c.id = ec.curso_id
          WHERE ec.estudiante_id=?
        `,
        [req.params.id],
        (_, cursos) => {
          res.json({
            ...est,
            cursos: cursos || []
          });
        });
      }
    );
});

/* =====================================================
   EDITAR ESTUDIANTE
===================================================== */
app.put('/api/estudiantes/:id',
  verificarToken,
  permitirRoles('gerente','secretaria'),
  (req, res) => {

    const { nombre, telefono, ciudad, direccion, email, contacto_emergencia, fecha_matricula } = req.body;

    db.run(`
      UPDATE estudiantes
      SET nombre=?, telefono=?, ciudad=?, direccion=?, email=?, contacto_emergencia=?, fecha_matricula=?
      WHERE id=?
    `,
    [nombre, telefono, ciudad, direccion, email || null, contacto_emergencia || null, fecha_matricula || null, req.params.id],
    () => res.json({ mensaje:'Estudiante actualizado' }));
});

/* =====================================================
   AGREGAR CURSO A ESTUDIANTE
===================================================== */
app.post('/api/estudiantes/:id/curso',
  verificarToken,
  permitirRoles('gerente','secretaria'),
  (req, res) => {

    const { curso_id } = req.body;

    db.get(
      'SELECT precio FROM cursos WHERE id=? AND activo=1',
      [curso_id],
      (_, curso) => {
        if(!curso) return res.status(400).json({ mensaje:'Curso inválido' });

        db.run(`
          INSERT INTO estudiante_cursos
          (estudiante_id, curso_id, precio, saldo)
          VALUES (?,?,?,?)
        `,
        [req.params.id, curso_id, curso.precio, curso.precio],
        () => res.json({ mensaje:'Curso agregado' }));
      }
    );
});

/* =====================================================
   ABONOS
===================================================== */
app.get('/api/abonos/:id',
  verificarToken,
  permitirRoles('gerente','secretaria'),
  (req, res) => {
    db.all(`
      SELECT 
        a.id,
        a.fecha,
        a.valor,
        a.nota,
        a.rol,
        a.metodo_pago,
        a.numero_factura,
        u.usuario,
        c.nombre AS curso,
        a.curso_id
      FROM abonos a
      LEFT JOIN usuarios u ON u.id = a.usuario_id
      LEFT JOIN cursos c ON c.id = a.curso_id
      WHERE a.estudiante_id=?
      ORDER BY a.fecha DESC
    `,
    [req.params.id],
    (_, rows) => res.json(rows || []));
});

app.post('/api/abonos',
  verificarToken,
  permitirRoles('gerente','secretaria'),
  (req, res) => {

    const { estudiante_id, curso_id, valor, nota, metodo_pago, numero_factura } = req.body;

    const numeroFactura = (numero_factura || '').toString().trim();
    if (!numeroFactura) return res.status(400).json({ mensaje: 'El número de factura es obligatorio' });

    const metodo = metodo_pago || 'efectivo';

    db.get(
      'SELECT saldo FROM estudiante_cursos WHERE estudiante_id=? AND curso_id=?',
      [estudiante_id, curso_id],
      (_, row) => {
        if(!row) return res.status(400).json({ mensaje:'Curso inválido' });

        const nuevoSaldo = row.saldo - valor;

        db.run(`
          INSERT INTO abonos
          (estudiante_id, curso_id, valor, fecha, usuario_id, nota, rol, metodo_pago, numero_factura)
          VALUES (?,?,?,?,?,?,?,?,?)
        `,
        [
          estudiante_id,
          curso_id,
          valor,
          new Date().toISOString(),
          req.usuario.id,
          nota || null,
          req.usuario.rol,
          metodo,
          numeroFactura
        ]);

        db.run(
          'UPDATE estudiante_cursos SET saldo=? WHERE estudiante_id=? AND curso_id=?',
          [nuevoSaldo, estudiante_id, curso_id],
          () => res.json({ mensaje:'Abono registrado' })
        );
      }
    );
});

/* EDITAR ABONO (SOLO GERENTE/SECRETARIA) */
app.put('/api/abonos/:id',
  verificarToken,
  permitirRoles('gerente','secretaria'),
  (req, res) => {
    const { valor, nota, metodo_pago, numero_factura } = req.body;
    const idAbono = req.params.id;

    db.get('SELECT estudiante_id, curso_id, valor AS valor_anterior FROM abonos WHERE id=?', [idAbono], (err, abono) => {
      if (err || !abono) return res.status(404).json({ mensaje: 'Abono no encontrado' });

      const valorNuevo = valor !== undefined ? Number(valor) : abono.valor_anterior;
      const diferencia = valorNuevo - Number(abono.valor_anterior);

      db.run(`
        UPDATE abonos SET valor=?, nota=?, metodo_pago=?, numero_factura=?
        WHERE id=?
      `, [valorNuevo, nota || null, metodo_pago || 'efectivo', (numero_factura || '').toString().trim() || null, idAbono], function () {
        if (this.changes === 0) return res.status(404).json({ mensaje: 'Abono no encontrado' });

        db.run(
          'UPDATE estudiante_cursos SET saldo = saldo - ? WHERE estudiante_id=? AND curso_id=?',
          [diferencia, abono.estudiante_id, abono.curso_id],
          () => res.json({ mensaje: 'Abono actualizado' })
        );
      });
    });
  });

/* ELIMINAR ABONO */
app.delete('/api/abonos/:id',
  verificarToken,
  permitirRoles('gerente','secretaria'),
  (req, res) => {
    db.get('SELECT estudiante_id, curso_id, valor FROM abonos WHERE id=?', [req.params.id], (err, abono) => {
      if (err || !abono) return res.status(404).json({ mensaje: 'Abono no encontrado' });

      db.run('DELETE FROM abonos WHERE id=?', [req.params.id], function () {
        if (this.changes === 0) return res.status(404).json({ mensaje: 'Abono no encontrado' });

        db.run(
          'UPDATE estudiante_cursos SET saldo = saldo + ? WHERE estudiante_id=? AND curso_id=?',
          [abono.valor, abono.estudiante_id, abono.curso_id],
          () => res.json({ mensaje: 'Abono eliminado' })
        );
      });
    });
  });

/* =====================================================
   CIERRE DE CAJA - DATOS DEL SISTEMA
===================================================== */
app.get('/api/cierre-caja/hoy',
  verificarToken,
  permitirRoles('gerente','secretaria'),
  (req, res) => {

    db.all(`
      SELECT 
        metodo_pago,
        IFNULL(SUM(valor),0) AS total
      FROM abonos
      WHERE DATE(fecha,'localtime') = DATE('now','localtime')
      GROUP BY metodo_pago
    `, [], (_, rows) => {

      let efectivo = 0;
      let nequi = 0;

      rows.forEach(r => {
        if(r.metodo_pago === 'efectivo') efectivo = r.total;
        if(r.metodo_pago === 'nequi') nequi = r.total;
      });

      res.json({
        efectivo_sistema: efectivo,
        nequi_sistema: nequi,
        total_sistema: efectivo + nequi
      });
    });
});

/* =====================================================
   HISTORIAL DE CIERRES (GERENTE)
===================================================== */
app.get('/api/cierres-caja',
  verificarToken,
  permitirRoles('gerente'),
  (req, res) => {

    db.all(`
      SELECT 
        cc.id,
        DATE(cc.fecha) AS dia,
        cc.efectivo_sistema,
        cc.nequi_sistema,
        cc.total_sistema,
        cc.efectivo_reportado,
        cc.nequi_reportado,
        cc.diferencia,
        u.usuario
      FROM cierres_caja cc
      LEFT JOIN usuarios u ON u.id = cc.usuario_id
      ORDER BY cc.fecha DESC
    `, [], (_, rows) => {
      res.json(rows || []);
    });
});

/* ELIMINAR CIERRE DE CAJA (SOLO GERENTE) */
app.delete('/api/cierres-caja/:id',
  verificarToken,
  permitirRoles('gerente'),
  (req, res) => {
    db.run(
      'DELETE FROM cierres_caja WHERE id=?',
      [req.params.id],
      function(){
        if(this.changes === 0){
          return res.status(404).json({ mensaje:'Cierre no encontrado' });
        }
        res.json({ mensaje:'Cierre eliminado' });
      }
    );
});

/* EDITAR CIERRE DE CAJA (SOLO GERENTE) */
app.put('/api/cierres-caja/:id',
  verificarToken,
  permitirRoles('gerente'),
  (req, res) => {

    const efectivo_reportado = Number(req.body.efectivo_reportado || 0);
    const nequi_reportado = Number(req.body.nequi_reportado || 0);

    db.get(
      'SELECT total_sistema FROM cierres_caja WHERE id=?',
      [req.params.id],
      (_, row) => {
        if(!row){
          return res.status(404).json({ mensaje:'Cierre no encontrado' });
        }

        const diferencia = efectivo_reportado + nequi_reportado - Number(row.total_sistema || 0);

        db.run(
          `
          UPDATE cierres_caja
          SET efectivo_reportado=?,
              nequi_reportado=?,
              diferencia=?
          WHERE id=?
          `,
          [efectivo_reportado, nequi_reportado, diferencia, req.params.id],
          function(){
            if(this.changes === 0){
              return res.status(404).json({ mensaje:'Cierre no encontrado' });
            }
            res.json({ mensaje:'Cierre actualizado correctamente' });
          }
        );
      }
    );
});


app.get('/cierres-caja-panel', (_, res) =>
  res.sendFile(path.join(__dirname, 'public/cierres-caja.html'))
);



/* =====================================================
   REGISTRAR CIERRE DE CAJA
===================================================== */
app.post('/api/cierre-caja',
  verificarToken,
  permitirRoles('gerente','secretaria'),
  (req, res) => {

    const {
      efectivo_reportado,
      nequi_reportado
    } = req.body;

    // 1️⃣ Verificar si ya hay cierre hoy
    db.get(`
      SELECT id FROM cierres_caja
      WHERE DATE(fecha,'localtime') = DATE('now','localtime')
    `, [], (_, existe) => {

      if(existe){
        return res.status(400).json({
          mensaje: 'Ya existe un cierre de caja para hoy'
        });
      }

      // 2️⃣ Obtener valores del sistema
      db.all(`
        SELECT 
          metodo_pago,
          IFNULL(SUM(valor),0) AS total
        FROM abonos
        WHERE DATE(fecha,'localtime') = DATE('now','localtime')
        GROUP BY metodo_pago
      `, [], (_, rows) => {

        let efectivoSistema = 0;
        let nequiSistema = 0;

        rows.forEach(r => {
          if(r.metodo_pago === 'efectivo') efectivoSistema = r.total;
          if(r.metodo_pago === 'nequi') nequiSistema = r.total;
        });

        const totalSistema = efectivoSistema + nequiSistema;
        const totalReportado = Number(efectivo_reportado) + Number(nequi_reportado);
        const diferencia = totalReportado - totalSistema;

        // 3️⃣ Guardar cierre
        db.run(`
          INSERT INTO cierres_caja (
            fecha,
            efectivo_sistema,
            nequi_sistema,
            total_sistema,
            efectivo_reportado,
            nequi_reportado,
            diferencia,
            usuario_id,
            creado_en
          ) VALUES (?,?,?,?,?,?,?,?,?)
        `, [
          new Date().toISOString(),
          efectivoSistema,
          nequiSistema,
          totalSistema,
          efectivo_reportado,
          nequi_reportado,
          diferencia,
          req.usuario.id,
          new Date().toISOString()
        ], () => {
          res.json({ mensaje:'Cierre de caja registrado correctamente' });
        });
      });
    });
});
  

/* =====================================================
   ELIMINAR ESTUDIANTE
===================================================== */
app.delete('/api/estudiantes/:id',
  verificarToken,
  permitirRoles('gerente'),
  (req, res) => {

    const id = req.params.id;

    db.serialize(() => {
      db.run('DELETE FROM abonos WHERE estudiante_id=?', [id]);
      db.run('DELETE FROM certificados WHERE estudiante_id=?', [id]);
      db.run('DELETE FROM estudiante_cursos WHERE estudiante_id=?', [id]);
      db.run('DELETE FROM estudiantes WHERE id=?', [id],
        () => res.json({ mensaje:'Estudiante eliminado' })
      );
    });
});


/* =====================================================
   BUSCAR ESTUDIANTES
===================================================== */
app.get('/api/estudiantes/buscar',
  verificarToken,
  permitirRoles('gerente','secretaria'),
  (req, res) => {

    const q = `%${(req.query.q || '').trim()}%`;

    db.all(`
      SELECT 
        e.id,
        e.nombre,
        e.cedula,
        e.telefono,
        GROUP_CONCAT(c.nombre, ', ') AS cursos,
        IFNULL(SUM(ec.saldo),0) AS saldo
      FROM estudiantes e
      LEFT JOIN estudiante_cursos ec ON ec.estudiante_id = e.id
      LEFT JOIN cursos c ON c.id = ec.curso_id
      WHERE 
        e.nombre LIKE ?
        OR e.cedula LIKE ?
        OR e.telefono LIKE ?
      GROUP BY e.id
      ORDER BY e.nombre ASC
      LIMIT 50
    `,
    [q, q, q],
    (_, rows) => res.json(rows || []));
});


/* =====================================================
   SUBIR CERTIFICADOS (PDF)
===================================================== */
app.post('/api/certificados',
  verificarToken,
  permitirRoles('gerente','secretaria'),
  uploadCert.single('pdf'),
  (req, res) => {

    const { cedula, nombre, curso, fecha_diploma } = req.body;

    if(!cedula || !curso){
      return res.status(400).json({ mensaje:'Cédula y curso son obligatorios' });
    }

    if(!req.file){
      return res.status(400).json({ mensaje:'Debe adjuntar un archivo PDF' });
    }

    const rutaPdf = `/uploads/certificados/${req.file.filename}`;
    const fechaEmision = fecha_diploma || new Date().toISOString().slice(0,10);

    db.serialize(() => {

      // 1️⃣ Buscar o crear estudiante por cédula
      db.get(
        'SELECT id FROM estudiantes WHERE cedula=?',
        [cedula],
        (err, est) => {
          if(err){
            return res.status(500).json({ mensaje:'Error buscando estudiante' });
          }

          const continuarConEstudiante = (estudianteId) => {

            // 2️⃣ Buscar o crear curso por nombre
            db.get(
              'SELECT id FROM cursos WHERE nombre=?',
              [curso],
              (err2, c) => {
                if(err2){
                  return res.status(500).json({ mensaje:'Error buscando curso' });
                }

                const continuarConCurso = (cursoId) => {

                  // 3️⃣ Registrar certificado (compatibilidad con tabla existente)
                  db.run(`
                    INSERT INTO certificados
                    (estudiante_id, cedula, nombre, curso, fecha_diploma, tipo, archivo_pdf, fecha_subida, curso_id, fecha_emision)
                    VALUES (?,?,?,?,?,?,?,?,?,?)
                  `,
                  [
                    estudianteId,
                    cedula,
                    nombre || cedula,
                    curso,
                    fechaEmision,
                    'nuevo',
                    rutaPdf,
                    new Date().toISOString(),
                    cursoId,
                    fechaEmision
                  ],
                  err3 => {
                    if(err3){
                      console.error('Error insertando certificado:', err3.message);
                      return res.status(500).json({ mensaje:'Error guardando certificado: ' + err3.message });
                    }
                    res.json({ mensaje:'Certificado subido correctamente' });
                  });
                };

                if(c){
                  continuarConCurso(c.id);
                } else {
                  db.run(
                    'INSERT INTO cursos (nombre, descripcion, precio) VALUES (?,?,?)',
                    [curso, null, 0],
                    function(errCreateCurso){
                      if(errCreateCurso){
                        return res.status(500).json({ mensaje:'Error creando curso' });
                      }
                      continuarConCurso(this.lastID);
                    }
                  );
                }
              }
            );
          };

          if(est){
            continuarConEstudiante(est.id);
          } else {
            db.run(`
              INSERT INTO estudiantes
              (nombre, cedula, telefono, ciudad, direccion, estado, foto)
              VALUES (?,?,?,?,?,?,?)
            `,
            [nombre || cedula, cedula, '', '', '', 'activo', null],
            function(errCreateEst){
              if(errCreateEst){
                return res.status(500).json({ mensaje:'Error creando estudiante' });
              }
              continuarConEstudiante(this.lastID);
            });
          }
        }
      );
    });
});


/* =====================================================
   VALIDAR CERTIFICADOS
===================================================== */
app.get('/api/validar/:cedula', (req, res) => {
  db.all(`
    SELECT 
      e.nombre,
      c.nombre AS curso,
      cert.archivo_pdf,
      cert.fecha_emision AS fecha_diploma
    FROM certificados cert
    JOIN estudiantes e ON e.id = cert.estudiante_id
    JOIN cursos c ON c.id = cert.curso_id
    WHERE e.cedula = ?
    ORDER BY cert.fecha_emision DESC
  `,
  [req.params.cedula],
  (_, certs) => {
    if(!certs || certs.length === 0){
      return res.json({ valido:false });
    }
    res.json({
      valido:true,
      estudiante:{ nombre: certs[0].nombre },
      certificados: certs
    });
  });
});

app.listen(PORT, () => {
  console.log('Servidor OK en puerto', PORT);
});
