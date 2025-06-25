const express = require('express')
const fs = require('fs');
const path = require('path');
const logger = require('../logs/logger');
// Imports de los módulos de sincronización
const MegaSync = require('./megaProyectos');
const AttributeSync = require('./projectAttributes');
const ZohoToPostgresSyncProjects = require('./projects');
const CitiesSync = require('./cities');

const app = express()

const port = process.env.PORT || 3000
 
app.get('/', (req, res) => {
  res.send('Hello World!')
});

app.post('/', async (req, res) => {
  logger.info("==================================================================");
    logger.info("🚀 INICIANDO PROCESO DE SINCRONIZACIÓN COMPLETO");
    logger.info("==================================================================");

    try {
      // Instancias de sincronización
        const syncCities = new CitiesSync();
        const syncMega = new MegaSync();
        const syncAttributes = new AttributeSync();
        const syncProjects = new ZohoToPostgresSyncProjects();

        await Promise.all([
            // syncCities.run(),
            syncMega.run(),
            syncAttributes.run(),
            syncProjects.run()
        ]);

        // // --- Paso 1: Ciudades ---
        // // Se ejecuta primero para que las FK de Proyectos funcionen
        // logger.info("\n--- PASO 1: CIUDADES ---");
        
        // await syncCities.run();
        // logger.info("✅ Sincronización de Ciudades completada.");

        // // --- Paso 2: MegaProyectos ---
        // // Se ejecuta para que las FK de Proyectos funcionen
        // logger.info("\n--- PASO 2: MEGAPROYECTOS ---");
        
        // await syncMega.run();
        // logger.info("✅ Sincronización de MegaProyectos completada.");

        // // --- Paso 3: Atributos ---
        // logger.info("\n--- PASO 3: ATRIBUTOS ---");
        
        // await syncAttributes.run();
        // logger.info("✅ Sincronización de Atributos completada.");

        // // --- Paso 4: Proyectos (y sus Tipologías) ---
        // // Se ejecuta al final ya que depende de los anteriores
        // logger.info("\n--- PASO 4: PROYECTOS Y TIPOLOGÍAS ---");
        
        // await syncProjects.run();
        // logger.info("✅ Sincronización de Proyectos completada.");

        // logger.info("\n==================================================================");
        // logger.info("🎉 ¡TODAS LAS SINCRONIZACIONES SE HAN EJECUTADO!");
        // logger.info("==================================================================");

        res.send('Proceso de sincronización completado.');
    } catch (error) {
        logger.error("\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
        logger.error("🚨 ERROR CRÍTICO: El proceso de sincronización se detuvo.");
        logger.error(`   Mensaje: ${error.message}`);
        
        if (error.stack) {
             logger.error(`   Stack Trace: ${error.stack}`);
        }
        if (error.response?.data) {
            logger.error(`   Respuesta del API (Zoho): ${JSON.stringify(error.response.data)}`);
        }
        res.status(500).send('Error en el proceso de sincronización.');
    } finally {
        // El bloque `finally` se ejecuta siempre, haya habido éxito o error.
        logger.info("🏁 Proceso de sincronización finalizado.");
        // <<< SE ELIMINÓ TODA LA LÓGICA DE LECTURA Y ANÁLISIS DEL ARCHIVO DE LOG.
    }
})
 
app.listen(port, () => {
  console.log(`Example app listening on port ${port}`)
})

 