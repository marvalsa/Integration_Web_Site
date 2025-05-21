// const MegaSync = require('./src/megaProyectos');
// const AttributeSync = require('./src/projectAttributes');
// const ZohoToPostgresSyncProjects = require('./src/projects');

// (async () => {
//     const syncMega = new MegaSync();
//     const syncAttributes = new AttributeSync();
//     const syncProjects = new ZohoToPostgresSyncProjects();

//     await syncMega.run();        // MegaProyectos
//     await syncAttributes.run();  // Atributos    
//     await syncProjects.run();    // Proyectos
// })();

// sync.js

// 1. IMPORTA TU LOGGER PERSONALIZADO
const logger = require('./logs/logger'); // Asume que logger.js está en ./logs/logger.js

const MegaSync = require('./src/megaProyectos');
const AttributeSync = require('./src/projectAttributes');
const ZohoToPostgresSyncProjects = require('./src/projects');

(async () => {
    // 2. USA LOS MÉTODOS DE TU LOGGER (logger.info, logger.error)
    logger.info("Iniciando proceso de sincronización...");

    try {
        // --- Paso 1: MegaProyectos ---
        logger.info("Iniciando sincronización de MegaProyectos...");
        const syncMega = new MegaSync();
        await syncMega.run();
        logger.info("Sincronización de MegaProyectos completada exitosamente.");

        // --- Paso 2: Atributos ---
        logger.info("Iniciando sincronización de Atributos...");
        const syncAttributes = new AttributeSync();
        await syncAttributes.run();
        logger.info("Sincronización de Atributos completada exitosamente.");

        // --- Paso 3: Proyectos ---
        logger.info("Iniciando sincronización de Proyectos...");
        const syncProjects = new ZohoToPostgresSyncProjects();
        await syncProjects.run();
        logger.info("Sincronización de Proyectos completada exitosamente.");

        logger.info("¡Todas las sincronizaciones se completaron exitosamente!");

    } catch (error) {
        logger.error("------------------------------------------------------");
        logger.error("ERROR: El proceso de sincronización falló.");
        logger.error("Detalle del error (mensaje):", error.message);
        if (error.stack) {
            logger.error("Detalle del error (stack):", error.stack);
        } else {
            logger.error("Detalle del error (objeto completo):", error);
        }
        logger.error("------------------------------------------------------");
        // process.exit(1); // Si quieres que el script termine con un código de error
    } finally {
        logger.info("Proceso de sincronización finalizado (ya sea con éxito o con error).");
    }
})();