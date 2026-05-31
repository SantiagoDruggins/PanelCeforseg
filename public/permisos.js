const RUTAS_ALIADO = ['/dashboard', '/asignacion-codigos', '/validar', '/login'];

function rolActual() {
  return localStorage.getItem('rol') || '';
}

function aplicarPermisosPanel() {
  const rol = rolActual();

  if (rol !== 'gerente') {
    ['menuUsuarios', 'menuAuditoria', 'menuNomina'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });
  }

  if (rol === 'aliado') {
    document.querySelectorAll('.sidebar a').forEach(a => {
      const href = a.getAttribute('href');
      if (!RUTAS_ALIADO.includes(href)) {
        a.style.display = 'none';
      }
    });

    const sidebar = document.querySelector('.sidebar');
    if (sidebar && !document.getElementById('aliadoSoftwareHint')) {
      const hint = document.createElement('div');
      hint.id = 'aliadoSoftwareHint';
      hint.style.cssText = 'margin:10px 0 14px;padding:12px;border:1px solid rgba(255,255,255,.18);border-radius:12px;background:rgba(255,255,255,.08);font-size:12px;line-height:1.35;color:#fff;';
      hint.innerHTML = '<strong>Modulos privados</strong><br>Tu acceso esta limitado a codigos. Si necesitas un sistema propio, solicitalo a CEFORSEG.';
      const logout = document.getElementById('btnLogout');
      if (logout) sidebar.insertBefore(hint, logout);
    }
  }
}

function bloquearModuloAliado(nombreModulo) {
  if (rolActual() !== 'aliado') return false;
  document.body.innerHTML = `
    <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f4f6f9;font-family:system-ui,-apple-system,BlinkMacSystemFont,sans-serif;padding:24px;">
      <div style="max-width:560px;background:#fff;border:1px solid #dbe4ef;border-radius:10px;padding:28px;box-shadow:0 14px 34px rgba(10,59,120,.12);">
        <h2 style="margin:0 0 10px;color:#0a3b78;">No tienes acceso a ${nombreModulo || 'este modulo'}</h2>
        <p style="margin:0 0 18px;color:#475569;line-height:1.5;">Esta seccion es privada de CEFORSEG. Tu usuario aliado solo puede gestionar los codigos NRO/NCI asignados y validar certificados.</p>
        <p style="margin:0 0 22px;color:#172033;line-height:1.5;font-weight:600;">Si necesitas estudiantes, cursos, caja, certificados o nomina, podemos cotizarte un software propio para tu operacion.</p>
        <a href="/asignacion-codigos" style="display:inline-block;background:#0a3b78;color:#fff;text-decoration:none;border-radius:8px;padding:11px 16px;font-weight:700;">Ir a mis codigos</a>
      </div>
    </div>
  `;
  return true;
}
