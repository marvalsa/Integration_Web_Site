// src/projectAttributes.js
require("dotenv").config();
const axios = require("axios");
const { crearReporteDeTarea } = require("./reportBuilder");

class ProjectAttributesSync {
  constructor(dbPool) {
    if (!dbPool) {
      throw new Error(
        "Se requiere una instancia del pool de PostgreSQL para ProjectAttributesSync."
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
      if (!token) throw new Error("Access token no recibido");
      console.log("✅ Token obtenido para sincronización de Atributos");
      return token;
    } catch (error) {
      console.error(
        "❌ Error al obtener token para Atributos:",
        error.response?.data || error.message
      );
      throw error;
    }
  }

  async getZohoAttributes(accessToken) {
    let allAttributes = [];
    let hasMoreRecords = true;
    let page = 1;
    const limit = 200;
    console.log("ℹ️ Obteniendo atributos desde Zoho (con paginación)...");
    while (hasMoreRecords) {
      const query = {
        select_query: `select id, Nombre_atributo, Icon_cdn_google FROM Parametros WHERE (((Tipo = 'Atributo') and Nombre_atributo is not null) and Icon_cdn_google is not null) limit ${
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
          allAttributes = allAttributes.concat(data);
        }
        hasMoreRecords = response.data.info?.more_records || false;
        if (hasMoreRecords) page++;
      } catch (error) {
        console.error(
          `❌ Error al obtener la página ${page} de atributos desde Zoho:`,
          error.response?.data || error.message
        );
        throw error;
      }
    }
    console.log(
      `✅ ${allAttributes.length} atributos recuperados de Zoho en total.`
    );
    return allAttributes;
  }

  async syncAttributeInPostgres(client, attribute) {
    if (
      !attribute.id ||
      !attribute.Nombre_atributo ||
      !attribute.Icon_cdn_google
    ) {
      const errorMsg = `Atributo inválido omitido (falta id, nombre o icono). Data: ${JSON.stringify(
        attribute
      )}`;
      return { success: false, error: new Error(errorMsg) };
    }
    try {
      const upsertQuery = `
              INSERT INTO public."Project_Attributes" (id, "name", icon)
              VALUES ($1, $2, $3)
              ON CONFLICT (id) DO UPDATE SET
                  name = EXCLUDED.name,
                  icon = EXCLUDED.icon;                  
            `;
      const iconValue = attribute.Icon_cdn_google
        ? attribute.Icon_cdn_google.toLowerCase()
        : "";
      const values = [
        attribute.id.toString(),
        attribute.Nombre_atributo,
        iconValue,
      ];
      await client.query(upsertQuery, values);
      return { success: true };
    } catch (dbError) {
      return { success: false, error: dbError };
    }
  }

  async run() {
    const reporte = crearReporteDeTarea(
      "Sincronización de Atributos de Proyecto"
    );
    let client;

    try {
      console.log(`🚀 Iniciando tarea: ${reporte.tarea}...`);
      const token = await this.getZohoAccessToken();

      // FASE 1: MARCAR
      const allAttributesFromZoho = await this.getZohoAttributes(token);
      reporte.metricas.obtenidos = allAttributesFromZoho.length;
      reporte.metricas.procesados = allAttributesFromZoho.length;
      const allActiveAttributeIds = new Set(
        allAttributesFromZoho.map((attr) => attr.id.toString())
      );
      console.log(
        `✅ IDs recopilados: ${allActiveAttributeIds.size} atributos activos.`
      );

      // FASE 2: SINCRONIZAR
      console.log(
        "🔄 Fase 2: Sincronizando (Insertar/Actualizar) datos de atributos..."
      );
      client = await this.pool.connect();
      for (const attribute of allAttributesFromZoho) {
        const result = await this.syncAttributeInPostgres(client, attribute);
        if (result.success) {
          reporte.metricas.exitosos++;
        } else {
          reporte.metricas.fallidos++;
          reporte.erroresDetallados.push({
            referencia: `Atributo ID: ${attribute.id || "N/A"}`,
            nombre: attribute.Nombre_atributo || "N/A",
            motivo: result.error.message,
          });
        }
      }

      // FASE 3: BARRER
      console.log(
        "🧹 Fase 3: Eliminando atributos obsoletos de la base de datos..."
      );
      let deleteQueryResult;
      if (allActiveAttributeIds.size > 0) {
        const idsToDelete = Array.from(allActiveAttributeIds)
          .map((id) => `'${id}'`)
          .join(",");
        const deleteQuery = `DELETE FROM public."Project_Attributes" WHERE id NOT IN (${idsToDelete})`;
        deleteQueryResult = await client.query(deleteQuery);
      } else {
        console.warn(
          "⚠️ No se encontraron atributos activos en Zoho. Se eliminarán todos los registros existentes."
        );
        deleteQueryResult = await client.query(
          'DELETE FROM public."Project_Attributes"'
        );
      }
      reporte.metricas.eliminados = deleteQueryResult.rowCount;
      if (deleteQueryResult.rowCount > 0) {
        console.log(
          `✅ ${deleteQueryResult.rowCount} atributos obsoletos eliminados.`
        );
      } else {
        console.log("✅ No se encontraron atributos obsoletos para eliminar.");
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

module.exports = ProjectAttributesSync;
