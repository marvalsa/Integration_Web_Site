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

// --- RUTA DE SINCRONIZACIÓN OPTIMIZADA (ENFOQUE HÍBRIDO) ---
app.post('/', async (req, res) => {  
    console.log("INICIANDO PROCESO DE SINCRONIZACIÓN COMPLETO (MODO HÍBRIDO)");
    
    try {
        // --- PASO 1: Sincronizar tablas base en PARALELO ---
        console.log("\n--- [PASO 1/3] Sincronizando en paralelo: Ciudades, Estados y Atributos ---");
        await Promise.all([
            (new CitiesSync()).run(),
            (new ProjectStatesSync()).run(),
            (new AttributeSync()).run()
        ]);
        console.log("--- [PASO 1/3] Finalizado: Ciudades, Estados y Atributos sincronizados ---");

        // --- PASO 2: Sincronizar tablas con dependencias (secuencial) ---
        console.log("\n--- [PASO 2/3] Sincronizando Mega Proyectos ---");
        await (new MegaSync()).run();
        console.log("--- [PASO 2/3] Finalizado: Mega Proyectos sincronizados ---");

        // --- PASO 3: Sincronizar tabla principal que depende de todas las demás ---
        console.log("\n--- [PASO 3/3] Sincronizando Proyectos y Tipologías ---");
        await (new ZohoToPostgresSyncProjects()).run();
        console.log("--- [PASO 3/3] Finalizado: Proyectos y Tipologías sincronizados ---");


        const successMessage = 'PROCESO DE SINCRONIZACIÓN HÍBRIDO COMPLETADO CON ÉXITO';
        console.log(`\n${successMessage}`);
        res.status(200).send(successMessage);

    } catch (error) {
        console.error("\nERROR CRÍTICO: El proceso de sincronización se detuvo.");
        console.error(`   Mensaje: ${error.message}`);
        
        if (error.stack) {
             console.error(`   Stack Trace: ${error.stack}`);
        }
        if (error.response?.data) {
            console.error(`   Respuesta del API (Zoho): ${JSON.stringify(error.response.data)}`);
        }
        res.status(500).send('Error crítico en el proceso de sincronización. Revise los logs del servidor.');
    } finally {
        console.log("\n🏁 Proceso de sincronización finalizado (con o sin errores).");
    }
});
 
app.listen(port, () => {
  console.log(`[${new Date().toLocaleString()}] Server development activo - escuchando en el puerto ${port}`);
});