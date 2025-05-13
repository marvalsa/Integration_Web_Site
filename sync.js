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

const MegaSync = require('./src/megaProyectos');
const AttributeSync = require('./src/projectAttributes');
const ZohoToPostgresSyncProjects = require('./src/projects');

(async () => {
    console.log("Iniciando proceso de sincronización...");

    try {
        // --- Paso 1: MegaProyectos ---
        console.log("Iniciando sincronización de MegaProyectos...");
        const syncMega = new MegaSync();
        await syncMega.run(); // Si syncMega.run() lanza un error, la ejecución salta al bloque catch
        console.log("Sincronización de MegaProyectos completada exitosamente.");

        // --- Paso 2: Atributos (Solo se ejecuta si el Paso 1 fue exitoso) ---
        console.log("Iniciando sincronización de Atributos...");
        const syncAttributes = new AttributeSync();
        await syncAttributes.run(); // Si syncAttributes.run() lanza un error, la ejecución salta al bloque catch
        console.log("Sincronización de Atributos completada exitosamente.");

        // --- Paso 3: Proyectos (Solo se ejecuta si el Paso 2 fue exitoso) ---
        console.log("Iniciando sincronización de Proyectos...");
        const syncProjects = new ZohoToPostgresSyncProjects();
        await syncProjects.run(); // Si syncProjects.run() lanza un error, la ejecución salta al bloque catch
        console.log("Sincronización de Proyectos completada exitosamente.");

        console.log("¡Todas las sincronizaciones se completaron exitosamente!");

    } catch (error) {
        // Si cualquier 'await' dentro del 'try' falla (lanza una excepción),
        // la ejecución llegará directamente aquí.
        console.error("------------------------------------------------------");
        console.error("ERROR: El proceso de sincronización falló.");
        console.error("Detalle del error:", error);
        console.error("------------------------------------------------------");
        // Aquí podrías añadir lógica adicional para manejar el error:
        // - Enviar una notificación
        // - Registrar el error en un archivo o base de datos de logs
        // - Intentar alguna acción de limpieza si es necesario
        // - Salir del proceso con un código de error: process.exit(1); (si es un script standalone)
    } finally {
        // El bloque finally se ejecuta siempre, tanto si el try tuvo éxito como si hubo un error en el catch.
        // Es útil para tareas de limpieza final (ej: cerrar conexiones de base de datos si las abriste aquí).
        console.log("Proceso de sincronización finalizado (ya sea con éxito o con error).");
    }
})();