import { crearApp } from './app.js';
import { config } from './config.js';
import { query } from './db.js';

await query('SELECT 1'); // falla rápido si la base no responde
crearApp().listen(config.port, () => {
  console.log(`El Huevazo escuchando en http://localhost:${config.port}`);
});
