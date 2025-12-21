const jwt = require('jsonwebtoken');
const JWT_SECRET = 'ceforseg_super_secreto';

function verificarToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ mensaje: 'Token requerido' });
  }

  try {
    const token = authHeader.split(' ')[1];
    req.usuario = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ mensaje: 'Token inválido' });
  }
}

function permitirRoles(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.usuario.rol)) {
      return res.status(403).json({ mensaje: 'No autorizado' });
    }
    next();
  };
}

module.exports = { verificarToken, permitirRoles };
