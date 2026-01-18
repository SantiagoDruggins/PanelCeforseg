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
   RUTAS HTML (PANELES)
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

/* =====================================================
   LOGIN
===================================================== */
app.post('/login', (req, res) => {
  login(req.body.usuario, req.body.password, data => {
    if (!data) return res.status(401).json({ mensaje: 'Credenciales incorrectas' });
    res.json(data);
  });
});


/* =========================
   DASHBOARD
========================= */
app.get('/api/dashboard',
  verificarToken,
  permitirRoles('gerente','secretaria'),
  (req, res) => {
    db.serialize(() => {
      db.get('SELECT COUNT(*) total FROM estudiantes', (_, e) => {
        db.get('SELECT COUNT(*) total FROM cursos WHERE activo=1', (_, c) => {
          db.get('SELECT IFNULL(SUM(valor),0) total FROM abonos', (_, r) => {
            res.json({
              estudiantes: e.total,
              cursos: c.total,
              recaudo: r.total
            });
          });
        });
      });
    });
});

/* =====================================================
   CURSOS
===================================================== */
app.get('/api/cursos', verificarToken, permitirRoles('gerente','secretaria'), (req, res) => {
  db.all('SELECT * FROM cursos WHERE activo=1 ORDER BY id DESC', [], (_, rows) => {
    res.json(rows);
  });
});

app.post('/api/cursos', verificarToken, permitirRoles('gerente'), (req, res) => {
  const { nombre, descripcion, precio } = req.body;
  db.run(
    'INSERT INTO cursos (nombre, descripcion, precio) VALUES (?,?,?)',
    [nombre, descripcion, precio],
    () => res.json({ mensaje:'Curso creado' })
  );
});

