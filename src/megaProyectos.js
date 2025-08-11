// src/megaProyectos.js
require("dotenv").config();
const axios = require("axios");
const { crearReporteDeTarea } = require('./reportBuilder'); // <<< 1. IMPORTAR NUESTRO CONSTRUCTOR

class MegaProjectsSync {
  constructor(dbPool) {
    if (!dbPool) {
      throw new Error(
        "Se requiere una instancia del pool de PostgreSQL para MegaProjectsSync."
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

  // <<< 2. AJUSTA `insertMegaProjectIntoPostgres` PARA QUE ACTUALICE EL REPORTE
  async insertMegaProjectIntoPostgres(project, accessToken, reporte) {
    if (!project || !project.id) {
      reporte.metricas.fallidos++;
      reporte.erroresDetallados.push({
          referencia: 'Proyecto sin ID',
          motivo: 'Se intentó procesar un Mega Proyecto inválido o sin ID.'
      });
      return; // Salimos de la función
    }

    const client = await this.pool.connect();
    try {
      const insertQuery = `
        INSERT INTO public."Mega_Projects" (
            id, slug, "name", address, slogan, description, seo_title,
            seo_meta_description, "attributes", gallery, latitude, longitude, is_public
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        ON CONFLICT (id) DO UPDATE SET 
            slug = EXCLUDED.slug, "name" = EXCLUDED.name, address = EXCLUDED.address,
            slogan = EXCLUDED.slogan, description = EXCLUDED.description,
            seo_title = EXCLUDED.seo_title, seo_meta_description = EXCLUDED.seo_meta_description,
            "attributes" = EXCLUDED.attributes, gallery = EXCLUDED.gallery,
            latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude,            
            is_public = CASE                
                WHEN public."Mega_Projects".is_public IS NOT NULL                
                THEN public."Mega_Projects".is_public                
                ELSE EXCLUDED.is_public
            END;
      `;     

      // La lógica para obtener atributos y preparar datos permanece igual
      const attributesData = await this.getAttributesFromZoho(accessToken, project.id);
      const attributeIds = attributesData.map((attr) => attr.Atributo?.id).filter(Boolean);
      const nameForSlug = project.Name || "sin-nombre";
      const slug = nameForSlug.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      const galleryJson = project.Record_Image ? JSON.stringify([project.Record_Image]) : "[]";

      const values = [
        project.id, slug, project.Name || "", project.Direccion_MP || "",
        project.Slogan_comercial || "", project.Descripcion || "", null, null,
        JSON.stringify(attributeIds), galleryJson,
        (parseFloat(project.Latitud_MP) || 0).toString(),
        (parseFloat(project.Longitud_MP) || 0).toString(),
        false,
      ];

      await client.query(insertQuery, values);
      
      // Si la query tiene éxito, contamos como exitoso
      reporte.metricas.exitosos++;

    } catch (error) {
      // Si la query falla, contamos como fallido y guardamos el error
      reporte.metricas.fallidos++;
      reporte.erroresDetallados.push({
          referencia: `Mega Proyecto ID: ${project.id}`,
          nombre: project.Name || 'N/A',
          motivo: `Error en Base de Datos: ${error.message}`
      });
    } finally {
      client.release();
    }
  }

  // <<< 3. `run()` USA EL NUEVO CONSTRUCTOR Y ORQUESTA LA LÓGICA
  async run() {
    // Creamos el reporte desde el constructor centralizado
    const reporte = crearReporteDeTarea("Sincronización de Mega Proyectos");

    try {
      console.log(`🚀 Iniciando tarea: ${reporte.tarea}...`);
      const token = await this.getZohoAccessToken();

      let offset = 0;
      let more = true;
      while (more) {
        const { data: projects, more: hasMore } = await this.getZohoProjectData(token, offset);
        if (!projects || projects.length === 0) break;

        // Actualizamos las métricas del reporte
        reporte.metricas.obtenidos += projects.length;
        reporte.metricas.procesados += projects.length; // En este caso, procesamos todos los que obtenemos

        // Creamos un array de promesas, pasando el reporte a cada llamada
        const processingPromises = projects.map((project) =>
          this.insertMegaProjectIntoPostgres(project, token, reporte)
        );
        // Esperamos a que todas las inserciones/actualizaciones terminen
        await Promise.all(processingPromises);

        more = hasMore;
        offset += 200;
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
    }
    
    return reporte; // Devolvemos el reporte estandarizado
  }
}

module.exports = MegaProjectsSync;