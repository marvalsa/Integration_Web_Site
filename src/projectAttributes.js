require("dotenv").config();
const { Pool } = require("pg");
const axios = require("axios");

class ProjectAttributesSync {
  constructor() {
    this.pool = new Pool({
      host: process.env.PG_HOST,
      database: process.env.PG_DATABASE,
      user: process.env.PG_USER,
      password: process.env.PG_PASSWORD,
      port: process.env.PG_PORT || 5432,
      ssl:
        process.env.PG_SSL === "true" ? { rejectUnauthorized: false } : false,
    });

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

  // --- Paso 3: Insertar Atributos en PostgreSQL ---
  async insertAttributesIntoPostgres(attributes) {
    if (!attributes || attributes.length === 0) {
      console.log("ℹ️ No hay atributos para insertar en PostgreSQL.");
      return { processedCount: 0, errorCount: 0 };
    }
    const client = await this.pool.connect();
    let processedCount = 0;
    let errorCount = 0;

    try {
      console.log(
        `ℹ️ Iniciando procesamiento de ${attributes.length} atributos en PostgreSQL...`
      );
      for (const attr of attributes) {
        // Validación más estricta para cumplir con NOT NULL de la DB.
        if (!attr.id || !attr.Nombre_atributo || !attr.Icon_cdn_google) {
          console.warn(
            `⚠️ Atributo inválido (falta id, nombre o icono): ${JSON.stringify(
              attr
            )}. Omitiendo.`
          );
          errorCount++;
          continue;
        }
        
        const upsertQuery = `
                    INSERT INTO public."Project_Attributes" (id, "name", icon)
                    VALUES ($1, $2, $3)
                    ON CONFLICT (id) DO UPDATE SET
                        name = EXCLUDED.name,
                        icon = EXCLUDED.icon;
                `;

        // Se asegura de que icon nunca sea null, usando un string vacío como default.
        const iconValue = attr.Icon_cdn_google ? attr.Icon_cdn_google.toLowerCase() : '';

        const values = [
          attr.id.toString(),
          attr.Nombre_atributo,
          iconValue,
        ];
        
        const res = await client.query(upsertQuery, values);

        if (res.rowCount > 0) {
          processedCount++;
        }
      }
      console.log(
        `✅ Procesamiento de atributos completado. ${processedCount} insertados/actualizados, ${errorCount} omitidos.`
      );
      return { processedCount, errorCount };
    } catch (error) {
      console.error(`❌ Error al procesar atributo en PostgreSQL:`, error);
      throw error;
    } finally {
      client.release();
    }
  }

  // --- Método principal para ejecutar la sincronización ---
  async run() {
    try {
      console.log("🚀 Iniciando sincronización de Atributos de Proyecto...");

      console.log(
        '🟡 Preparando para truncar la tabla "Project_Attributes"...'
      );
      const client = await this.pool.connect();
      try {
        await client.query(
          'TRUNCATE TABLE public."Project_Attributes" RESTART IDENTITY CASCADE;'
        );
        console.log('✅ Tabla "Project_Attributes" truncada con éxito.');
      } finally {
        client.release();
      }

      const token = await this.getZohoAccessToken();
      const attributes = await this.getZohoAttributes(token);
      
      if (attributes.length > 0) {
        const result = await this.insertAttributesIntoPostgres(attributes);
        console.log(`✅ Sincronización de Atributos finalizada. ${result.processedCount} atributos procesados.`);
      } else {
        console.log("✅ Sincronización de Atributos finalizada. No se encontraron atributos para procesar.");
      }

    } catch (error) {
      console.error(
        "🚨 ERROR CRÍTICO durante la sincronización de Atributos.",
        error
      );
      throw error;
    } finally {
      if (this.pool) {
        await this.pool.end();
        console.log("🔌 Pool de conexiones para Atributos cerrado.");
      }
    }
  }
}

module.exports = ProjectAttributesSync;