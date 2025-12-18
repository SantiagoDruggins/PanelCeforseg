const jwt = require('jsonwebtoken');

const JWT_SECRET = 'ceforseg_super_secreto';

function verificarToken(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({ mensaje: 'Token requerido' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.usuario = decoded; // { id, rol }
    next();
  } catch (err) {
    return res.status(401).json({ mensaje: 'Token inválido' });
  }
}

function soloGerente(req, res, next) {
  if (req.usuario.rol !== 'gerente') {
    return res.status(403).json({ mensaje: 'Acceso solo para gerente' });
  }
  next();
}

module.exports = {
  verificarToken,
  soloGerente
};
