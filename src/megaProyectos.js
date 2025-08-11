require("dotenv").config();
const { Pool } = require("pg");
const axios = require("axios");

class ZohoToPostgresSync {
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

  // Obtener Token zoho
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
      console.log("✅ Token obtenido para Mega Proyectos");
      return token;
    } catch (error) {
      console.error(
        "❌ Error al obtener token para Mega Proyectos:",
        error.response?.data || error.message
      );
      throw error;
    }
  }

  // Obtener Datos de Mega Proyectos
  async getZohoProjectData(accessToken, offset = 0) {
    
    const query = {
      select_query: `
                SELECT
                    id, Name, Direccion_MP, Slogan_comercial, Descripcion,
                    Record_Image, Latitud_MP, Longitud_MP
                FROM Mega_Proyectos
                WHERE (((((((Mega_proyecto_comercial = true) and Name is not null) and Direccion_MP is not null) and Slogan_comercial is not null) and Descripcion is not null ) and Latitud_MP is not null) and Longitud_MP is not null)
                LIMIT ${offset}, 200
            `,
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
      const info = response.data.info;
      const data = response.data.data || [];
      console.log(
        `✅ Recuperados ${data.length} Mega Proyectos de Zoho (offset ${offset})`
      );
      return {
        data,
        more: info?.more_records === true,
        count: info?.count || 0,
      };
    } catch (error) {
      console.error(
        "❌ Error al ejecutar COQL para Mega Proyectos:",
        error.response?.data || error.message
      );
      throw error;
    }
  }

  // Obtener Atributos
  async getAttributesFromZoho(accessToken, parentId) {
    try {
      const response = await axios.get(
        `${this.zohoConfig.baseURL}/Atributos_Mega_Proyecto/search?criteria=Parent_Id.id:equals:${parentId}`,
        {
          headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
          validateStatus: (status) => [200, 204].includes(status),
        }
      );
      // === CORREGIDO === Devolvemos un array vacío si no hay datos para consistencia.
      if (response.status === 204 || !response.data?.data) {
        return [];
      }
      return response.data.data;
    } catch (error) {
      console.error(
        `❌ Error CRÍTICO al intentar obtener atributos para Mega Proyecto ID ${parentId}:`,
        error.response?.data || error.message
      );
      throw error;
    }
  }

  // =========================================================================
  // == FUNCIÓN PRINCIPAL DE MEGA PROYECTOS ==
  // =========================================================================
  async insertMegaProjectIntoPostgres(project, accessToken) {
    if (!project || !project.id) {
      console.log(
        "⚠️ Se intentó insertar un Mega Proyecto inválido o sin ID. Omitiendo."
      );
      return;
    }
    const client = await this.pool.connect();
    try {
      // === CONSULTA SQL COMPLETA ===
      const insertQuery = `
                INSERT INTO public."Mega_Projects" (
                    id, slug, "name", address, slogan, description, seo_title,
                    seo_meta_description, "attributes", gallery, latitude, longitude, is_public
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                ON CONFLICT (id) DO UPDATE SET 
                    slug = EXCLUDED.slug,
                    "name" = EXCLUDED.name,
                    address = EXCLUDED.address,
                    slogan = EXCLUDED.slogan,
                    description = EXCLUDED.description,
                    seo_title = EXCLUDED.seo_title,
                    seo_meta_description = EXCLUDED.seo_meta_description,
                    "attributes" = EXCLUDED."attributes",
                    gallery = EXCLUDED.gallery,
                    latitude = EXCLUDED.latitude,
                    longitude = EXCLUDED.longitude,
                    is_public = CASE 
                        WHEN public."Mega_Projects".is_public IS NOT NULL 
                        THEN public."Mega_Projects".is_public 
                        ELSE EXCLUDED.is_public
                    END;
            `;

      // --- Preparación de datos ---
      const attributesData = await this.getAttributesFromZoho(accessToken, project.id);
      
      const attributeIds = attributesData
        .map((attr) => attr.Atributo?.id)
        .filter(Boolean);

      
      // Crea un slug a partir del nombre y le añade el ID para garantizar que sea único.      
      // const slug = `${nameForSlug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}-${project.id}`;
      const nameForSlug = project.Name || 'sin-nombre';
      const slug = nameForSlug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      
      // Manejo correcto de JSONB para la galería.
      const galleryJson = project.Record_Image 
        ? JSON.stringify([project.Record_Image]) // Si hay imagen, la pone en un array JSON
        : '[]'; // Si no, un array JSON vacío.

      // === ARRAY DE VALORES COMPLETO ===
      const values = [
        /* $1  id */ project.id,
        /* $2  slug */ slug,
        /* $3  name */ project.Name || '',
        /* $4  address */ project.Direccion_MP || '',
        /* $5  slogan */ project.Slogan_comercial || '',
        /* $6  description */ project.Descripcion || '',
        /* $7  seo_title */ null, // Columna nueva, valor por defecto
        /* $8  seo_meta_description */ null, // Columna nueva, valor por defecto
        /* $9  attributes */ JSON.stringify(attributeIds), // JSONB
        /* $10 gallery */ galleryJson, // JSONB
        /* $11 latitude */ (parseFloat(project.Latitud_MP) || 0).toString(), // TEXT
        /* $12 longitude */ (parseFloat(project.Longitud_MP) || 0).toString(), // TEXT
        /* $13 is_public */ false, // Booleano por defecto
      ];

      await client.query(insertQuery, values);
      console.log(
        `✅ Mega Proyecto insertado/actualizado (ID: ${project.id}): ${project.Name}`
      );
    } catch (error) {
      console.error(
        `❌ Error procesando Mega Proyecto ID ${project?.id} (${project?.Name}):`,
        error.message
      );
    } finally {
      client.release();
    }
  }

  // Método principal de sincronización
  async run() {
    try {
      console.log("🚀 Iniciando sincronización de Mega Proyectos...");
      const token = await this.getZohoAccessToken();

      let offset = 0;
      let more = true;
      while (more) {
        const { data: projects, more: hasMore } = await this.getZohoProjectData(
          token,
          offset
        );
        if (!projects || projects.length === 0) break;

        // Procesa los proyectos en paralelo para mayor eficiencia
        const processingPromises = projects.map((project) =>
          this.insertMegaProjectIntoPostgres(project, token)
        );
        await Promise.all(processingPromises);

        more = hasMore;
        offset += 200;
      }
      console.log(`✅ Sincronización de Mega Proyectos finalizada.`);
    } catch (error) {
      console.error(
        "🚨 ERROR CRÍTICO durante la sincronización de Mega Proyectos. El proceso se detuvo.",
        error
      );
    } finally {
      if (this.pool) {
        await this.pool.end();
        console.log(
          "🔌 Pool de conexiones PostgreSQL para Mega Proyectos cerrado."
        );
      }
    }
  }
}


module.exports = ZohoToPostgresSync;