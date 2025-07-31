// src/projectAttributes.js
require("dotenv").config();
const axios = require("axios");
const { crearReporteDeTarea } = require('./reportBuilder'); // <<< 1. IMPORTAR

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

  // --- Paso 2: Obtener Atributos de Zoho ---
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
        console.log(`  > Solicitando página ${page} de atributos...`);
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
        if (hasMoreRecords) {
          page++;
        }
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
  
  // <<< 2. AJUSTAMOS `insertAttributesIntoPostgres` PARA QUE ACTUALICE EL REPORTE
  async insertAttributesIntoPostgres(attributes, reporte) {
    if (!attributes || attributes.length === 0) {
      return; // No hay nada que hacer
    }

    const client = await this.pool.connect();
    try {
      for (const attr of attributes) {
        if (!attr.id || !attr.Nombre_atributo || !attr.Icon_cdn_google) {
          reporte.metricas.fallidos++;
          reporte.erroresDetallados.push({
              referencia: JSON.stringify(attr),
              motivo: `Atributo inválido omitido (falta id, nombre o icono).`
          });
          continue;
        }

        try {
          const upsertQuery = `
              INSERT INTO public."Project_Attributes" (id, "name", icon)
              VALUES ($1, $2, $3)
              ON CONFLICT (id) DO UPDATE SET
                  name = EXCLUDED.name,
                  icon = EXCLUDED.icon;
            `;
          const iconValue = attr.Icon_cdn_google ? attr.Icon_cdn_google.toLowerCase() : "";
          const values = [attr.id.toString(), attr.Nombre_atributo, iconValue];
          const res = await client.query(upsertQuery, values);

          if (res.rowCount > 0) {
            reporte.metricas.exitosos++;
          }
        } catch (dbError) {
          reporte.metricas.fallidos++;
          reporte.erroresDetallados.push({
              referencia: `Atributo ID: ${attr.id}`,
              nombre: attr.Nombre_atributo,
              motivo: `Error en Base de Datos: ${dbError.message}`
          });
        }
      }
    } finally {
      client.release();
    }
  }

  // <<< 3. `run()` USA EL NUEVO CONSTRUCTOR Y ORQUESTA LA LÓGICA
  async run() {
    // Creamos el reporte desde el constructor centralizado
    const reporte = crearReporteDeTarea("Sincronización de Atributos de Proyecto");
    const client = await this.pool.connect();

    try {
      console.log(`🚀 Iniciando tarea: ${reporte.tarea}...`);
      
      // La operación de truncado es parte de la tarea.
      console.log('ℹ️ Truncando la tabla "Project_Attributes"...');
      await client.query('TRUNCATE TABLE public."Project_Attributes" RESTART IDENTITY CASCADE;');
      console.log('✅ Tabla "Project_Attributes" truncada con éxito.');

      const token = await this.getZohoAccessToken();
      const attributes = await this.getZohoAttributes(token);
      
      // Llenamos las métricas del reporte
      reporte.metricas.obtenidos = attributes.length;
      reporte.metricas.procesados = attributes.length;

      if (attributes.length > 0) {
        // Pasamos el reporte a la función de inserción para que lo llene
        await this.insertAttributesIntoPostgres(attributes, reporte);
      }

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
    } finally {
        client.release(); // Nos aseguramos de liberar el cliente del pool
    }
    
    return reporte; // Devolvemos el reporte estandarizado
  }
}

module.exports = ProjectAttributesSync;