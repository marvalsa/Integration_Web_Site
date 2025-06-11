// // const MegaSync = require('./src/megaProyectos');
// // const AttributeSync = require('./src/projectAttributes');
// // const ZohoToPostgresSyncProjects = require('./src/projects');

// // (async () => {
// //     const syncMega = new MegaSync();
// //     const syncAttributes = new AttributeSync();
// //     const syncProjects = new ZohoToPostgresSyncProjects();

// //     await syncMega.run();        // MegaProyectos
// //     await syncAttributes.run();  // Atributos    
// //     await syncProjects.run();    // Proyectos
// // })();

// // sync.js

// // 1. IMPORTA TU LOGGER PERSONALIZADO
// const logger = require('./logs/logger'); 

// const MegaSync = require('./src/megaProyectos');
// const AttributeSync = require('./src/projectAttributes');
// const ZohoToPostgresSyncProjects = require('./src/projects');

// (async () => {
//     // 2. USA LOS MÉTODOS DE TU LOGGER (logger.info, logger.error)
//     logger.info("Iniciando proceso de sincronización...");

//     try {
//         // --- Paso 1: MegaProyectos ---
//         logger.info("Iniciando sincronización de MegaProyectos...");
//         const syncMega = new MegaSync();
//         await syncMega.run();
//         logger.info("Sincronización de MegaProyectos completada exitosamente.");

//         // --- Paso 2: Atributos ---
//         logger.info("Iniciando sincronización de Atributos...");
//         const syncAttributes = new AttributeSync();
//         await syncAttributes.run();
//         logger.info("Sincronización de Atributos completada exitosamente.");

//         // --- Paso 3: Proyectos ---
//         logger.info("Iniciando sincronización de Proyectos...");
//         const syncProjects = new ZohoToPostgresSyncProjects();
//         await syncProjects.run();
//         logger.info("Sincronización de Proyectos completada exitosamente.");

//         logger.info("¡Todas las sincronizaciones se completaron exitosamente!");

//     } catch (error) {
//         logger.error("------------------------------------------------------");
//         logger.error("ERROR: El proceso de sincronización falló.");
//         logger.error("Detalle del error (mensaje):", error.message);
//         if (error.stack) {
//             logger.error("Detalle del error (stack):", error.stack);
//         } else {
//             logger.error("Detalle del error (objeto completo):", error);
//         }
//         logger.error("------------------------------------------------------");
//         // process.exit(1); // Si quieres que el script termine con un código de error
//     } finally {
//         logger.info("Proceso de sincronización finalizado (ya sea con éxito o con error).");
//     }
// })();
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// sync.js

const fs = require('fs');
const path = require('path');
const logger = require('./logs/logger');

const MegaSync = require('./src/megaProyectos');
const AttributeSync = require('./src/projectAttributes');
const ZohoToPostgresSyncProjects = require('./src/projects');

(async () => {
    logger.info("Iniciando proceso de sincronización...");

    try {
        // --- Paso 1: MegaProyectos ---
        logger.info("Iniciando sincronización de MegaProyectos...");
        const syncMega = new MegaSync();
        await syncMega.run();
        logger.info("Sincronización de MegaProyectos completada.");

        // --- Paso 2: Atributos ---
        logger.info("Iniciando sincronización de Atributos...");
        const syncAttributes = new AttributeSync();
        await syncAttributes.run();
        logger.info("Sincronización de Atributos completada.");

        // --- Paso 3: Proyectos ---
        logger.info("Iniciando sincronización de Proyectos...");
        const syncProjects = new ZohoToPostgresSyncProjects();
        await syncProjects.run();
        logger.info("Sincronización de Proyectos completada.");

        logger.info("¡Todas las sincronizaciones se ejecutaron!");

    } catch (error) {
        logger.error("------------------------------------------------------");
        logger.error("ERROR: El proceso de sincronización se detuvo por un error crítico.");
        logger.error("Detalle del error (mensaje):", error.message);
        if (error.stack) {
            logger.error("Detalle del error (stack):", error.stack);
        } else {
            logger.error("Detalle del error (objeto completo):", error);
        }
        logger.error("------------------------------------------------------");
    } finally {
        // ***************************************************************
        // *****   AQUÍ COMIENZA LA LÓGICA DE ANÁLISIS DEL LOG         *****
        // ***************************************************************
        logger.info('\n==================================================================');
        logger.info('📊 RESUMEN FINAL OBTENIDO DEL ARCHIVO DE LOG');
        logger.info('==================================================================');

        try {
            const logFilePath = path.join(__dirname, 'logs', 'sync.log');
            const logContent = fs.readFileSync(logFilePath, 'utf-8');

            // --- Función auxiliar para extraer números con regex ---
            const findValue = (regex) => {
                const match = logContent.match(regex);
                return match ? (match[1] || 'No encontrado') : 'No encontrado';
            };

            // --- Extracción de datos de Mega Proyectos ---
            // Busca una línea como: "...Sincronización de Mega Proyectos finalizada. 2 de 2 procesados..."
            const megaProyectosExitosos = findValue(/Sincronización de Mega Proyectos finalizada\. (\d+) de/);
            const megaProyectosTotales = findValue(/Sincronización de Mega Proyectos finalizada\. \d+ de (\d+)/);

            // --- Extracción de datos de Atributos ---
            // Busca una línea como: "...30 atributos recuperados de Zoho."
            // Y "...Procesamiento de atributos completado. 30 atributos procesados..."
            const atributosRecuperados = findValue(/(\d+) atributos recuperados de Zoho/);
            const atributosProcesados = findValue(/Procesamiento de atributos completado\. (\d+) atributos procesados/);
            
            // --- Extracción de datos de Proyectos Comerciales ---
            // Busca líneas como: "Total de proyectos recuperados de Zoho: 16" y "Proyectos procesados con éxito...: 15"
            const proyectosRecuperados = findValue(/Total de proyectos recuperados de Zoho: (\d+)/);
            const proyectosExitosos = findValue(/Proyectos procesados con éxito \(insertados\/actualizados en DB\): (\d+)/);
            const proyectosFallidos = findValue(/Proyectos con errores \(omitidos o con fallos\): (\d+)/);
            
            // --- Contar Tipologías ---
            // Busca todas las ocurrencias de "Tipología ... insertada/actualizada"
            const tipologiasExitosas = (logContent.match(/Tipología .*? insertada\/actualizada/g) || []).length;


            // --- Imprimir el Resumen Final ---
            logger.info(`Mega Proyectos:`);
            logger.info(`  - Recuperados: ${megaProyectosTotales}`);
            logger.info(`  - ✅ Exitosos: ${megaProyectosExitosos}`);
            
            logger.info(`\nAtributos Globales:`);
            logger.info(`  - Recuperados: ${atributosRecuperados}`);
            logger.info(`  - ✅ Procesados: ${atributosProcesados}`);

            logger.info(`\nProyectos Comerciales:`);
            logger.info(`  - Recuperados: ${proyectosRecuperados}`);
            logger.info(`  - ✅ Exitosos: ${proyectosExitosos}`);
            logger.info(`  - ❌ Con errores: ${proyectosFallidos}`);

            logger.info(`\nTipologías:`);
            logger.info(`  - ✅ Insertadas/Actualizadas: ${tipologiasExitosas}`);

        } catch (logError) {
            logger.error('No se pudo leer o analizar el archivo de log para generar el resumen final.');
            logger.error('Error de análisis:', logError.message);
        }

        logger.info('==================================================================');
        logger.info("Proceso de sincronización finalizado.");
    }
})();