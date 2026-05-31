const express = require('express');
const app = express();
const path = require('path');
const fs = require('fs');
const multer = require('multer');

function cargarEnvLocal() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  lines.forEach(line => {
    const clean = line.trim();
    if (!clean || clean.startsWith('#')) return;
    const idx = clean.indexOf('=');
    if (idx === -1) return;
    const key = clean.slice(0, idx).trim();
    const value = clean.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    if (key && process.env[key] === undefined) process.env[key] = value;
  });
}

cargarEnvLocal();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const db = require('./db/database');
const { login } = require('./auth/auth');
const { verificarToken, permitirRoles } = require('./middleware/authMiddleware');

const PORT = 3000;

/* Helper: registrar acción en auditoría (blindaje) */
function registrarAuditoria(req, accion, tabla_afectada, registro_id, detalles) {
  const u = req.usuario || {};
  const det = typeof detalles === 'string' ? detalles : (detalles ? JSON.stringify(detalles) : null);
  db.run(
    `INSERT INTO auditoria (usuario_id, usuario_nombre, rol, accion, tabla_afectada, registro_id, detalles)
     VALUES (?,?,?,?,?,?,?)`,
    [u.id || null, u.usuario || null, u.rol || null, accion, tabla_afectada || null, registro_id || null, det],
    () => {}
  );
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || []));
  });
}

