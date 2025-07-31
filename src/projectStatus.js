// src/projectStatus.js
require("dotenv").config();
const axios = require("axios");
const { crearReporteDeTarea } = require('./reportBuilder'); // <<< 1. IMPORTAR

class ProjectStatesSync {
  constructor(dbPool) {
    if (!dbPool) {
      throw new Error("Se requiere una instancia del pool de PostgreSQL para ProjectStatesSync.");
    }
    this.pool = dbPool;

    this.zohoConfig = {
      clientId: process.env.ZOHO_CLIENT_ID,
      clientSecret: process.env.ZOHO_CLIENT_SECRET,
      refreshToken: process.env.ZOHO_REFRESH_TOKEN,
      baseURL: "https://www.zohoapis.com/crm/v2",
    };
  }

  // --- Paso 1: Obtener Token ---
  async getZohoAccessToken() {
    try {
      const response = await axios.post(
        "https://accounts.zoho.com/oauth/v2/token",
        null,
        {
          params: {
            refresh_token: this.zohoConfig.refreshToken,
            client_id: this.zohoConfig.clientId,
            client_secret: this.zohoConfig.clientSecret,
            grant_type: "refresh_token",
          },
        }
      );
      const token = response.data.access_token;
      if (!token) throw new Error("Access token no recibido de Zoho");
      console.log(
        "✅ Token obtenido para sincronización de Estados de Proyecto."
      );
      return token;
    } catch (error) {
      console.error(
        "❌ Error al obtener token para Estados de Proyecto:",
        error.response?.data || error.message
      );
      throw error;
    }
  }

  // --- Paso 2: Obtener Nombres de Estados de Zoho (CON PAGINACIÓN) ---
  async getZohoProjectStates(accessToken) {
    let allStates = [];
    let hasMoreRecords = true;
    let page = 1;
    const limit = 200;

    console.log(
      "ℹ️ Obteniendo estados de proyecto desde Zoho (con paginación)..."
    );

    while (hasMoreRecords) {
      const query = {
        // Seleccionamos solo el campo 'Estado' y paginamos los resultados
        select_query: `SELECT Estado FROM Proyectos_Comerciales WHERE Estado is not null limit ${
          (page - 1) * limit
        }, ${limit}`,
      };

      try {
        console.log(`  > Solicitando página ${page} de estados...`);
        const response = await axios.post(
          `${this.zohoConfig.baseURL}/coql`,
          query,
          {
            headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
          }
        );

        const data = response.data.data || [];
        if (data.length > 0) {
          // Extraemos solo el nombre del estado de cada registro
          const stateNames = data.map((item) => item.Estado).filter(Boolean);
          allStates = allStates.concat(stateNames);
        }

        hasMoreRecords = response.data.info?.more_records || false;
        if (hasMoreRecords) {
          page++;
        }
      } catch (error) {
        console.error(
          `❌ Error al obtener la página ${page} de estados desde Zoho:`,
          error.response?.data || error.message
        );
        throw error;
      }
    }

    console.log(
      `✅ ${allStates.length} registros de estado recuperados de Zoho en total.`
    );
    return allStates;
  }

  // <<< 2. AJUSTAMOS `syncStatesWithPostgres` PARA QUE ACTUALICE EL REPORTE
  async syncStatesWithPostgres(stateNames, reporte) {
    if (!stateNames || stateNames.length === 0) {
      return;
    } 

    const uniqueStateNames = [...new Set(stateNames)];
    reporte.metricas.procesados = uniqueStateNames.length;
    
    const client = await this.pool.connect();
    
    try {
      await client.query("BEGIN");
      await client.query('TRUNCATE TABLE public."Project_Status" RESTART IDENTITY CASCADE;');
      
      let currentId = 1000000000000000001n; // Mantenemos tu excelente lógica de ID personalizado.

      for (const stateName of uniqueStateNames) {
        try {
            const insertQuery = `INSERT INTO public."Project_Status" (id, name) VALUES ($1, $2);`;
            await client.query(insertQuery, [currentId.toString(), stateName]);
            reporte.metricas.exitosos++; // Contamos como exitoso
            currentId++;
        } catch(dbError) {
            reporte.metricas.fallidos++; // Contamos como fallido
            reporte.erroresDetallados.push({
                referencia: `Estado: '${stateName}'`,
                motivo: `Error en Base de Datos: ${dbError.message}`
            });
        }
      }
      await client.query("COMMIT");
      console.log('✅ Transacción de estados completada con COMMIT.');

    } catch (transactionError) {
      await client.query("ROLLBACK");
      console.error(`❌ Error en transacción de estados. ROLLBACK ejecutado.`, transactionError);
      // Este es un error crítico que afecta a toda la operación, lo relanzamos para que lo capture el 'run'
      throw transactionError; 
    } finally {
      client.release();
    }
  }

  // <<< 3. `run()` USA EL NUEVO CONSTRUCTOR Y ORQUESTA LA LÓGICA
  async run() {
    // Creamos el reporte desde el constructor centralizado
    const reporte = crearReporteDeTarea("Sincronización de Estados de Proyecto");

    try {
      console.log(`🚀 Iniciando tarea: ${reporte.tarea}...`);

      const token = await this.getZohoAccessToken();
      const statesFromZoho = await this.getZohoProjectStates(token);
      
      // Llenamos la métrica inicial
      reporte.metricas.obtenidos = statesFromZoho.length;
      
      // Pasamos el reporte a la función de sincronización para que lo llene
      await this.syncStatesWithPostgres(statesFromZoho, reporte);
      
      // Determinamos el estado final basado en las métricas
      reporte.estado = (reporte.metricas.fallidos > 0) 
        ? 'finalizado_con_errores' 
        : 'exitoso';
      
      console.log(`✅ Tarea '${reporte.tarea}' finalizada con estado: ${reporte.estado}`);

    } catch (error) {
      console.error(`🚨 ERROR CRÍTICO en '${reporte.tarea}'.`, error);
      reporte.estado = 'error_critico';
      reporte.erroresDetallados.push({ 
        motivo: 'Error general en la ejecución de la tarea', 
        detalle: error.message 
      });
    }

    return reporte; // Devolvemos el reporte estandarizado
  }
}

module.exports = ProjectStatesSync;