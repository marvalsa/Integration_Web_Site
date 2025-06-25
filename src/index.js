const express = require('express')
const fs = require('fs');
const path = require('path');
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
  console.log("==================================================================");
    console.log("🚀 INICIANDO PROCESO DE SINCRONIZACIÓN COMPLETO");
    console.log("==================================================================");

    try {
      // Instancias de sincronización
        const syncCities = new CitiesSync();
        const syncMega = new MegaSync();
        const syncAttributes = new AttributeSync();
        const syncProjects = new ZohoToPostgresSyncProjects();

        await Promise.all([
            syncCities.run(),
            syncMega.run(),
            syncAttributes.run(),
            syncProjects.run()
        ]);

        // // --- Paso 1: Ciudades ---
        // // Se ejecuta primero para que las FK de Proyectos funcionen
        // console.log("\n--- PASO 1: CIUDADES ---");
        
        // await syncCities.run();
        // console.log("✅ Sincronización de Ciudades completada.");

        // // --- Paso 2: MegaProyectos ---
        // // Se ejecuta para que las FK de Proyectos funcionen
        // console.log("\n--- PASO 2: MEGAPROYECTOS ---");
        
        // await syncMega.run();
        // console.log("✅ Sincronización de MegaProyectos completada.");

        // // --- Paso 3: Atributos ---
        // console.log("\n--- PASO 3: ATRIBUTOS ---");
        
        // await syncAttributes.run();
        // console.log("✅ Sincronización de Atributos completada.");

        // // --- Paso 4: Proyectos (y sus Tipologías) ---
        // // Se ejecuta al final ya que depende de los anteriores
        // console.log("\n--- PASO 4: PROYECTOS Y TIPOLOGÍAS ---");
        
        // await syncProjects.run();
        // console.log("✅ Sincronización de Proyectos completada.");

        // console.log("\n==================================================================");
        // console.log("🎉 ¡TODAS LAS SINCRONIZACIONES SE HAN EJECUTADO!");
        // console.log("==================================================================");

        res.send('Proceso de sincronización completado.');
    } catch (error) {
        console.error("\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
        console.error("🚨 ERROR CRÍTICO: El proceso de sincronización se detuvo.");
        console.error(`   Mensaje: ${error.message}`);
        
        if (error.stack) {
             console.error(`   Stack Trace: ${error.stack}`);
        }
        if (error.response?.data) {
            console.error(`   Respuesta del API (Zoho): ${JSON.stringify(error.response.data)}`);
        }
        res.status(500).send('Error en el proceso de sincronización.');
    } finally {
        // El bloque `finally` se ejecuta siempre, haya habido éxito o error.
        console.log("🏁 Proceso de sincronización finalizado.");
        // <<< SE ELIMINÓ TODA LA LÓGICA DE LECTURA Y ANÁLISIS DEL ARCHIVO DE LOG.
    }
})
 
app.listen(port, () => {
  console.log(`Example app listening on port ${port}`)
})

 