function ymd(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function buildPeriodoFinanciero(query = {}) {
  const hoy = new Date();
  const periodo = (query.periodo || 'dia').toString();
  let desde;
  let hasta;

  if (query.desde && query.hasta) {
    desde = String(query.desde).slice(0, 10);
    hasta = String(query.hasta).slice(0, 10);
  } else if (periodo === 'semana') {
    const d = new Date(hoy);
    const day = d.getDay() || 7;
    d.setDate(d.getDate() - day + 1);
    desde = ymd(d);
    hasta = ymd(hoy);
  } else if (periodo === 'quincena') {
    const day = hoy.getDate();
    desde = ymd(new Date(hoy.getFullYear(), hoy.getMonth(), day <= 15 ? 1 : 16));
    hasta = ymd(hoy);
  } else if (periodo === 'mes') {
    desde = ymd(new Date(hoy.getFullYear(), hoy.getMonth(), 1));
    hasta = ymd(hoy);
  } else if (periodo === 'trimestre') {
    const firstMonth = Math.floor(hoy.getMonth() / 3) * 3;
    desde = ymd(new Date(hoy.getFullYear(), firstMonth, 1));
    hasta = ymd(hoy);
  } else if (periodo === 'anio') {
    desde = ymd(new Date(hoy.getFullYear(), 0, 1));
    hasta = ymd(hoy);
  } else {
    desde = ymd(hoy);
    hasta = ymd(hoy);
  }

  const d1 = new Date(desde + 'T12:00:00');
  const d2 = new Date(hasta + 'T12:00:00');
  const dias = Math.max(1, Math.round((d2 - d1) / 86400000) + 1);
  const prevHasta = ymd(addDays(d1, -1));
  const prevDesde = ymd(addDays(d1, -dias));

  return { periodo, desde, hasta, dias, prev_desde: prevDesde, prev_hasta: prevHasta };
}

async function calcularCostoNomina(desde, hasta, dias) {
  const basicos = await dbAll(`SELECT valor_basico, tipo_basico FROM nomina_basico`, []);
  const costoBasico = basicos.reduce((sum, row) => {
    const valor = Number(row.valor_basico) || 0;
    const divisor = row.tipo_basico === 'quincenal' ? 15 : 30;
    return sum + Math.round(valor * (dias / divisor));
  }, 0);

  const config = await dbGet('SELECT valor FROM config WHERE clave=?', ['comision_por_matricula']);
  const comisionMatricula = config ? Number(config.valor) || 0 : 0;
  const matriculas = await dbGet(`
    SELECT COUNT(*) AS total
    FROM estudiantes
    WHERE usuario_matricula_id IS NOT NULL
      AND DATE(fecha_matricula) BETWEEN DATE(?) AND DATE(?)
  `, [desde, hasta]);
  const costoMatriculas = (Number(matriculas && matriculas.total) || 0) * comisionMatricula;

  const comisionesCurso = await dbGet(`
    SELECT IFNULL(SUM(IFNULL(cc.valor_comision, 0)), 0) AS total
    FROM estudiante_cursos ec
    JOIN estudiantes e ON e.id = ec.estudiante_id
    LEFT JOIN comisiones_curso cc ON cc.curso_id = ec.curso_id
    WHERE e.usuario_matricula_id IS NOT NULL
      AND DATE(e.fecha_matricula) BETWEEN DATE(?) AND DATE(?)
  `, [desde, hasta]);

  const costoCursos = Number(comisionesCurso && comisionesCurso.total) || 0;
  return {
    basico: costoBasico,
    comisiones_matricula: costoMatriculas,
    comisiones_cursos: costoCursos,
    total: costoBasico + costoMatriculas + costoCursos
  };
}

async function resumenFinanciero(query = {}) {
  const rango = buildPeriodoFinanciero(query);

  const ingresos = await dbGet(`
    SELECT
      IFNULL(SUM(valor), 0) AS total,
      IFNULL(SUM(CASE WHEN metodo_pago='efectivo' THEN valor ELSE 0 END), 0) AS efectivo,
      IFNULL(SUM(CASE WHEN metodo_pago='nequi' THEN valor ELSE 0 END), 0) AS nequi,
      IFNULL(SUM(CASE WHEN metodo_pago NOT IN ('efectivo','nequi') OR metodo_pago IS NULL THEN valor ELSE 0 END), 0) AS transferencia,
      COUNT(*) AS movimientos
    FROM abonos
    WHERE DATE(fecha,'localtime') BETWEEN DATE(?) AND DATE(?)
  `, [rango.desde, rango.hasta]);

  const anterior = await dbGet(`
    SELECT IFNULL(SUM(valor), 0) AS total, COUNT(*) AS movimientos
    FROM abonos
    WHERE DATE(fecha,'localtime') BETWEEN DATE(?) AND DATE(?)
  `, [rango.prev_desde, rango.prev_hasta]);

  const porDia = await dbAll(`
    SELECT DATE(fecha,'localtime') AS dia, IFNULL(SUM(valor), 0) AS total
    FROM abonos
    WHERE DATE(fecha,'localtime') BETWEEN DATE(?) AND DATE(?)
    GROUP BY DATE(fecha,'localtime')
    ORDER BY dia ASC
  `, [rango.desde, rango.hasta]);

  const topCursos = await dbAll(`
    SELECT c.nombre, IFNULL(SUM(a.valor), 0) AS total, COUNT(*) AS movimientos
    FROM abonos a
    LEFT JOIN cursos c ON c.id = a.curso_id
    WHERE DATE(a.fecha,'localtime') BETWEEN DATE(?) AND DATE(?)
    GROUP BY c.id, c.nombre
    ORDER BY total DESC
    LIMIT 5
  `, [rango.desde, rango.hasta]);

  const estudiantesConDeuda = await dbAll(`
    SELECT e.id, e.nombre, e.cedula, e.telefono,
           IFNULL(SUM(ec.saldo), 0) AS deuda,
           (SELECT MAX(fecha) FROM abonos WHERE estudiante_id = e.id) AS ultimo_abono,
           (
             SELECT COUNT(*)
             FROM estudiantes e2
             WHERE TRIM(IFNULL(e2.cedula, '')) <> ''
               AND TRIM(e2.cedula) = TRIM(e.cedula)
           ) AS registros_misma_cedula
    FROM estudiantes e
    JOIN estudiante_cursos ec ON ec.estudiante_id = e.id AND ec.saldo > 0
    GROUP BY e.id
    ORDER BY deuda DESC
    LIMIT 10
  `, []);

  const deuda = await dbGet(`
    SELECT IFNULL(SUM(saldo),0) AS total,
           COUNT(DISTINCT estudiante_id) AS estudiantes
    FROM estudiante_cursos
    WHERE saldo > 0
  `, []);

  const costos = await calcularCostoNomina(rango.desde, rango.hasta, rango.dias);
  const totalIngresos = Number(ingresos && ingresos.total) || 0;
  const totalAnterior = Number(anterior && anterior.total) || 0;
  const diferencia = totalIngresos - totalAnterior;
  const porcentaje = totalAnterior > 0 ? (diferencia / totalAnterior) * 100 : null;

  return {
    rango,
    ingresos: {
      total: totalIngresos,
      efectivo: Number(ingresos && ingresos.efectivo) || 0,
      nequi: Number(ingresos && ingresos.nequi) || 0,
      transferencia: Number(ingresos && ingresos.transferencia) || 0,
      movimientos: Number(ingresos && ingresos.movimientos) || 0
    },
    comparacion: {
      periodo_anterior_total: totalAnterior,
      periodo_anterior_movimientos: Number(anterior && anterior.movimientos) || 0,
      diferencia,
      porcentaje
    },
    costos_nomina: costos,
    utilidad_estimada: totalIngresos - costos.total,
    deuda: {
      total: Number(deuda && deuda.total) || 0,
      estudiantes: Number(deuda && deuda.estudiantes) || 0
    },
    por_dia: porDia,
    top_cursos: topCursos,
    estudiantes_con_deuda: estudiantesConDeuda,
    morosos: estudiantesConDeuda
  };
}

function crearAnalisisLocal(data) {
  const utilidad = data.utilidad_estimada;
  const cmp = data.comparacion;
  const tendencia = cmp.porcentaje === null
    ? 'No hay periodo anterior para comparar.'
    : `Frente al periodo anterior hay una variacion de ${cmp.porcentaje.toFixed(1)}%.`;
  const utilidadTxt = utilidad >= 0
    ? `El periodo muestra utilidad estimada positiva de ${utilidad.toLocaleString('es-CO')} COP.`
    : `El periodo esta en perdida estimada de ${Math.abs(utilidad).toLocaleString('es-CO')} COP segun nomina configurada.`;
  const deudaTxt = data.estudiantes_con_deuda.slice(0, 3).map(m => `${m.nombre}: ${Number(m.deuda).toLocaleString('es-CO')} COP`).join('; ') || 'Sin estudiantes con deuda destacados.';
  return `${utilidadTxt}\n${tendencia}\nDeuda total activa: ${data.deuda.total.toLocaleString('es-CO')} COP en ${data.deuda.estudiantes} estudiantes.\nPrioridad de cobro: ${deudaTxt}`;
}

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
app.get('/asignacion-codigos', (_, res) => res.sendFile(path.join(__dirname, 'public/asignacion-codigos.html')));
app.get('/validar', (_, res) => res.sendFile(path.join(__dirname, 'public/validar.html')));
app.get('/cierre-caja', (_, res) =>
  res.sendFile(path.join(__dirname, 'public/cierre-caja.html'))
);
app.get('/ficha-imprimir', (_, res) =>
  res.sendFile(path.join(__dirname, 'public/ficha-imprimir.html'))
);
app.get('/diplomas-generador', (_, res) =>
  res.sendFile(path.join(__dirname, 'public/diplomas-generador.html'))
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
  permitirRoles('gerente','secretaria','aliado'),
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

/* Dashboard auditoría (solo gerente): caja, últimos abonos, último cierre */
app.get('/api/dashboard/auditoria',
  verificarToken,
  permitirRoles('gerente'),
  (req, res) => {
    db.all(`
      SELECT metodo_pago, IFNULL(SUM(valor),0) AS total
      FROM abonos
      WHERE DATE(fecha,'localtime') = DATE('now','localtime')
      GROUP BY metodo_pago
    `, [], (_, rowsMetodo) => {
      const recaudo = { efectivo: 0, nequi: 0, transferencia: 0, total: 0 };
      (rowsMetodo || []).forEach(r => {
        const t = Number(r.total) || 0;
        if (r.metodo_pago === 'efectivo') recaudo.efectivo = t;
        else if (r.metodo_pago === 'nequi') recaudo.nequi = t;
        else recaudo.transferencia += t;
        recaudo.total += t;
      });

      db.get(`
        SELECT cc.id, cc.fecha, cc.efectivo_sistema, cc.nequi_sistema, cc.total_sistema,
               cc.efectivo_reportado, cc.nequi_reportado, cc.diferencia, u.usuario
        FROM cierres_caja cc
        LEFT JOIN usuarios u ON u.id = cc.usuario_id
        ORDER BY cc.fecha DESC LIMIT 1
      `, [], (_, ultimoCierre) => {
        db.all(`
          SELECT a.id, a.valor, a.fecha, a.metodo_pago, a.numero_factura, a.nota,
                 e.nombre AS estudiante, u.usuario AS registrado_por
          FROM abonos a
          LEFT JOIN estudiantes e ON e.id = a.estudiante_id
          LEFT JOIN usuarios u ON u.id = a.usuario_id
          ORDER BY a.fecha DESC LIMIT 15
        `, [], (_, ultimosAbonos) => {
          db.get(
            "SELECT COUNT(*) c FROM cierres_caja WHERE DATE(fecha,'localtime') = DATE('now','localtime')",
            [],
            (_, cierreHoy) => {
              res.json({
                recaudo_hoy: recaudo,
                ultimo_cierre: ultimoCierre || null,
                cierre_hecho_hoy: (cierreHoy && cierreHoy.c > 0),
                ultimos_abonos: ultimosAbonos || []
              });
            }
          );
        });
      });
    });
  });

app.get('/api/dashboard/finanzas',
  verificarToken,
  permitirRoles('gerente'),
  async (req, res) => {
    try {
      res.json(await resumenFinanciero(req.query));
    } catch (err) {
      console.error('Error en dashboard financiero:', err);
      res.status(500).json({ mensaje: 'Error calculando dashboard financiero' });
    }
  }
);

app.post('/api/dashboard/ia-auditoria',
  verificarToken,
  permitirRoles('gerente'),
  async (req, res) => {
    try {
      const data = await resumenFinanciero(req.body || {});
      const local = crearAnalisisLocal(data);
      const apiKey = process.env.GEMINI_API_KEY;
      const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

      if (!apiKey) {
        return res.json({
          modo: 'local',
          analisis: local,
          mensaje: 'Configura GEMINI_API_KEY en el servidor para activar Gemini AI.',
          data
        });
      }

      const prompt = `
Eres auditor financiero para CEFORSEG. Analiza estos datos y responde en espanol claro.
No inventes datos. Si hablas de utilidad, aclara que es estimada con los costos de nomina registrados.
No escribas introducciones largas. Entrega un informe ejecutivo breve, visual y accionable.
Formato:
**Resumen ejecutivo**
- 2 a 3 hallazgos clave.
**Comparacion**
- Explica si estuvo mejor o peor que el periodo anterior.
**Estudiantes con deuda**
- Menciona prioridades de cobro si existen.
**Acciones recomendadas**
- 3 acciones concretas.

Datos:
${JSON.stringify(data, null, 2)}
`;

      const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2 }
        })
      });

      const geminiJson = await geminiRes.json();
      if (!geminiRes.ok) {
        return res.status(502).json({
          modo: 'local',
          analisis: local,
          mensaje: geminiJson.error && geminiJson.error.message ? geminiJson.error.message : 'Gemini no respondio correctamente.',
          data
        });
      }

      const text = (((geminiJson.candidates || [])[0] || {}).content || {}).parts || [];
      res.json({
        modo: 'gemini',
        modelo: model,
        analisis: text.map(p => p.text || '').join('\n').trim() || local,
        data
      });
    } catch (err) {
      console.error('Error en auditoria IA:', err);
      res.status(500).json({ mensaje: 'Error generando auditoria IA' });
    }
  }
);


