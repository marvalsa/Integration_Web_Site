const express = require('express');

// --- Importaciones de los módulos de sincronización ---
const MegaSync = require('./megaProyectos');
const AttributeSync = require('./projectAttributes');
const ZohoToPostgresSyncProjects = require('./projects');
const CitiesSync = require('./cities');
const ProjectStatesSync = require('./projectStatus'); 

const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('Conexion exitosa Microservicio API GCP!');
});

// --- RUTA DE SINCRONIZACIÓN SÍNCRONA PERO OPTIMIZADA ---
// Volvemos a poner 'async' aquí porque vamos a usar 'await' dentro.
app.post('/', async (req, res) => {  
    console.log("INICIANDO PROCESO DE SINCRONIZACIÓN COMPLETO (MODO SÍNCRONO OPTIMIZADO)");
    
    try {
        // --- PASO 1: Sincronizar tablas base y MegaProyectos en PARALELO ---
        // [MEJORA DE VELOCIDAD] MegaProyectos se ejecuta junto a las demás.
        console.log("\n--- [PASO 1/3] Sincronizando en paralelo: Ciudades, Estados, Atributos y Mega Proyectos ---");
        await Promise.all([
            (new CitiesSync()).run(),
            (new ProjectStatesSync()).run(),
            (new AttributeSync()).run(),
            (new MegaSync()).run() // Movido aquí para ejecución en paralelo.
        ]);
        console.log("--- [PASO 1/3] Finalizado: Tablas base y Mega Proyectos sincronizados. ---");

        // --- PASO 2: Sincronizar tabla principal que depende de todas las demás ---
        // Este paso sigue siendo secuencial, ya que depende del paso 1.
        console.log("\n--- [PASO 2/3] Sincronizando Proyectos y Tipologías ---");
        await (new ZohoToPostgresSyncProjects()).run();
        console.log("--- [PASO 2/3] Finalizado: Proyectos y Tipologías sincronizados. ---");

        // --- RESPUESTA FINAL A POSTMAN ---
        // Este mensaje solo se envía cuando todo lo anterior ha terminado con éxito.
        const successMessage = 'PROCESO DE SINCRONIZACIÓN COMPLETADO CON ÉXITO';
        console.log(`\n${successMessage}`);
        res.status(200).send(successMessage);

    } catch (error) {
        // Si cualquier 'await' falla, el control salta directamente aquí.
        console.error("\nERROR CRÍTICO: El proceso de sincronización se detuvo.");
        console.error(`   Mensaje: ${error.message}`);
        
        if (error.stack) {
             console.error(`   Stack Trace: ${error.stack}`);
        }
        if (error.response?.data) {
            console.error(`   Respuesta del API (Zoho): ${JSON.stringify(error.response.data)}`);
        }
        // Postman recibirá este mensaje de error.
        res.status(500).send('Error crítico en el proceso de sincronización. Revise los logs del servidor para más detalles.');
    } finally {
        // Este bloque se ejecuta siempre, al final, sin importar si hubo éxito o error.
        console.log("\n🏁 Proceso de sincronización finalizado (con o sin errores).");
    }
});
 
app.listen(port, () => {
  console.log(`[${new Date().toLocaleString()}] Server development activo - escuchando en el puerto ${port}`);
});