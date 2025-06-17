// sync.js

const fs = require('fs');
const path = require('path');
const logger = require('./logs/logger');

// Imports de los módulos de sincronización
const MegaSync = require('./src/megaProyectos');
const AttributeSync = require('./src/projectAttributes');
const ZohoToPostgresSyncProjects = require('./src/projects');
const CitiesSync = require('./src/cities');

(async () => {
    logger.info("==================================================================");
    logger.info("🚀 INICIANDO PROCESO DE SINCRONIZACIÓN COMPLETO");
    logger.info("==================================================================");

    try {
        // --- Paso 1: Ciudades ---
        // Se ejecuta primero para que las FK de Proyectos funcionen
        logger.info("\n--- PASO 1: CIUDADES ---");
        const syncCities = new CitiesSync();
        await syncCities.run();
        logger.info("✅ Sincronización de Ciudades completada.");

        // --- Paso 2: MegaProyectos ---
        // Se ejecuta para que las FK de Proyectos funcionen
        logger.info("\n--- PASO 2: MEGAPROYECTOS ---");
        const syncMega = new MegaSync();
        await syncMega.run();
        logger.info("✅ Sincronización de MegaProyectos completada.");

        // --- Paso 3: Atributos ---
        logger.info("\n--- PASO 3: ATRIBUTOS ---");
        const syncAttributes = new AttributeSync();
        await syncAttributes.run();
        logger.info("✅ Sincronización de Atributos completada.");

        // --- Paso 4: Proyectos (y sus Tipologías) ---
        // Se ejecuta al final ya que depende de los anteriores
        logger.info("\n--- PASO 4: PROYECTOS Y TIPOLOGÍAS ---");
        const syncProjects = new ZohoToPostgresSyncProjects();
        await syncProjects.run();
        logger.info("✅ Sincronización de Proyectos completada.");

        logger.info("\n==================================================================");
        logger.info("🎉 ¡TODAS LAS SINCRONIZACIONES SE HAN EJECUTADO!");
        logger.info("==================================================================");

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
        logger.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n");
    } finally {
        // El bloque `finally` se ejecuta siempre, haya habido éxito o error.
        logger.info("🏁 Proceso de sincronización finalizado.");
        // <<< SE ELIMINÓ TODA LA LÓGICA DE LECTURA Y ANÁLISIS DEL ARCHIVO DE LOG.
    }
})();