/* =====================================================
   ASIGNACION DE CODIGOS NRO / NCI
===================================================== */
app.get('/api/codigos/aliados',
  verificarToken,
  permitirRoles('gerente'),
  (_, res) => {
    db.all(
      "SELECT id, usuario, rol FROM usuarios WHERE rol='aliado' ORDER BY usuario ASC",
      [],
      (err, rows) => {
        if (err) return res.status(500).json({ mensaje: 'Error cargando aliados' });
        res.json(rows || []);
      }
    );
  }
);

app.get('/api/codigos',
  verificarToken,
  permitirRoles('gerente','aliado'),
  (req, res) => {
    const params = [];
    let where = '';

    if (req.usuario.rol === 'aliado') {
      where = 'WHERE ca.aliado_id = ?';
      params.push(req.usuario.id);
    }

    db.all(`
      SELECT
        ca.id,
        ca.nro,
        ca.nci,
        ca.aliado_id,
        u.usuario AS aliado,
        ca.estado,
        ca.alumno_nombre,
        ca.alumno_cedula,
        ca.curso,
        ca.fecha_expedicion,
        ca.creado_en,
        ca.usado_en,
        ca.certificado_id
      FROM codigos_asignados ca
      LEFT JOIN usuarios u ON u.id = ca.aliado_id
      ${where}
      ORDER BY ca.id DESC
      LIMIT 300
    `, params, (err, rows) => {
      if (err) return res.status(500).json({ mensaje: 'Error cargando codigos' });
      res.json(rows || []);
    });
  }
);

app.post('/api/codigos',
  verificarToken,
  permitirRoles('gerente'),
  (req, res) => {
    const nro = (req.body.nro || '').toString().trim();
    const nci = (req.body.nci || '').toString().trim();
    const aliadoId = parseInt(req.body.aliado_id, 10);

    if (!nro || !nci || !aliadoId) {
      return res.status(400).json({ mensaje: 'Aliado, NRO y NCI son obligatorios' });
    }

    db.get("SELECT id FROM usuarios WHERE id=? AND rol='aliado'", [aliadoId], (err, aliado) => {
      if (err) return res.status(500).json({ mensaje: 'Error validando aliado' });
      if (!aliado) return res.status(400).json({ mensaje: 'Selecciona un usuario con rol aliado' });

      db.run(`
        INSERT INTO codigos_asignados (nro, nci, aliado_id, asignado_por_id)
        VALUES (?,?,?,?)
      `, [nro, nci, aliadoId, req.usuario.id], function(insertErr) {
        if (insertErr) {
          return res.status(400).json({ mensaje: 'Ese NRO o NCI ya existe' });
        }
        registrarAuditoria(req, 'asignar_codigo', 'codigos_asignados', this.lastID, { nro, nci, aliado_id: aliadoId });
        res.json({ mensaje: 'Codigo asignado correctamente', id: this.lastID });
      });
    });
  }
);

