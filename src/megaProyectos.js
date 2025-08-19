// src/megaProyectos.js
require("dotenv").config();
const axios = require("axios");
const { crearReporteDeTarea } = require("./reportBuilder"); // <<< 1. IMPORTAR NUESTRO CONSTRUCTOR

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
  async insertMegaProjectIntoPostgres(project, accessToken) {
    if (!project || !project.id) {
      console.warn(
        "⚠️ Se intentó procesar un Mega Proyecto inválido o sin ID. Omitiendo."
      );
      return {
        success: false,
        errorType: "invalid_data",
        message: "Mega Proyecto sin ID",
      };
    }

    const client = await this.pool.connect();
    const projectId = project.id.toString();

    try {
      // === CONSULTA SQL CON LÓGICA DE ACTUALIZACIÓN INTELIGENTE ===
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
            seo_title = CASE 
                        WHEN public."Mega_Projects".seo_title IS NOT NULL 
                        THEN public."Mega_Projects".seo_title 
                        ELSE EXCLUDED.seo_title
                    END,
            seo_meta_description = CASE 
                WHEN public."Mega_Projects".seo_meta_description IS NOT NULL 
                THEN public."Mega_Projects".seo_meta_description 
                ELSE EXCLUDED.seo_meta_description
            END,
            "attributes" = EXCLUDED.attributes,
            latitude = EXCLUDED.latitude, 
            longitude = EXCLUDED.longitude,           
            gallery = CASE                       
                      WHEN jsonb_typeof(public."Mega_Projects".gallery) = 'array' AND jsonb_array_length(public."Mega_Projects".gallery) > 0 
                      THEN public."Mega_Projects".gallery 
                      ELSE EXCLUDED.gallery 
                    END,            
            is_public = CASE 
                        WHEN public."Mega_Projects".is_public IS NOT NULL 
                        THEN public."Mega_Projects".is_public 
                        ELSE EXCLUDED.is_public
                    END;           
      `;

      // La lógica para obtener atributos y preparar datos permanece igual
      const attributesData = await this.getAttributesFromZoho(
        accessToken,
        project.id
      );
      const attributeIds = attributesData
        .map((attr) => attr.Atributo?.id)
        .filter(Boolean);
      const nameForSlug = project.Name || "sin-nombre";
      const slug = nameForSlug
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");

      // Construimos un array de objetos para la galería, más robusto que un simple string.
      const galleryData = project.Record_Image
        ? JSON.stringify([
            { id: project.Record_Image, url: project.Record_Image },
          ])
        : "[]";
      // Nombres de megaproyectos con ortografia [19/08/25]
      const nameMegaProject = (project.Name || "")
      .toLowerCase()
      .split(" ")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");

      const values = [
        /* $1  id */ projectId,
        /* $2  slug */ slug,
        /* $3  name */ nameMegaProject,
        /* $4  address */ project.Direccion_MP || "",
        /* $5  slogan */ project.Slogan_comercial || "",
        /* $6  description */ project.Descripcion || "",
        /* $7  seo_title */ null,
        /* $8  seo_meta_description */ null,
        /* $9  attributes */ JSON.stringify(attributeIds),
        /* $10 gallery */ galleryData,
        /* $11 latitude */ (parseFloat(project.Latitud_MP) || 0).toString(),
        /* $12 longitude */ (parseFloat(project.Longitud_MP) || 0).toString(),
        /* $13 is_public */ false,
      ];

      await client.query(insertQuery, values);
      return { success: true };
    } catch (error) {
      console.error(
        `❌ Error procesando Mega Proyecto ID ${projectId} (${project.Name}):`,
        error.message
      );
      return { success: false, errorType: "db_error", message: error.message };
    } finally {
      client.release();
    }
  }

  // --- MÉTODO 'RUN' LÓGICA DE SINCRONIZACIÓN COMPLETA ---
  async run() {
    const reporte = {
      ...crearReporteDeTarea("Sincronización de Mega Proyectos"),
      metricas: {
        obtenidos: 0,
        procesados: 0,
        exitosos: 0,
        fallidos: 0,
        eliminados: 0, // << Nueva métrica para el reporte
      },
    };

    let client; // Definimos el cliente fuera para usarlo en el bloque finally

    try {
      console.log(`🚀 Iniciando tarea: ${reporte.tarea}...`);
      const token = await this.getZohoAccessToken();

      // --- FASE 1: MARCAR (RECOPILAR TODOS LOS IDs ACTIVOS DE ZOHO) ---
      const allActiveMegaProjectIds = new Set();
      let offset = 0;
      let more = true;

      console.log(
        "🔍 Fase 1: Recopilando todos los IDs activos de Mega Proyectos desde Zoho..."
      );
      while (more) {
        const { data: projects, more: hasMore } = await this.getZohoProjectData(
          token,
          offset
        );
        if (!projects || projects.length === 0) break;

        projects.forEach((project) => {
          if (project.id) {
            allActiveMegaProjectIds.add(project.id.toString());
          }
        });

        more = hasMore;
        offset += 200;
      }
      console.log(
        `✅ IDs recopilados: ${allActiveMegaProjectIds.size} Mega Proyectos activos.`
      );
      reporte.metricas.obtenidos = allActiveMegaProjectIds.size;

      // --- FASE 2: SINCRONIZAR (INSERTAR/ACTUALIZAR) REGISTROS ---
      console.log("🔄 Fase 2: Sincronizando (Insertar/Actualizar) datos...");
      offset = 0;
      more = true;
      while (more) {
        const { data: projectsToProcess, more: hasMore } =
          await this.getZohoProjectData(token, offset);
        if (!projectsToProcess || projectsToProcess.length === 0) break;

        reporte.metricas.procesados += projectsToProcess.length;

        for (const project of projectsToProcess) {
          const result = await this.insertMegaProjectIntoPostgres(
            project,
            token
          );
          if (result.success) {
            reporte.metricas.exitosos++;
          } else {
            reporte.metricas.fallidos++;
            reporte.erroresDetallados.push({
              referencia: `Mega Proyecto ID: ${project.id || "N/A"}`,
              nombre: project.Name || "N/A",
              motivo: result.message || result.errorType,
            });
          }
        }

        more = hasMore;
        offset += 200;
      }

      // --- FASE 3: BARRER (ELIMINAR REGISTROS OBSOLETOS) ---
      console.log(
        "🧹 Fase 3: Eliminando registros obsoletos de la base de datos..."
      );
      client = await this.pool.connect();

      let deleteQueryResult;
      if (allActiveMegaProjectIds.size > 0) {
        // Convierte el Set de IDs a un formato que SQL pueda usar en la cláusula IN
        const idsToDelete = Array.from(allActiveMegaProjectIds)
          .map((id) => `'${id}'`)
          .join(",");
        const deleteQuery = `DELETE FROM public."Mega_Projects" WHERE id NOT IN (${idsToDelete})`;
        deleteQueryResult = await client.query(deleteQuery);
      } else {
        // Caso especial: si Zoho no devuelve NINGÚN mega proyecto, los eliminamos todos.
        console.warn(
          "⚠️ No se encontraron Mega Proyectos activos en Zoho. Se eliminarán todos los registros existentes."
        );
        deleteQueryResult = await client.query(
          'DELETE FROM public."Mega_Projects"'
        );
      }

      reporte.metricas.eliminados = deleteQueryResult.rowCount;
      if (deleteQueryResult.rowCount > 0) {
        console.log(
          `✅ ${deleteQueryResult.rowCount} Mega Proyectos obsoletos eliminados.`
        );
      } else {
        console.log(
          "✅ No se encontraron Mega Proyectos obsoletos para eliminar."
        );
      }

      // Determinamos el estado final basado en las métricas
      reporte.estado =
        reporte.metricas.fallidos > 0 ? "finalizado_con_errores" : "exitoso";
      console.log(
        `✅ Tarea '${reporte.tarea}' finalizada con estado: ${reporte.estado}`
      );
    } catch (error) {
      console.error(
        `🚨 ERROR CRÍTICO en '${reporte.tarea}'. El proceso se detuvo.`,
        error
      );
      reporte.estado = "error_critico";
      reporte.erroresDetallados.push({
        motivo: "Error general en la ejecución de la tarea",
        detalle: error.message,
      });
    } finally {
      if (client) client.release(); // Nos aseguramos de liberar el cliente de la base de datos
    }

    return reporte;
  }
}

module.exports = MegaProjectsSync;
