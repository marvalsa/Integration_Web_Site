// src/index.js 
const express = require("express");
const packageJson = require("../package.json");
const dbPool = require("./database");

// --- Importaciones de los módulos de sincronización ---
const MegaSync = require("./megaProyectos");
const AttributeSync = require("./projectAttributes");
const ZohoToPostgresSyncProjects = require("./projects");
const CitiesSync = require("./cities");
const ProjectStatesSync = require("./projectStatus");
const { crearReporteDeTarea } = require("./reportBuilder"); // Importamos para manejar errores

const app = express();
const port = process.env.PORT || 3000;

app.get("/", (req, res) => {
    res.json({
        nombre: packageJson.name,
        version: packageJson.version
    });
});

app.post("/", async (req, res) => {
    const horaInicio = new Date();
    console.log(`[${horaInicio.toISOString()}] INICIANDO PROCESO DE SINCRONIZACIÓN COMPLETO`);

    const todosLosReportes = [];

    try {
        // --- Instanciar todas las clases de sincronización ---
        const citiesSync = new CitiesSync(dbPool);
        const projectStatesSync = new ProjectStatesSync(dbPool);
        const attributeSync = new AttributeSync(dbPool);
        const megaSync = new MegaSync(dbPool);
        const projectsSync = new ZohoToPostgresSyncProjects(dbPool);

        // --- PASO 1: Sincronizar Datos Maestros (Lookups) en Paralelo ---
        // Estos no dependen de nada y pueden correr juntos.
        console.log("\n--- [PASO 1/3] Sincronizando Datos Maestros (Ciudades, Estados, Atributos) ---");
        const resultadosPaso1 = await Promise.allSettled([
            citiesSync.run(),
            projectStatesSync.run(),
            attributeSync.run(),
        ]);
        
        // Procesamos los resultados para tener un reporte unificado
        resultadosPaso1.forEach(resultado => {
            if (resultado.status === 'fulfilled') {
                todosLosReportes.push(resultado.value);
            } else {
                // Si una promesa falla, creamos un reporte de error para ella
                const reporteError = crearReporteDeTarea("Tarea Maestra Desconocida");
                reporteError.estado = 'error_critico';
                reporteError.erroresDetallados.push({ motivo: 'La tarea falló de forma inesperada', detalle: resultado.reason.message });
                todosLosReportes.push(reporteError);
            }
        });
        
        // VERIFICACIÓN: Si el paso 1 falló, abortamos.
        if (todosLosReportes.some(r => r.estado !== 'exitoso')) {
            throw new Error("La sincronización de datos maestros falló. Abortando el proceso.");
        }
        console.log("--- [PASO 1/3] Finalizado con éxito.");


        // --- PASO 2: Sincronizar Mega Proyectos ---
        // Depende de los atributos, por eso va después del paso 1.
        console.log("\n--- [PASO 2/3] Sincronizando Mega Proyectos ---");
        const reporteMegaProyectos = await megaSync.run();
        todosLosReportes.push(reporteMegaProyectos);

        // VERIFICACIÓN: Si el paso 2 falló, abortamos.
        if (reporteMegaProyectos.estado !== 'exitoso') {
            throw new Error("La sincronización de Mega Proyectos falló. Abortando el proceso.");
        }
        console.log("--- [PASO 2/3] Finalizado con éxito.");


        // --- PASO 3: Sincronizar Proyectos y Tipologías ---
        // Es el paso final, ya que depende de todo lo anterior.
        console.log("\n--- [PASO 3/3] Sincronizando Proyectos y Tipologías ---");
        const reporteProyectos = await projectsSync.run();
        todosLosReportes.push(reporteProyectos);
        console.log("--- [PASO 3/3] Finalizado.");


        // --- Construcción del Reporte Final ---
        const tieneErrores = todosLosReportes.some(r => r.estado !== 'exitoso');
        const horaFin = new Date();

        const reporteFinal = {
            estadoGeneral: tieneErrores ? 'Finalizado con errores' : 'Exitoso',
            fechaInicio: horaInicio.toISOString(),
            fechaFin: horaFin.toISOString(),
            duracionSegundos: (horaFin - horaInicio) / 1000,
            resumenDeTareas: todosLosReportes
        };

        console.log(`\nPROCESO DE SINCRONIZACIÓN FINALIZADO. Estado: ${reporteFinal.estadoGeneral}`);
        res.status(200).json(reporteFinal);

    } catch (error) {
        // Este catch ahora captura tanto errores catastróficos como los "abortos tempranos"
        console.error("\n❌ PROCESO DETENIDO:", error.message);
        const horaFin = new Date();
        const reporteFinal = {
            estadoGeneral: 'Fallo Crítico o Abortado',
            fechaInicio: horaInicio.toISOString(),
            fechaFin: horaFin.toISOString(),
            duracionSegundos: (horaFin - horaInicio) / 1000,
            motivoDeFallo: error.message,
            resumenDeTareas: todosLosReportes // Incluimos los reportes generados hasta el momento del fallo
        };
        res.status(500).json(reporteFinal);
    }
});


const server = app.listen(port, () => {
    console.log(`[${new Date().toLocaleString()}] Servidor '${packageJson.name}' activo en puerto ${port}`);
});

// --- Manejo robusto para cerrar el pool SÓLO cuando la aplicación se detiene ---
const gracefulShutdown = () => {
    console.log('🔌 Recibida señal de apagado. Cerrando conexiones...');
    server.close(() => {
        console.log('✅ Servidor HTTP cerrado.');
        dbPool.end().then(() => {
            console.log('🐘 Pool de PostgreSQL cerrado con éxito.');
            process.exit(0);
        });
    });
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);