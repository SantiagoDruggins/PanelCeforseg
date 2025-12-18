const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db/database');

// ⚠️ Más adelante este secreto irá en variables de entorno
const JWT_SECRET = 'ceforseg_super_secreto';

// Crear usuario (solo para gerente inicial)
function crearUsuario(usuario, password, rol) {
  const hash = bcrypt.hashSync(password, 10);

  db.run(
    'INSERT INTO usuarios (usuario, password, rol) VALUES (?, ?, ?)',
    [usuario, hash, rol],
    function (err) {
      if (err) {
        console.log('Error creando usuario:', err.message);
      } else {
        console.log('Usuario creado con ID:', this.lastID);
      }
    }
  );
}

// Login
function login(usuario, password, callback) {
  db.get(
    'SELECT * FROM usuarios WHERE usuario = ?',
    [usuario],
    (err, user) => {
      if (err || !user) {
        return callback(null);
      }

      const valido = bcrypt.compareSync(password, user.password);
      if (!valido) {
        return callback(null);
      }

      const token = jwt.sign(
        { id: user.id, rol: user.rol },
        JWT_SECRET,
        { expiresIn: '8h' }
      );

      callback({
        token,
        rol: user.rol,
        usuario: user.usuario
      });
    }
  );
}

module.exports = {
  crearUsuario,
  login
};
