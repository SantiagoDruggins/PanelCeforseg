const express = require('express');
const app = express();

// Puerto compatible con Linux / Render
const PORT = process.env.PORT || 3000;

// Ruta principal
app.get('/', (req, res) => {
  res.send('Panel CEFORSEG funcionando 🚀');
});

// Arrancar servidor
app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