app.delete('/api/cursos/:id', verificarToken, permitirRoles('gerente'), (req, res) => {
  db.run('UPDATE cursos SET activo=0 WHERE id=?', [req.params.id], () => {
    res.json({ mensaje:'Curso eliminado' });
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
   LISTAR ESTUDIANTES
===================================================== */
app.get('/api/estudiantes', verificarToken, permitirRoles('gerente','secretaria'), (req, res) => {
  db.all(`
    SELECT 
      e.id,
      e.nombre,
      e.cedula,
      GROUP_CONCAT(c.nombre, ', ') AS cursos,
      SUM(ec.saldo) AS saldo
    FROM estudiantes e
    LEFT JOIN estudiante_cursos ec ON ec.estudiante_id = e.id
    LEFT JOIN cursos c ON c.id = ec.curso_id
    GROUP BY e.id
    ORDER BY e.id DESC
  `, [], (_, rows) => res.json(rows));
});

/* =====================================================
   MATRICULAR ESTUDIANTE (MULTI-CURSO)
===================================================== */
app.post(
  '/api/estudiantes',
  verificarToken,
  permitirRoles('gerente','secretaria'),
  uploadFoto.single('foto'),
  (req, res) => {

    const { nombre, cedula, telefono, ciudad, direccion } = req.body;
    let cursos = req.body.curso_ids || [];
    if (!Array.isArray(cursos)) cursos = [cursos];

    const foto = req.file ? `/uploads/fotos/${req.file.filename}` : null;

    db.run(`
      INSERT INTO estudiantes
      (nombre, cedula, telefono, ciudad, direccion, foto)
      VALUES (?,?,?,?,?,?)
    `,
    [nombre, cedula, telefono, ciudad, direccion, foto],
    function(err){
      if(err){
        return res.status(400).json({ mensaje:'Cédula ya registrada' });
      }

      const estudianteId = this.lastID;

      cursos.forEach(cursoId => {
        db.get('SELECT precio FROM cursos WHERE id=? AND activo=1',[cursoId],(_,curso)=>{
          if(!curso) return;
          db.run(`
            INSERT INTO estudiante_cursos
            (estudiante_id, curso_id, precio, saldo)
            VALUES (?,?,?,?)
          `,
          [estudianteId, cursoId, curso.precio, curso.precio]);
        });
      });

      res.json({ mensaje:'Estudiante matriculado correctamente' });
    });
  }
);

/* =====================================================
   FICHA ESTUDIANTE
===================================================== */
app.get('/api/estudiantes/:id', verificarToken, permitirRoles('gerente','secretaria'), (req, res) => {
  db.get('SELECT * FROM estudiantes WHERE id=?',[req.params.id],(_,est)=>{
    if(!est) return res.status(404).json({ mensaje:'No encontrado' });

    db.all(`
      SELECT 
        ec.curso_id,
        c.nombre,
        c.descripcion,
        ec.precio,
        ec.saldo
      FROM estudiante_cursos ec
      JOIN cursos c ON c.id = ec.curso_id
      WHERE ec.estudiante_id=?
    `,[req.params.id],(_,cursos)=>{
      res.json({ ...est, cursos });
    });
  });
});

/* =====================================================
   ABONOS
===================================================== */
app.get('/api/abonos/:id', verificarToken, permitirRoles('gerente','secretaria'), (req, res) => {
  db.all(`
    SELECT 
      a.fecha,
      a.valor,
      a.nota,
      a.rol,
      u.usuario,
      c.nombre AS curso
    FROM abonos a
    LEFT JOIN usuarios u ON u.id = a.usuario_id
    LEFT JOIN cursos c ON c.id = a.curso_id
    WHERE a.estudiante_id=?
    ORDER BY a.fecha DESC
  `,[req.params.id],(_,rows)=>res.json(rows));
});

app.post('/api/abonos', verificarToken, permitirRoles('gerente','secretaria'), (req, res) => {
  const { estudiante_id, curso_id, valor, nota } = req.body;

  db.get(
    'SELECT saldo FROM estudiante_cursos WHERE estudiante_id=? AND curso_id=?',
    [estudiante_id, curso_id],
    (_,row)=>{
      if(!row) return res.status(400).json({ mensaje:'Curso inválido' });

      const nuevoSaldo = row.saldo - valor;

      db.run(`
        INSERT INTO abonos
        (estudiante_id, curso_id, valor, fecha, usuario_id, nota, rol)
        VALUES (?,?,?,?,?,?,?)
      `,
      [estudiante_id, curso_id, valor, new Date().toISOString(), req.usuario.id, nota, req.usuario.rol]);

      db.run(
        'UPDATE estudiante_cursos SET saldo=? WHERE estudiante_id=? AND curso_id=?',
        [nuevoSaldo, estudiante_id, curso_id],
        ()=>res.json({ mensaje:'Abono registrado' })
      );
    }
  );
});

/* =====================================================
   ELIMINAR ESTUDIANTE
===================================================== */
app.delete('/api/estudiantes/:id', verificarToken, permitirRoles('gerente'), (req, res) => {
  const id = req.params.id;
  db.serialize(()=>{
    db.run('DELETE FROM abonos WHERE estudiante_id=?',[id]);
    db.run('DELETE FROM certificados WHERE estudiante_id=?',[id]);
    db.run('DELETE FROM estudiante_cursos WHERE estudiante_id=?',[id]);
    db.run('DELETE FROM estudiantes WHERE id=?',[id],()=>{
      res.json({ mensaje:'Estudiante eliminado correctamente' });
    });
  });
});

/* =====================================================
   CERTIFICADOS (ARREGLADO A TU DB REAL)
===================================================== */
const CERT_DIR = path.join(__dirname,'public/uploads/certificados');
fs.mkdirSync(CERT_DIR,{ recursive:true });

const uploadCert = multer({
  storage: multer.diskStorage({
    destination: CERT_DIR,
    filename:(_,file,cb)=>cb(null,Date.now()+'_'+file.originalname)
  })
});

app.post('/api/certificados',
  verificarToken,
  permitirRoles('gerente','secretaria'),
  uploadCert.single('pdf'),
  (req,res)=>{

    const { cedula, nombre, curso, fecha_diploma } = req.body;
    if(!cedula || !curso || !req.file){
      return res.status(400).json({ mensaje:'Datos incompletos' });
    }

    db.run(`
      INSERT INTO certificados
      (cedula, nombre, curso, fecha_diploma, archivo_pdf, fecha_subida)
      VALUES (?,?,?,?,?,?)
    `,
    [
      cedula,
      nombre || 'SIN NOMBRE',
      curso,
      fecha_diploma || new Date().toISOString().slice(0,10),
      `/uploads/certificados/${req.file.filename}`,
      new Date().toISOString()
    ],
    ()=>res.json({ mensaje:'Certificado generado correctamente' })
  );
});

/* =====================================================
   VALIDACIÓN PÚBLICA POR CÉDULA (FIX FINAL)
===================================================== */
app.get('/api/validar/:cedula',(req,res)=>{
  const cedula = req.params.cedula;

  db.all(`
    SELECT nombre, curso, archivo_pdf, fecha_diploma
    FROM certificados
    WHERE cedula=?
    ORDER BY fecha_diploma DESC
  `,[cedula],(_,certs)=>{

    if(!certs || certs.length === 0){
      return res.json({ valido:false });
    }

    res.json({
      valido:true,
      estudiante:{
        cedula,
        nombre: certs[0].nombre
      },
      certificados: certs
    });
  });
});

app.listen(PORT,()=>{
  console.log('Servidor OK en puerto',PORT);
});
