// src/projectStatus.js
require("dotenv").config();
const axios = require("axios");
const { crearReporteDeTarea } = require("./reportBuilder");

class ProjectStatesSync {
  constructor(dbPool) {
    if (!dbPool) {
      throw new Error(
        "Se requiere una instancia del pool de PostgreSQL para ProjectStatesSync."
      );
    }
    this.pool = dbPool;

    this.zohoConfig = {
      clientId: process.env.ZOHO_CLIENT_ID,
      clientSecret: process.env.ZOHO_CLIENT_SECRET,
      refreshToken: process.env.ZOHO_REFRESH_TOKEN,
      baseURL: "https://www.zohoapis.com/crm/v2",
    };

    // Tu ID inicial personalizado, como un BigInt para cálculos seguros.
    this.initialId = 1000000000000000001n;
  }

  // --- Obtener Token de Acceso ---
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

  // --- Obtener Nombres de Estados de Proyecto desde Zoho (con paginación) ---
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
        select_query: `SELECT Estado FROM Proyectos_Comerciales WHERE Estado is not null limit ${
          (page - 1) * limit
        }, ${limit}`,
      };
      try {
        const response = await axios.post(
          `${this.zohoConfig.baseURL}/coql`,
          query,
          {
            headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
          }
        );
        const data = response.data.data || [];
        if (data.length > 0) {
          const stateNames = data.map((item) => item.Estado).filter(Boolean);
          allStates = allStates.concat(stateNames);
        }
        hasMoreRecords = response.data.info?.more_records || false;
        if (hasMoreRecords) page++;
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

  // --- Método Principal de Ejecución con Lógica de Sincronización Incremental ---
  async run() {
    const reporte = crearReporteDeTarea(
      "Sincronización de Estados de Proyecto"
    );
    let client;

    try {
      console.log(`🚀 Iniciando tarea: ${reporte.tarea}...`);
      const token = await this.getZohoAccessToken();

      // --- FASE 1: MARCAR Y COMPARAR ---
      const statesFromZoho = await this.getZohoProjectStates(token);
      reporte.metricas.obtenidos = statesFromZoho.length;

      const zohoStateNames = new Set(statesFromZoho);
      reporte.metricas.procesados = zohoStateNames.size;

      console.log(
        `✅ Se encontraron ${zohoStateNames.size} estados únicos en Zoho.`
      );

      client = await this.pool.connect();

      // Obtener todos los estados existentes en la base de datos para comparar
      const { rows: dbStates } = await client.query(
        'SELECT id, name FROM public."Project_Status"'
      );
      const dbStateMap = new Map(dbStates.map((s) => [s.name, s.id]));

      // --- FASE 2: RECONCILIAR Y SINCRONIZAR (INSERTAR NUEVOS) ---
      const statesToInsert = [];
      for (const name of zohoStateNames) {
        if (!dbStateMap.has(name)) {
          statesToInsert.push(name);
        }
      }

      if (statesToInsert.length > 0) {
        console.log(`🔄 Insertando ${statesToInsert.length} nuevos estados...`);
        // Obtener el ID máximo actual para continuar la secuencia
        const maxIdResult = await client.query(
          'SELECT MAX(id::bigint) as max_id FROM public."Project_Status"'
        );
        let currentId = maxIdResult.rows[0].max_id
          ? BigInt(maxIdResult.rows[0].max_id) + 1n
          : this.initialId;

        for (const stateName of statesToInsert) {
          try {
            const insertQuery = `INSERT INTO public."Project_Status" (id, name) VALUES ($1, $2);`;
            await client.query(insertQuery, [currentId.toString(), stateName]);
            reporte.metricas.exitosos++;
            console.log(`   -> Insertado: '${stateName}' con ID ${currentId}`);
            currentId++; // Incrementar para el siguiente
          } catch (dbError) {
            reporte.metricas.fallidos++;
            reporte.erroresDetallados.push({
              referencia: `Estado: '${stateName}'`,
              motivo: `Error al insertar: ${dbError.message}`,
            });
          }
        }
      } else {
        console.log("✅ No hay nuevos estados para insertar.");
      }

      // --- FASE 3: BARRER (ELIMINAR OBSOLETOS) ---
      const statesToDelete = [];
      for (const dbStateName of dbStateMap.keys()) {
        if (!zohoStateNames.has(dbStateName)) {
          statesToDelete.push(dbStateName);
        }
      }

      if (statesToDelete.length > 0) {
        console.log(
          `🧹 Eliminando ${statesToDelete.length} estados obsoletos...`
        );
        // Prepara los nombres para una cláusula IN segura
        const namesForQuery = statesToDelete
          .map((name) => `'${name.replace(/'/g, "''")}'`)
          .join(",");
        const deleteQuery = `DELETE FROM public."Project_Status" WHERE name IN (${namesForQuery})`;

        const deleteResult = await client.query(deleteQuery);
        reporte.metricas.eliminados = deleteResult.rowCount;
        console.log(`   -> ${deleteResult.rowCount} estados eliminados.`);
      } else {
        console.log("✅ No hay estados obsoletos para eliminar.");
      }

      reporte.estado =
        reporte.metricas.fallidos > 0 ? "finalizado_con_errores" : "exitoso";
      console.log(
        `✅ Tarea '${reporte.tarea}' finalizada con estado: ${reporte.estado}`
      );
    } catch (error) {
      console.error(`🚨 ERROR CRÍTICO en '${reporte.tarea}'.`, error);
      reporte.estado = "error_critico";
      reporte.erroresDetallados.push({
        motivo: "Error general en la ejecución de la tarea",
        detalle: error.message,
      });
    } finally {
      if (client) client.release();
    }

    return reporte;
  }
}

module.exports = ProjectStatesSync;
