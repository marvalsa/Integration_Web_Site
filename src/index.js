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

  let reporteFinal = {};

  try {
    // Instanciar las clases
    const citiesSync = new CitiesSync(dbPool);
    const projectStatesSync = new ProjectStatesSync(dbPool);
    const attributeSync = new AttributeSync(dbPool);
    const megaSync = new MegaSync(dbPool);
    const projectsSync = new ZohoToPostgresSyncProjects(dbPool);

    console.log("\n--- [PASO 1/2] Sincronizando dependencias en paralelo ---");
    const resultadosParalelos = await Promise.allSettled([
      citiesSync.run(),
      projectStatesSync.run(),
      attributeSync.run(),
      megaSync.run(),
    ]);
    
    // Simplemente recolectamos los reportes ya formateados
    const reportesPaso1 = resultadosParalelos.map(res => res.status === 'fulfilled' ? res.value : res.reason);

    console.log("--- [PASO 1/2] Finalizado.");

    console.log("\n--- [PASO 2/2] Sincronizando Proyectos y Tipologías ---");
    const reportePaso2 = await projectsSync.run();
    console.log("--- [PASO 2/2] Finalizado.");

    const todosLosReportes = [...reportesPaso1, reportePaso2];

    const tieneErrores = todosLosReportes.some(r => r.estado !== 'exitoso');
    const horaFin = new Date();

    reporteFinal = {
        estadoGeneral: tieneErrores ? 'Finalizado con errores' : 'Exitoso',
        fechaInicio: horaInicio.toISOString(),
        fechaFin: horaFin.toISOString(),
        duracionSegundos: (horaFin - horaInicio) / 1000,
        resumenDeTareas: todosLosReportes
    };

    console.log(`\nPROCESO DE SINCRONIZACIÓN FINALIZADO. Estado: ${reporteFinal.estadoGeneral}`);
    res.status(200).json(reporteFinal);

  } catch (error) {
    // Este catch es para errores catastróficos que impiden que el proceso siquiera corra.
    console.error("\nERROR FATAL INESPERADO (Handler Principal):", error);
    const horaFin = new Date();
    reporteFinal = {
        estadoGeneral: 'Fallo fatal',
        fechaInicio: horaInicio.toISOString(),
        fechaFin: horaFin.toISOString(),
        duracionSegundos: (horaFin - horaInicio) / 1000,
        errorCritico: error.message
    };
    res.status(500).json(reporteFinal);
  }
});

const server = app.listen(port, () => {
  console.log(`[${new Date().toLocaleString()}] Servidor '${packageJson.name}' activo en puerto ${port}`);
});

// Manejo robusto para cerrar el pool SÓLO cuando la aplicación se detiene
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