app.put('/api/codigos/:id/usar',
  verificarToken,
  permitirRoles('gerente','aliado'),
  (req, res) => {
    const id = parseInt(req.params.id, 10);
    const alumnoNombre = (req.body.alumno_nombre || '').toString().trim();
    const alumnoCedula = (req.body.alumno_cedula || '').toString().trim();
    const curso = (req.body.curso || '').toString().trim();
    const fechaExpedicion = (req.body.fecha_expedicion || '').toString().trim();

    if (!alumnoNombre || !alumnoCedula || !curso || !fechaExpedicion) {
      return res.status(400).json({ mensaje: 'Nombre, cedula, curso y fecha de expedicion son obligatorios' });
    }

    const params = req.usuario.rol === 'aliado' ? [id, req.usuario.id] : [id];
    const scope = req.usuario.rol === 'aliado' ? 'AND aliado_id=?' : '';

    db.get(`SELECT * FROM codigos_asignados WHERE id=? ${scope}`, params, (err, codigo) => {
      if (err) return res.status(500).json({ mensaje: 'Error buscando codigo' });
      if (!codigo) return res.status(404).json({ mensaje: 'Codigo no encontrado' });
      if (codigo.estado !== 'disponible') {
        return res.status(400).json({ mensaje: 'Este codigo ya fue usado' });
      }

      db.serialize(() => {
        db.run(`
          INSERT INTO certificados
            (estudiante_id, cedula, nombre, curso, fecha_diploma, tipo, archivo_pdf, fecha_subida, curso_id, fecha_emision, nro, nci, codigo_asignado_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        `, [
          null,
          alumnoCedula,
          alumnoNombre,
          curso,
          fechaExpedicion,
          'codigo',
          null,
          new Date().toISOString(),
          null,
          fechaExpedicion,
          codigo.nro,
          codigo.nci,
          id
        ], function(certErr) {
          if (certErr) return res.status(500).json({ mensaje: 'Error creando certificado del codigo' });

          const certificadoId = this.lastID;
          db.run(`
            UPDATE codigos_asignados
            SET estado='usado',
                alumno_nombre=?,
                alumno_cedula=?,
                curso=?,
                fecha_expedicion=?,
                certificado_id=?,
                usado_en=datetime('now','localtime')
            WHERE id=? AND estado='disponible'
          `, [alumnoNombre, alumnoCedula, curso, fechaExpedicion, certificadoId, id], function(updateErr) {
            if (updateErr) return res.status(500).json({ mensaje: 'Error usando codigo' });
            if (this.changes === 0) return res.status(400).json({ mensaje: 'Este codigo ya fue usado' });
            registrarAuditoria(req, 'usar_codigo', 'codigos_asignados', id, {
              nro: codigo.nro,
              nci: codigo.nci,
              alumno_cedula: alumnoCedula,
              certificado_id: certificadoId
            });
            res.json({ mensaje: 'Codigo usado y certificado registrado', certificado_id: certificadoId });
          });
        });
      });
    });
  }
);

app.delete('/api/codigos/:id',
  verificarToken,
  permitirRoles('gerente'),
  (req, res) => {
    const id = parseInt(req.params.id, 10);
    db.get('SELECT estado FROM codigos_asignados WHERE id=?', [id], (err, row) => {
      if (err) return res.status(500).json({ mensaje: 'Error buscando codigo' });
      if (!row) return res.status(404).json({ mensaje: 'Codigo no encontrado' });
      if (row.estado !== 'disponible') return res.status(400).json({ mensaje: 'No se puede eliminar un codigo usado' });

      db.run('DELETE FROM codigos_asignados WHERE id=?', [id], function(delErr) {
        if (delErr) return res.status(500).json({ mensaje: 'Error eliminando codigo' });
        registrarAuditoria(req, 'eliminar_codigo', 'codigos_asignados', id, {});
        res.json({ mensaje: 'Codigo eliminado' });
      });
    });
  }
);


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

