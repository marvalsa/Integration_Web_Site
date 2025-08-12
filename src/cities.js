// cities.js
require("dotenv").config();
const axios = require("axios");
const { crearReporteDeTarea } = require("./reportBuilder");

class CitiesSync {
  constructor(dbPool) {
    if (!dbPool) {
      throw new Error(
        "Se requiere una instancia del pool de PostgreSQL para CitiesSync."
      );
    }
    this.pool = dbPool;
    this.zohoConfig = {
      clientId: process.env.ZOHO_CLIENT_ID,
      clientSecret: process.env.ZOHO_CLIENT_SECRET,
      refreshToken: process.env.ZOHO_REFRESH_TOKEN,
      baseURL: "https://www.zohoapis.com/crm/v2",
    };
  }

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
      console.log("✅ Token obtenido para sincronización de Ciudades");
      return token;
    } catch (error) {
      console.error(
        "❌ Error al obtener token para Ciudades:",
        error.response?.data || error.message
      );
      throw error;
    }
  }

  async getZohoCities(accessToken) {
    let allCities = [];
    let hasMoreRecords = true;
    let page = 1;
    const limit = 200;

    console.log("ℹ️ Obteniendo ciudades desde Zoho (con paginación)...");

    while (hasMoreRecords) {
      const query = {
        select_query: `SELECT Ciudad.Name, Ciudad.id FROM Proyectos_Comerciales WHERE Ciudad is not null limit ${
          (page - 1) * limit
        }, ${limit}`,
      };
      try {
        const response = await axios.post(
          `${this.zohoConfig.baseURL}/coql`,
          query,
          {
            headers: {
              Authorization: `Zoho-oauthtoken ${accessToken}`,
              "Content-Type": "application/json",
            },
          }
        );
        const data = response.data.data || [];
        if (data.length > 0) {
          allCities = allCities.concat(data);
        }
        hasMoreRecords = response.data.info?.more_records || false;
        if (hasMoreRecords) page++;
      } catch (error) {
        console.error(
          `❌ Error al obtener la página ${page} de ciudades desde Zoho:`,
          error.response?.data || error.message
        );
        throw error;
      }
    }
    console.log(
      `✅ ${allCities.length} registros de ciudad recuperados de Zoho en total.`
    );
    return allCities;
  }

  async syncCityInPostgres(client, city) {
    const cityId = city["Ciudad.id"]?.toString();
    const fullCityName = city["Ciudad.Name"];

    if (!cityId || !fullCityName) {
      return {
        success: false,
        error: new Error("Registro de ciudad inválido, faltan 'id' o 'name'."),
      };
    }
    const cityName = fullCityName.split("/")[0].trim();
    if (!cityName) {
      return {
        success: false,
        error: new Error(
          `Nombre de ciudad vacío después de limpiar: "${fullCityName}"`
        ),
      };
    }
    const newCityName =
      cityName.charAt(0).toUpperCase() + cityName.slice(1).toLowerCase();

    try {
      const upsertQuery = `
                INSERT INTO public."Cities" (id, "name", is_public)
                VALUES ($1, $2, $3)
                ON CONFLICT (id) DO UPDATE SET
                    "name" = EXCLUDED."name",
                    is_public = CASE
                                  WHEN public."Cities".is_public IS NOT NULL
                                  THEN public."Cities".is_public
                                  ELSE EXCLUDED.is_public
                                END;                    
            `;
      await client.query(upsertQuery, [cityId, newCityName, false]);
      return { success: true };
    } catch (dbError) {
      return { success: false, error: dbError };
    }
  }

  async run() {
    const reporte = crearReporteDeTarea("Sincronización de Ciudades");
    let client;

    try {
      console.log(`🚀 Iniciando tarea: ${reporte.tarea}...`);
      const token = await this.getZohoAccessToken();

      // FASE 1: MARCAR
      const allCitiesFromZoho = await this.getZohoCities(token);
      reporte.metricas.obtenidos = allCitiesFromZoho.length;

      const uniqueCitiesMap = new Map();
      allCitiesFromZoho.forEach((city) => {
        if (city["Ciudad.id"]) {
          uniqueCitiesMap.set(city["Ciudad.id"].toString(), city);
        }
      });
      const uniqueCities = Array.from(uniqueCitiesMap.values());
      const allActiveCityIds = new Set(uniqueCitiesMap.keys());

      console.log(
        `✅ IDs recopilados: ${allActiveCityIds.size} ciudades únicas activas.`
      );
      reporte.metricas.procesados = allActiveCityIds.size;

      // FASE 2: SINCRONIZAR
      console.log(
        "🔄 Fase 2: Sincronizando (Insertar/Actualizar) datos de ciudades..."
      );
      client = await this.pool.connect();

      for (const city of uniqueCities) {
        const result = await this.syncCityInPostgres(client, city);
        if (result.success) {
          reporte.metricas.exitosos++;
        } else {
          reporte.metricas.fallidos++;
          reporte.erroresDetallados.push({
            referencia: `Ciudad ID: ${city["Ciudad.id"] || "N/A"}`,
            nombre: city["Ciudad.Name"] || "N/A",
            motivo: result.error.message,
          });
        }
      }

      // FASE 3: BARRER
      console.log(
        "🧹 Fase 3: Eliminando ciudades obsoletas de la base de datos..."
      );

      let deleteQueryResult;
      if (allActiveCityIds.size > 0) {
        const idsToDelete = Array.from(allActiveCityIds)
          .map((id) => `'${id}'`)
          .join(",");
        const deleteQuery = `DELETE FROM public."Cities" WHERE id NOT IN (${idsToDelete})`;
        deleteQueryResult = await client.query(deleteQuery);
      } else {
        console.warn(
          "⚠️ No se encontraron ciudades activas en Zoho. Se eliminarán todos los registros existentes."
        );
        deleteQueryResult = await client.query('DELETE FROM public."Cities"');
      }

      reporte.metricas.eliminados = deleteQueryResult.rowCount;
      if (deleteQueryResult.rowCount > 0) {
        console.log(
          `✅ ${deleteQueryResult.rowCount} ciudades obsoletas eliminadas.`
        );
      } else {
        console.log("✅ No se encontraron ciudades obsoletas para eliminar.");
      }

      reporte.estado =
        reporte.metricas.fallidos > 0 ? "finalizado_con_errores" : "exitoso";
      console.log(
        `✅ Tarea '${reporte.tarea}' finalizada con estado: ${reporte.estado}`
      );
    } catch (error) {
      console.error(
        `🚨 ERROR CRÍTICO en '${reporte.tarea}'. La tarea se detuvo.`,
        error
      );
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

module.exports = CitiesSync;