app.get('/api/cursos/:id',
  verificarToken,
  permitirRoles('gerente'),
  (req, res) => {
    db.get(
      'SELECT id, nombre, descripcion, precio FROM cursos WHERE id=? AND activo=1',
      [req.params.id],
      (_, row) => {
        if (!row) return res.status(404).json({ mensaje: 'Curso no encontrado' });
        res.json(row);
      }
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

app.put('/api/cursos/:id',
  verificarToken,
  permitirRoles('gerente'),
  (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { nombre, descripcion, precio } = req.body;
    if (!nombre || precio === undefined) return res.status(400).json({ mensaje: 'Nombre y precio son obligatorios' });
    db.run(
      'UPDATE cursos SET nombre=?, descripcion=?, precio=? WHERE id=?',
      [nombre, descripcion || null, precio, id],
      function(err) {
        if (err) return res.status(500).json({ mensaje: 'Error al actualizar' });
        if (this.changes === 0) return res.status(404).json({ mensaje: 'Curso no encontrado' });
        res.json({ mensaje: 'Curso actualizado' });
      }
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
        registrarAuditoria(req, 'crear_usuario', 'usuarios', null, { usuario, rol });
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
            registrarAuditoria(req, 'eliminar_usuario', 'usuarios', req.params.id, { usuario_eliminado_id: req.params.id });
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
          registrarAuditoria(req, 'editar_usuario', 'usuarios', id, { usuario, rol });
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
   PLANTILLAS DIPLOMAS (SUBIDA PDF)
===================================================== */
const DIPLOMA_TPL_DIR = path.join(__dirname, 'public/uploads/diplomas/plantillas');
fs.mkdirSync(DIPLOMA_TPL_DIR, { recursive: true });

const uploadDiplomaTemplate = multer({
  storage: multer.diskStorage({
    destination: DIPLOMA_TPL_DIR,
    filename: (_, file, cb) => cb(null, Date.now() + '_' + file.originalname)
  })
});

const DIPLOMA_FOTO_DIR = path.join(__dirname, 'public/uploads/diplomas/fotos');
fs.mkdirSync(DIPLOMA_FOTO_DIR, { recursive: true });

const uploadDiplomaPhoto = multer({
  storage: multer.diskStorage({
    destination: DIPLOMA_FOTO_DIR,
    filename: (_, file, cb) => cb(null, Date.now() + '_' + file.originalname)
  })
});

app.post('/api/diplomas/plantillas',
  verificarToken,
  permitirRoles('gerente'),
  uploadDiplomaTemplate.single('pdf'),
  (req, res) => {
    if(!req.file){
      return res.status(400).json({ mensaje:'Debe adjuntar un PDF de plantilla' });
    }
    const url = `/uploads/diplomas/plantillas/${req.file.filename}`;
    res.json({ url });
  }
);

app.post('/api/diplomas/fotos',
  verificarToken,
  permitirRoles('gerente'),
  uploadDiplomaPhoto.single('foto'),
  (req, res) => {
    if(!req.file){
      return res.status(400).json({ mensaje:'Debe adjuntar una foto' });
    }
    const url = `/uploads/diplomas/fotos/${req.file.filename}`;
    res.json({ url });
  }
);

/* =====================================================
   DEUDORES / MOROSOS (auditoría para cobros masivos)
===================================================== */
app.get('/api/estudiantes/deudores',
  verificarToken,
  permitirRoles('gerente','secretaria'),
  (req, res) => {
    const morosoDesde = (req.query.moroso_desde || '').trim().slice(0, 10);

    db.all(`
      SELECT 
        e.id,
        e.nombre,
        e.cedula,
        e.telefono,
        e.email,
        SUM(ec.saldo) AS total_deuda,
        (SELECT MAX(fecha) FROM abonos WHERE estudiante_id = e.id) AS ultimo_abono,
        GROUP_CONCAT(c.nombre || ' $' || ec.saldo, ' · ') AS detalle_cursos
      FROM estudiantes e
      JOIN estudiante_cursos ec ON ec.estudiante_id = e.id AND ec.saldo > 0
      LEFT JOIN cursos c ON c.id = ec.curso_id
      GROUP BY e.id
      ORDER BY ultimo_abono ASC, e.nombre
    `, [], (_, rows) => {
      let list = rows || [];
      if (morosoDesde) {
        const corte = morosoDesde + 'T23:59:59.999Z';
        list = list.filter(r => {
          const u = r.ultimo_abono;
          return !u || u < corte;
        });
      }
      res.json(list);
    });
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
      (nombre, cedula, telefono, ciudad, direccion, foto, email, contacto_emergencia, fecha_matricula, usuario_matricula_id)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `,
    [nombre, cedula, telefono, ciudad, direccion, foto, email || null, contacto_emergencia || null, fechaMat, req.usuario?.id || null],
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

      res.json({ mensaje:'Estudiante creado', id: estudianteId });
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
   ELIMINAR CURSO A ESTUDIANTE
===================================================== */
app.delete('/api/estudiantes/:id/curso/:curso_id',
  verificarToken,
  permitirRoles('gerente'),
  (req, res) => {

    const estudianteId = req.params.id;
    const cursoId = req.params.curso_id;

    db.get(
      'SELECT saldo FROM estudiante_cursos WHERE estudiante_id=? AND curso_id=?',
      [estudianteId, cursoId],
      (_, row) => {
        if (!row) return res.status(404).json({ mensaje: 'Curso del estudiante no encontrado' });

        db.serialize(() => {
          // Si se elimina el curso de la ficha, eliminamos también los abonos asociados a ese curso
          // para no dejar registros huérfanos.
          db.run(
            'DELETE FROM abonos WHERE estudiante_id=? AND curso_id=?',
            [estudianteId, cursoId],
            function () {
              db.run(
                'DELETE FROM estudiante_cursos WHERE estudiante_id=? AND curso_id=?',
                [estudianteId, cursoId],
                function (err2) {
                  if (err2) return res.status(500).json({ mensaje: 'Error al eliminar curso del estudiante' });

                  registrarAuditoria(req, 'eliminar_curso_estudiante', 'estudiante_cursos', null, {
                    estudiante_id: estudianteId,
                    curso_id: cursoId,
                    saldo_anterior: row.saldo
                  });
                  res.json({ mensaje: 'Curso eliminado del estudiante' });
                }
              );
            }
          );
        });
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

function normalizarFechaAbono(fechaInput) {
  if (fechaInput === undefined || fechaInput === null || String(fechaInput).trim() === '') {
    return new Date().toISOString();
  }
  const s = String(fechaInput).trim();
  // input type="date" → YYYY-MM-DD
  const d = s.length === 10 && /^\d{4}-\d{2}-\d{2}$/.test(s)
    ? new Date(s + 'T12:00:00')
    : new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

app.post('/api/abonos',
  verificarToken,
  permitirRoles('gerente','secretaria'),
  (req, res) => {

    const { estudiante_id, curso_id, valor, nota, metodo_pago, numero_factura, fecha } = req.body;

    const numeroFactura = (numero_factura || '').toString().trim();
    if (!numeroFactura) return res.status(400).json({ mensaje: 'El número de factura es obligatorio' });

    const metodo = metodo_pago || 'efectivo';

    const fechaIso = normalizarFechaAbono(fecha);
    if (!fechaIso) return res.status(400).json({ mensaje: 'Fecha del abono inválida' });

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
          fechaIso,
          req.usuario.id,
          nota || null,
          req.usuario.rol,
          metodo,
          numeroFactura
        ]);

        db.run(
          'UPDATE estudiante_cursos SET saldo=? WHERE estudiante_id=? AND curso_id=?',
          [nuevoSaldo, estudiante_id, curso_id],
          () => {
            registrarAuditoria(req, 'crear_abono', 'abonos', null, { estudiante_id, curso_id, valor, metodo, numero_factura: numeroFactura, fecha: fechaIso });
            res.json({ mensaje:'Abono registrado' });
          }
        );
      }
    );
  });

/* EDITAR ABONO (SOLO GERENTE) - blindaje: secretaria no puede modificar montos */
app.put('/api/abonos/:id',
  verificarToken,
  permitirRoles('gerente'),
  (req, res) => {
    const { valor, nota, metodo_pago, numero_factura, fecha } = req.body;
    const idAbono = req.params.id;

    const numeroFactura = (numero_factura || '').toString().trim();
    if (!numeroFactura) return res.status(400).json({ mensaje: 'El número de factura es obligatorio al editar.' });

    db.get('SELECT estudiante_id, curso_id, valor AS valor_anterior, fecha AS fecha_anterior FROM abonos WHERE id=?', [idAbono], (err, abono) => {
      if (err || !abono) return res.status(404).json({ mensaje: 'Abono no encontrado' });

      const valorNuevo = valor !== undefined ? Number(valor) : abono.valor_anterior;
      const diferencia = valorNuevo - Number(abono.valor_anterior);

      let fechaNueva = abono.fecha_anterior;
      if (fecha !== undefined && fecha !== null && String(fecha).trim() !== '') {
        const parsed = normalizarFechaAbono(fecha);
        if (!parsed) return res.status(400).json({ mensaje: 'Fecha del abono inválida' });
        fechaNueva = parsed;
      }

      db.run(`
        UPDATE abonos SET valor=?, nota=?, metodo_pago=?, numero_factura=?, fecha=?
        WHERE id=?
      `, [valorNuevo, nota || null, metodo_pago || 'efectivo', numeroFactura, fechaNueva, idAbono], function () {
        if (this.changes === 0) return res.status(404).json({ mensaje: 'Abono no encontrado' });

        db.run(
          'UPDATE estudiante_cursos SET saldo = saldo - ? WHERE estudiante_id=? AND curso_id=?',
          [diferencia, abono.estudiante_id, abono.curso_id],
          () => {
            registrarAuditoria(req, 'editar_abono', 'abonos', idAbono, {
              valor_anterior: abono.valor_anterior,
              valor_nuevo: valorNuevo,
              fecha_anterior: abono.fecha_anterior,
              fecha_nueva: fechaNueva
            });
            res.json({ mensaje: 'Abono actualizado' });
          }
        );
      });
    });
  });

/* ELIMINAR ABONO (SOLO GERENTE) - blindaje: secretaria no puede borrar abonos */
app.delete('/api/abonos/:id',
  verificarToken,
  permitirRoles('gerente'),
  (req, res) => {
    db.get('SELECT estudiante_id, curso_id, valor FROM abonos WHERE id=?', [req.params.id], (err, abono) => {
      if (err || !abono) return res.status(404).json({ mensaje: 'Abono no encontrado' });

      db.run('DELETE FROM abonos WHERE id=?', [req.params.id], function () {
        if (this.changes === 0) return res.status(404).json({ mensaje: 'Abono no encontrado' });

        db.run(
          'UPDATE estudiante_cursos SET saldo = saldo + ? WHERE estudiante_id=? AND curso_id=?',
          [abono.valor, abono.estudiante_id, abono.curso_id],
          () => {
            registrarAuditoria(req, 'eliminar_abono', 'abonos', req.params.id, { valor: abono.valor, estudiante_id: abono.estudiante_id, curso_id: abono.curso_id });
            res.json({ mensaje: 'Abono eliminado' });
          }
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
   AUDITORÍA (SOLO GERENTE - blindaje)
===================================================== */
app.get('/api/auditoria',
  verificarToken,
  permitirRoles('gerente'),
  (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
    db.all(
      `SELECT id, usuario_nombre, rol, accion, tabla_afectada, registro_id, detalles, creado_en
       FROM auditoria ORDER BY id DESC LIMIT ?`,
      [limit],
      (_, rows) => res.json(rows || [])
    );
  });

/* =====================================================
   EDITAR / ELIMINAR AUDITORÍA (SOLO GERENTE)
   Nota: para "editar" se permite ajustar solo "detalles".
===================================================== */
app.put('/api/auditoria/:id',
  verificarToken,
  permitirRoles('gerente'),
  (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { detalles } = req.body;
    const nuevoDetalles = (detalles === undefined || detalles === null) ? '' : String(detalles);

    db.run(
      'UPDATE auditoria SET detalles=? WHERE id=?',
      [nuevoDetalles, id],
      function() {
        if (this.changes === 0) return res.status(404).json({ mensaje: 'Registro no encontrado' });
        res.json({ mensaje: 'Auditoría actualizada' });
      }
    );
  }
);

app.delete('/api/auditoria/:id',
  verificarToken,
  permitirRoles('gerente'),
  (req, res) => {
    const id = parseInt(req.params.id, 10);
    db.run(
      'DELETE FROM auditoria WHERE id=?',
      [id],
      function() {
        if (this.changes === 0) return res.status(404).json({ mensaje: 'Registro no encontrado' });
        res.json({ mensaje: 'Auditoría eliminada' });
      }
    );
  }
);

/* =====================================================
   NÓMINA / COMISIONES (SOLO GERENTE)
===================================================== */
app.get('/api/nomina/config',
  verificarToken,
  permitirRoles('gerente'),
  (req, res) => {
    db.get('SELECT valor FROM config WHERE clave=?', ['comision_por_matricula'], (_, row) => {
      res.json({ comision_por_matricula: row ? parseInt(row.valor, 10) || 0 : 0 });
    });
  });

app.put('/api/nomina/config',
  verificarToken,
  permitirRoles('gerente'),
  (req, res) => {
    const v = Math.max(0, parseInt(req.body.comision_por_matricula, 10) || 0);
    db.run(
      'INSERT INTO config (clave, valor) VALUES (?,?) ON CONFLICT(clave) DO UPDATE SET valor=?',
      ['comision_por_matricula', String(v), String(v)],
      function() { res.json({ comision_por_matricula: v }); }
    );
  });

app.get('/api/nomina/comisiones-curso',
  verificarToken,
  permitirRoles('gerente'),
  (req, res) => {
    db.all(`
      SELECT c.id AS curso_id, c.nombre, IFNULL(cc.valor_comision, 0) AS valor_comision
      FROM cursos c
      LEFT JOIN comisiones_curso cc ON cc.curso_id = c.id
      WHERE c.activo = 1
      ORDER BY c.nombre
    `, [], (_, rows) => res.json(rows || []));
  });

app.put('/api/nomina/comisiones-curso/:curso_id',
  verificarToken,
  permitirRoles('gerente'),
  (req, res) => {
    const curso_id = parseInt(req.params.curso_id, 10);
    const valor_comision = Math.max(0, parseInt(req.body.valor_comision, 10) || 0);
    db.run(
      'INSERT INTO comisiones_curso (curso_id, valor_comision) VALUES (?,?) ON CONFLICT(curso_id) DO UPDATE SET valor_comision=?',
      [curso_id, valor_comision, valor_comision],
      function() { res.json({ curso_id, valor_comision }); }
    );
  });

app.get('/api/nomina/reporte',
  verificarToken,
  permitirRoles('gerente'),
  (req, res) => {
    const usuario_id = req.query.usuario_id;
    const desde = (req.query.desde || '').trim().slice(0, 10);
    const hasta = (req.query.hasta || '').trim().slice(0, 10);
    if (!usuario_id) return res.status(400).json({ mensaje: 'Falta usuario_id' });

    db.get('SELECT valor FROM config WHERE clave=?', ['comision_por_matricula'], (_, configRow) => {
      const comisionPorMatricula = configRow ? parseInt(configRow.valor, 10) || 0 : 0;

      const filtroFecha = (desde && hasta)
        ? " AND DATE(e.fecha_matricula) BETWEEN DATE(?) AND DATE(?)"
        : (desde ? " AND DATE(e.fecha_matricula) >= DATE(?)" : "") + (hasta ? " AND DATE(e.fecha_matricula) <= DATE(?)" : "");
      const paramsFecha = [desde, hasta].filter(Boolean);

      db.all(
        `SELECT e.id, e.nombre, e.fecha_matricula
         FROM estudiantes e
         WHERE e.usuario_matricula_id = ? ${filtroFecha}
         ORDER BY e.fecha_matricula DESC`,
        [usuario_id, ...paramsFecha],
        (_, matriculas) => {
          const countMatriculas = (matriculas || []).length;
          const totalComisionMatricula = countMatriculas * comisionPorMatricula;

          db.all(
            `SELECT c.id AS curso_id, c.nombre, ec.estudiante_id, e.fecha_matricula,
                    (SELECT IFNULL(cc.valor_comision, 0) FROM comisiones_curso cc WHERE cc.curso_id = c.id) AS valor_comision
             FROM estudiante_cursos ec
             JOIN estudiantes e ON e.id = ec.estudiante_id
             JOIN cursos c ON c.id = ec.curso_id
             WHERE e.usuario_matricula_id = ? ${filtroFecha}`,
            [usuario_id, ...paramsFecha],
            (err, rows) => {
              if (err) return res.status(500).json({ mensaje: 'Error calculando cursos' });
              const cursos = (rows || []).map(r => ({
                curso_id: r.curso_id,
                nombre: r.nombre,
                estudiante_id: r.estudiante_id,
                valor_comision: r.valor_comision || 0
              }));
              const totalComisionCursos = cursos.reduce((s, x) => s + (x.valor_comision || 0), 0);
              const totalComisiones = totalComisionMatricula + totalComisionCursos;

              db.get('SELECT valor_basico, tipo_basico FROM nomina_basico WHERE usuario_id=?', [usuario_id], (_, basicoRow) => {
                let basico_periodo = 0;
                const valor_basico = basicoRow ? (parseInt(basicoRow.valor_basico, 10) || 0) : 0;
                const tipo_basico = basicoRow && basicoRow.tipo_basico === 'quincenal' ? 'quincenal' : 'mensual';

                if (valor_basico > 0 && desde && hasta) {
                  const d1 = new Date(desde + 'T12:00:00');
                  const d2 = new Date(hasta + 'T12:00:00');
                  const diasPeriodo = Math.max(1, Math.ceil((d2 - d1) / (24 * 60 * 60 * 1000)) + 1);
                  if (tipo_basico === 'quincenal') {
                    basico_periodo = Math.round(valor_basico * (diasPeriodo / 15));
                  } else {
                    basico_periodo = Math.round(valor_basico * (diasPeriodo / 30));
                  }
                }

                res.json({
                  usuario_id: parseInt(usuario_id, 10),
                  desde,
                  hasta,
                  basico_config: { valor_basico, tipo_basico },
                  basico_periodo,
                  comision_por_matricula: comisionPorMatricula,
                  matriculas: matriculas || [],
                  count_matriculas: countMatriculas,
                  total_comision_matricula: totalComisionMatricula,
                  cursos,
                  total_comision_cursos: totalComisionCursos,
                  total_comisiones: totalComisiones,
                  total: basico_periodo + totalComisiones
                });
              });
            }
          );
        }
      );
    });
  });

app.get('/api/nomina/usuarios-secretaria',
  verificarToken,
  permitirRoles('gerente'),
  (req, res) => {
    db.all('SELECT id, usuario, rol FROM usuarios WHERE rol = ? ORDER BY usuario', ['secretaria'], (_, rows) => res.json(rows || []));
  });

app.get('/api/nomina/basico',
  verificarToken,
  permitirRoles('gerente'),
  (req, res) => {
    db.all(`
      SELECT u.id AS usuario_id, u.usuario,
             IFNULL(nb.valor_basico, 0) AS valor_basico,
             IFNULL(nb.tipo_basico, 'mensual') AS tipo_basico
      FROM usuarios u
      LEFT JOIN nomina_basico nb ON nb.usuario_id = u.id
      WHERE u.rol = 'secretaria'
      ORDER BY u.usuario
    `, [], (_, rows) => res.json(rows || []));
  });

app.put('/api/nomina/basico/:usuario_id',
  verificarToken,
  permitirRoles('gerente'),
  (req, res) => {
    const usuario_id = parseInt(req.params.usuario_id, 10);
    const valor_basico = Math.max(0, parseInt(req.body.valor_basico, 10) || 0);
    const tipo_basico = (req.body.tipo_basico === 'quincenal') ? 'quincenal' : 'mensual';
    db.run(
      `INSERT INTO nomina_basico (usuario_id, valor_basico, tipo_basico)
       VALUES (?,?,?) ON CONFLICT(usuario_id) DO UPDATE SET valor_basico=excluded.valor_basico, tipo_basico=excluded.tipo_basico`,
      [usuario_id, valor_basico, tipo_basico],
      function() { res.json({ usuario_id, valor_basico, tipo_basico }); }
    );
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
        registrarAuditoria(req, 'eliminar_cierre_caja', 'cierres_caja', req.params.id, {});
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
            registrarAuditoria(req, 'editar_cierre_caja', 'cierres_caja', req.params.id, { efectivo_reportado, nequi_reportado, diferencia });
            res.json({ mensaje:'Cierre actualizado correctamente' });
          }
        );
      }
    );
});


app.get('/cierres-caja-panel', (_, res) =>
  res.sendFile(path.join(__dirname, 'public/cierres-caja.html'))
);

app.get('/auditoria-panel', (_, res) =>
  res.sendFile(path.join(__dirname, 'public/auditoria.html'))
);

app.get('/nomina-panel', (_, res) =>
  res.sendFile(path.join(__dirname, 'public/nomina.html'))
);

app.get('/deudores-panel', (_, res) =>
  res.sendFile(path.join(__dirname, 'public/deudores.html'))
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
        ], function() {
          registrarAuditoria(req, 'crear_cierre_caja', 'cierres_caja', this.lastID, { total_sistema: totalSistema, efectivo_reportado, nequi_reportado, diferencia });
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
   SUBIR CERTIFICADOS (PDF) – solo para validador, sin estudiantes
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

    const rutaPdf = req.file ? `/uploads/certificados/${req.file.filename}` : null;
    const fechaEmision = (fecha_diploma || '').trim() || new Date().toISOString().slice(0,10);

    db.run(
      `INSERT INTO certificados
       (estudiante_id, cedula, nombre, curso, fecha_diploma, tipo, archivo_pdf, fecha_subida, curso_id, fecha_emision)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        null,
        cedula.trim(),
        (nombre || cedula).toString().trim(),
        curso.toString().trim(),
        fechaEmision,
        'nuevo',
        rutaPdf,
        new Date().toISOString(),
        null,
        fechaEmision
      ],
      function(err) {
        if (err) {
          console.error('Error insertando certificado:', err.message);
          return res.status(500).json({ mensaje: 'Error guardando certificado' });
        }
        res.json({ mensaje: 'Certificado subido correctamente. Solo visible en Validador.' });
      }
    );
  });

/* =====================================================
   CERTIFICADOS (GESTION) – panel admin/secretaria
===================================================== */
app.get('/api/certificados/buscar',
  verificarToken,
  permitirRoles('gerente','secretaria'),
  (req, res) => {
    const q = (req.query.q || '').trim();
    const params = [];

    let sql = `
      SELECT
        id,
        cedula,
        nombre,
        curso,
        fecha_diploma,
        archivo_pdf,
        fecha_subida
      FROM certificados
    `;

    if(q){
      sql += `
        WHERE cedula LIKE ?
           OR nombre LIKE ?
           OR curso LIKE ?
      `;
      const like = '%' + q + '%';
      params.push(like, like, like);
    }

    sql += `
      ORDER BY fecha_subida DESC
      LIMIT 100
    `;

    db.all(sql, params, (_, rows) => {
      res.json(rows || []);
    });
  }
);

app.put('/api/certificados/:id',
  verificarToken,
  permitirRoles('gerente','secretaria'),
  uploadCert.single('pdf'),
  (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { cedula, nombre, curso, fecha_diploma } = req.body;

    if(!cedula || !curso){
      return res.status(400).json({ mensaje:'Cédula y curso son obligatorios' });
    }

    const fechaEmision = (fecha_diploma || '').trim() || new Date().toISOString().slice(0,10);

    db.get('SELECT archivo_pdf FROM certificados WHERE id=?', [id], (err, row) => {
      if(err) return res.status(500).json({ mensaje:'Error buscando certificado' });
      if(!row) return res.status(404).json({ mensaje:'Certificado no encontrado' });

      const nuevoPdf = req.file ? `/uploads/certificados/${req.file.filename}` : row.archivo_pdf;

      db.run(`
        UPDATE certificados
        SET cedula=?,
            nombre=?,
            curso=?,
            fecha_diploma=?,
            archivo_pdf=?,
            fecha_emision=?
        WHERE id=?
      `, [cedula.trim(), (nombre || cedula).toString().trim(), curso.toString().trim(), fechaEmision, nuevoPdf, fechaEmision, id],
      function(updateErr){
        if(updateErr) return res.status(500).json({ mensaje:'Error actualizando certificado' });
        if(this.changes === 0) return res.status(404).json({ mensaje:'Certificado no encontrado' });
        res.json({ mensaje:'Certificado actualizado' });
      });
    });
  }
);

app.delete('/api/certificados/:id',
  verificarToken,
  permitirRoles('gerente','secretaria'),
  (req, res) => {
    const id = parseInt(req.params.id, 10);

    db.get('SELECT archivo_pdf FROM certificados WHERE id=?', [id], (err, row) => {
      if(err) return res.status(500).json({ mensaje:'Error buscando certificado' });
      if(!row) return res.status(404).json({ mensaje:'Certificado no encontrado' });

      db.run('DELETE FROM certificados WHERE id=?', [id], function(delErr){
        if(delErr) return res.status(500).json({ mensaje:'Error eliminando certificado' });
        if(this.changes === 0) return res.status(404).json({ mensaje:'Certificado no encontrado' });

        try{
          if(row.archivo_pdf){
            const fileName = path.basename(row.archivo_pdf);
            const filePath = path.join(CERT_DIR, fileName);
            if(fs.existsSync(filePath)) fs.unlinkSync(filePath);
          }
        }catch(_e){}

        res.json({ mensaje:'Certificado eliminado' });
      });
    });
  }
);


/* =====================================================
   VALIDAR CERTIFICADOS
===================================================== */
app.get('/api/validar/:consulta', (req, res) => {
  const consulta = (req.params.consulta || '').trim();
  db.all(`
    SELECT 
      cert.cedula,
      cert.nombre,
      cert.curso,
      cert.archivo_pdf,
      cert.fecha_emision AS fecha_diploma,
      cert.nro,
      cert.nci
    FROM certificados cert
    WHERE TRIM(cert.cedula) = ?
       OR TRIM(IFNULL(cert.nro, '')) = ?
       OR TRIM(IFNULL(cert.nci, '')) = ?
    ORDER BY cert.fecha_emision DESC
  `,
  [consulta, consulta, consulta],
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
