require("dotenv").config();
const { Pool } = require("pg");
const axios = require("axios");
const { Storage } = require("@google-cloud/storage");

class ZohoToPostgresSyncProjects {
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
      baseURL: "https://www.zohoapis.com/crm/v7", // <-- El usuario mencionó v7, pero la base es v2. Se usa esta.
    };

    try {
      this.storage = new Storage();
      this.bucket = this.storage.bucket(process.env.GCS_BUCKET_NAME);
      console.log(
        `✅ Conectado al bucket de GCS: ${process.env.GCS_BUCKET_NAME}`
      );
    } catch (error) {
      console.error("❌ Error al inicializar Google Cloud Storage:", error);
      throw new Error("No se pudo conectar con GCS. Revisa las credenciales.");
    }
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
      console.log("✅ Token obtenido para la sincronización completa");
      return token;
    } catch (error) {
      console.error(
        "❌ Error al obtener token de Zoho:",
        error.response?.data || error.message
      );
      throw error;
    }
  }

  async getZohoProjects(accessToken, offset = 0) {
    const coqlQueryObject = {
      select_query: `
                SELECT
                    id, Name, Slogan, Direccion, Descripcion_corta, Descripcion_larga,
                    SIG, Sala_de_ventas.Name, Cantidad_SMMLV, Descripcion_descuento,
                    Precios_desde, Precios_hasta, Tipo_de_proyecto, Mega_Proyecto.id,
                    Estado, Proyecto_destacado, Area_construida_desde, Area_construida_hasta,
                    Habitaciones, Ba_os, Latitud, Longitud, Ciudad.Name, Sala_de_ventas.id, Slug,
                    Precio_en_SMMLV
                FROM Proyectos_Comerciales
                WHERE id is not null
                LIMIT ${offset}, 200
            `,
    };
    try {
      const response = await axios.post(
        `${this.zohoConfig.baseURL}/coql`,
        coqlQueryObject,
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
        `✅ Recuperados ${data.length} proyectos de Zoho (offset ${offset})`
      );
      return {
        data,
        more: info?.more_records === true,
        count: info?.count || 0,
      };
    } catch (error) {
      console.error(
        "❌ Error al ejecutar COQL para Proyectos:",
        error.response?.data || error.message
      );
      throw error;
    }
  }
  // Proyectos relacionados [24/07/25]
  async getRelatedProjectIds(accessToken, projectId) {
    if (!projectId) {
      return [];
    }
    const relatedListApiName = "Proyectos_comerciales_relacionados";
    const apiUrl = `${this.zohoConfig.baseURL}/Proyectos_Comerciales/${projectId}`;

    try {
      const response = await axios.get(apiUrl, {
        headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
      });
      const projectDetails = response.data?.data?.[0];
      const relatedProjectsArray = projectDetails?.[relatedListApiName];
      if (
        !Array.isArray(relatedProjectsArray) ||
        relatedProjectsArray.length === 0
      ) {
        return [];
      }
      const ids = relatedProjectsArray
        .map((relationshipObject) => {
          const relatedProjectObject = Object.values(relationshipObject).find(
            (value) =>
              typeof value === "object" &&
              value !== null &&
              value.id &&
              value.name
          );
          return relatedProjectObject?.id;
        })
        .filter(Boolean);
      return ids;
    } catch (error) {
      if (error.response?.status !== 404) {
        console.error(
          `❌ Error al obtener proyectos relacionados para el ID ${projectId}:`,
          error.response?.data || error.message
        );
      }
      return [];
    }
  }

  async getProjectAttributes(accessToken, parentId) {
    try {
      const response = await axios.get(
        `${this.zohoConfig.baseURL}/Atributos/search?criteria=(Parent_Id.id:equals:${parentId})`,
        {
          headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
          validateStatus: (status) => [200, 204].includes(status),
        }
      );
      if (response.status === 204 || !response.data?.data) {
        return null;
      }
      return response.data.data
        .map((attr) => attr.Atributo?.id)
        .filter(Boolean);
    } catch (error) {
      console.error(
        `❌ Error al obtener atributos:`,
        error.response?.data || error.message
      );
      throw error;
    }
  }

  async getSalesRoomDetails(accessToken, salesRoomId) {
    if (!salesRoomId) return null;
    try {
      const response = await axios.get(
        `${this.zohoConfig.baseURL}/Salas_de_venta/${salesRoomId}`,
        {
          headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
        }
      );

      if (response.data?.data?.[0]) {
        const details = response.data.data[0];
        return {
          Direccion: details.Direccion || null,
          Horario: details.Horario || null,
          Latitud_SV: details.Latitud_SV || null,
          Longitud_SV: details.Longitud_SV || null,
        };
      }
      return null;
    } catch (error) {
      console.error(
        `❌ Error al obtener detalles de la Sala de Ventas ID ${salesRoomId}:`,
        error.response?.data || error.message
      );
      return null;
    }
  }

  async insertProjectIntoPostgres(project, accessToken) {
    if (!project?.id) {
      console.warn(
        "⚠️ Se intentó insertar un proyecto inválido o sin ID. Omitiendo."
      );
      return { success: false, hc: null, errorType: "invalid_data" };
    }

    const client = await this.pool.connect();
    const hcValue = project.id.toString();

    // <-- AJUSTE 1: Llamamos a las nuevas funciones
    const [salesRoomDetails, attributeIdsArray, relatedProjectIds] =
      await Promise.all([
        this.getSalesRoomDetails(accessToken, project["Sala_de_ventas.id"]),
        this.getProjectAttributes(accessToken, hcValue),
        this.getRelatedProjectIds(accessToken, hcValue),
      ]);

    try {
      // <-- AJUSTE 1: Añadida la columna `relation_projects`
      const insertQuery = `
                INSERT INTO public."Projects" (
                    hc, name, slogan, address, small_description, long_description, sic,
                    salary_minimum_count, discount_description, price_from_general,
                    price_up_general, "type", mega_project_id, status, highlighted, built_area,
                    private_area, rooms, bathrooms, latitude, longitude, is_public, "attributes",
                    city, sales_room_address, sales_room_schedule_attention, sales_room_latitude, sales_room_longitude, slug,
                    relation_projects 
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30)
                ON CONFLICT (hc) DO UPDATE SET
                    name = EXCLUDED.name, slogan = EXCLUDED.slogan, address = EXCLUDED.address,
                    small_description = EXCLUDED.small_description, long_description = EXCLUDED.long_description, sic = EXCLUDED.sic,
                    salary_minimum_count = EXCLUDED.salary_minimum_count, discount_description = EXCLUDED.discount_description,
                    price_from_general = EXCLUDED.price_from_general, price_up_general = EXCLUDED.price_up_general,
                    "type" = EXCLUDED.type, mega_project_id = EXCLUDED.mega_project_id, status = EXCLUDED.status,
                    highlighted = EXCLUDED.highlighted, built_area = EXCLUDED.built_area, private_area = EXCLUDED.private_area,
                    rooms = EXCLUDED.rooms, bathrooms = EXCLUDED.bathrooms, latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude,
                    is_public = EXCLUDED.is_public, "attributes" = EXCLUDED.attributes, city = EXCLUDED.city,
                    sales_room_address = EXCLUDED.sales_room_address, sales_room_schedule_attention = EXCLUDED.sales_room_schedule_attention,
                    sales_room_latitude = EXCLUDED.sales_room_latitude, sales_room_longitude = EXCLUDED.sales_room_longitude, slug = EXCLUDED.slug,
                    relation_projects = EXCLUDED.relation_projects;
            `;

      const statusMap = {
        "sobre planos": "1000000000000000001",
        "en construccion": "1000000000000000002",
        lanzamiento: "1000000000000000003",
        "entrega inmediata": "1000000000000000004",
      };
      const statusFromZoho = project.Estado?.toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .trim();
      const statusId = statusMap[statusFromZoho] || null;
      const statusForDb = statusId ? JSON.stringify([statusId]) : null;

      const attributesJson =
        attributeIdsArray?.length > 0
          ? JSON.stringify(attributeIdsArray)
          : null;

      // <-- AJUSTE 1: Convertir array de IDs de proyectos relacionados a formato JSONB
      const relatedProjectsJson =
        relatedProjectIds?.length > 0
          ? JSON.stringify(relatedProjectIds)
          : null;

      // <-- AJUSTE 2: Lógica para procesar el nombre de la ciudad
      const fullCityName = project["Ciudad.Name"];
      let cityName = null;
      if (fullCityName && typeof fullCityName === "string") {
        cityName = fullCityName.split("/")[0].trim().toUpperCase();
      }

      const roomsValue = Array.isArray(project.Habitaciones)
        ? Math.max(
            0,
            ...project.Habitaciones.map((n) => parseInt(n, 10)).filter(
              Number.isFinite
            )
          )
        : parseInt(project.Habitaciones, 10) || 0;

      const bathroomsValue = Array.isArray(project["Ba_os"])
        ? Math.max(
            0,
            ...project["Ba_os"]
              .map((n) => parseInt(n, 10))
              .filter(Number.isFinite)
          )
        : parseInt(project["Ba_os"], 10) || 0;

      // Ajuste [24/07/25] Mostrar campo si es true
      const salaryMinimumCount =
        project.Precio_en_SMMLV === true
          ? parseInt(project.Cantidad_SMMLV, 10) || null
          : null;

      const values = [
        hcValue,
        project.Name || null,
        project.Slogan || null,
        project.Direccion || null,
        project.Descripcion_corta || null,
        project.Descripcion_larga || null,
        project.SIG || null,
        // parseInt(project.Cantidad_SMMLV, 10) || null,
        salaryMinimumCount,
        project.Descripcion_descuento || null,
        parseInt(project.Precios_desde, 10) || null,
        parseInt(project.Precios_hasta, 10) || null,
        project.Tipo_de_proyecto || null,
        project["Mega_Proyecto.id"]
          ? project["Mega_Proyecto.id"].toString()
          : null,
        statusForDb,
        project.Proyecto_destacado || false,
        parseFloat(project.Area_construida_desde) || 0,
        parseFloat(project.Area_construida_hasta) || 0,
        roomsValue,
        bathroomsValue,
        parseFloat(project.Latitud) || 0,
        parseFloat(project.Longitud) || 0,
        true,
        attributesJson,
        cityName, // <-- AJUSTE 2: Usar el nombre de ciudad procesado
        salesRoomDetails?.Direccion || null,
        salesRoomDetails?.Horario || null,
        parseFloat(salesRoomDetails?.Latitud_SV) || null,
        parseFloat(salesRoomDetails?.Longitud_SV) || null,
        project.Slug || null,
        relatedProjectsJson,
      ];
      await client.query(insertQuery, values);
      console.log(
        `✅ Proyecto insertado/actualizado (HC: ${hcValue}): ${project.Name}`
      );
      return { success: true, hc: hcValue };
    } catch (error) {
      console.error(
        `❌ Error procesando proyecto HC ${hcValue} (${project?.Name}):`,
        error.message
      );
      return {
        success: false,
        hc: hcValue,
        errorType: "db_error",
        message: error.message,
      };
    } finally {
      client.release();
    }
  }

  async getTypologiesFromZoho(accessToken, parentId) {
    try {
      const response = await axios.get(
        `${this.zohoConfig.baseURL}/Tipologias/search?criteria=(Parent_Id.id:equals:${parentId})`,
        {
          headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
          validateStatus: (status) => [200, 204].includes(status),
        }
      );
      return response.data?.data || [];
    } catch (error) {
      console.error(
        `❌ Error al obtener tipologías del proyecto ${parentId}:`,
        error.response?.data || error.message
      );
      throw error;
    }
  }

  async insertTypologies(projectHc, typologies) {
    if (!typologies || typologies.length === 0) return;

    const client = await this.pool.connect();
    try {
      for (const t of typologies) {
        if (!t.id) continue;

        const availableUnits = parseInt(t.Und_Disponibles, 10);

        if (isNaN(availableUnits) || availableUnits < 1) {
          console.log(
            `ℹ️ Omitiendo tipología "${
              t.Nombre || t.id
            }" para proyecto ${projectHc} por no tener unidades disponibles (valor: ${
              t.Und_Disponibles
            }).`
          );
          continue;
        }

        const query = `
                    INSERT INTO public."Typologies" (
                        id, project_id, "name", description, price_from, rooms, bathrooms,
                        built_area, private_area, min_separation, min_deposit, delivery_time,
                        available_count
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                    ON CONFLICT (id) DO UPDATE SET
                        project_id = EXCLUDED.project_id, "name" = EXCLUDED.name, description = EXCLUDED.description,
                        price_from = EXCLUDED.price_from, rooms = EXCLUDED.rooms, bathrooms = EXCLUDED.bathrooms,
                        built_area = EXCLUDED.built_area, private_area = EXCLUDED.private_area,
                        min_separation = EXCLUDED.min_separation, min_deposit = EXCLUDED.min_deposit,
                        delivery_time = EXCLUDED.delivery_time, available_count = EXCLUDED.available_count;
                `;

        const values = [
          t.id.toString(),
          projectHc.toString(),
          t.Nombre || null,
          t.Descripci_n || null,
          parseInt(t.Precio_desde, 10) || null,
          parseInt(t.Habitaciones, 10) || 0,
          parseInt(t.Ba_os, 10) || 0,
          parseFloat(t.Area_construida) || 0,
          parseFloat(t.Area_privada) || 0,
          parseInt(t.Separacion, 10) || null,
          parseInt(t.Cuota_inicial1, 10) || null,
          parseInt(t.Plazo_en_meses, 10) || null,
          availableUnits,
        ];
        await client.query(query, values);
      }
    } catch (error) {
      console.error(
        `❌ Error insertando tipologías para proyecto ${projectHc}:`,
        error.message
      );
    } finally {
      client.release();
    }
  }

  async getGCSFilePublicUrls(directoryPath) {
    try {
      const [files] = await this.bucket.getFiles({ prefix: directoryPath });
      return files
        .filter((file) => !file.name.endsWith("/"))
        .map(
          (file) =>
            `https://storage.googleapis.com/${this.bucket.name}/${file.name}`
        );
    } catch (error) {
      console.error(
        `❌ Error al obtener URLs públicas de GCS para la ruta ${directoryPath}:`,
        error.message
      );
      return [];
    }
  }

  async syncProjectFilesInGCS(projectId, typologies) {
    if (!projectId) return;
    const projectIdStr = projectId.toString();

    const galleryPath = `projects/${projectIdStr}/gallery/`;
    const plansPath = `projects/${projectIdStr}/urban_plans/`;

    const minDeliveryTime = Math.min(
      ...typologies.map((t) => parseInt(t.Plazo_en_meses, 10) || Infinity)
    );
    const minDeposit = Math.min(
      ...typologies.map((t) => parseInt(t.Cuota_inicial1, 10) || Infinity)
    );

    const [galleryUrls, plansUrls] = await Promise.all([
      this.getGCSFilePublicUrls(galleryPath),
      this.getGCSFilePublicUrls(plansPath),
    ]);

    const client = await this.pool.connect();
    try {
      const updateQuery = `
                UPDATE public."Projects"
                SET gallery = $1, urban_plans = $2, delivery_time = $3, deposit = $4
                WHERE hc = $5;
            `;
      await client.query(updateQuery, [
        galleryUrls.length > 0 ? JSON.stringify(galleryUrls) : null,
        plansUrls.length > 0 ? JSON.stringify(plansUrls) : null,
        minDeliveryTime !== Infinity ? minDeliveryTime : null,
        minDeposit !== Infinity ? minDeposit : null,
        projectIdStr,
      ]);
    } catch (error) {
      console.error(
        `❌ Error al actualizar el proyecto ${projectIdStr} con las URLs de GCS:`,
        error
      );
    } finally {
      client.release();
    }
  }

  async run() {
    try {
      console.log(
        "🚀 Iniciando sincronización de Proyectos, Tipologías y Archivos GCS..."
      );

      const token = await this.getZohoAccessToken();

      console.log('🟡 Preparando para truncar la tabla "Typologies"...');
      const client = await this.pool.connect();
      try {
        await client.query(
          'TRUNCATE TABLE public."Typologies" RESTART IDENTITY CASCADE;'
        );
        console.log('✅ Tabla "Typologies" truncada con éxito.');
      } finally {
        client.release();
      }

      let offset = 0;
      let more = true;
      while (more) {
        const { data: projectsFromZoho, more: hasMore } =
          await this.getZohoProjects(token, offset);
        if (!projectsFromZoho || projectsFromZoho.length === 0) break;

        for (const project of projectsFromZoho) {
          const insertResult = await this.insertProjectIntoPostgres(
            project,
            token
          );
          if (insertResult.success) {
            const typologies = await this.getTypologiesFromZoho(
              token,
              insertResult.hc
            );
            await this.syncProjectFilesInGCS(insertResult.hc, typologies);
            if (typologies.length > 0) {
              await this.insertTypologies(insertResult.hc, typologies);
            }
          } else {
            console.error(
              `🚨 Fallo al procesar el proyecto HC: ${project.id}. Razón: ${insertResult.message}. Omitiendo dependencias.`
            );
          }
        }
        more = hasMore;
        offset += 200;
      }
      console.log("✅ Sincronización finalizada.");
    } catch (errorGeneral) {
      console.error(
        "🚨 ERROR CRÍTICO GENERAL. El proceso se detuvo.",
        errorGeneral
      );
    } finally {
      if (this.pool) {
        console.log("🔌 Cerrando pool de conexiones PostgreSQL...");
        await this.pool.end();
      }
    }
  }
}

module.exports = ZohoToPostgresSyncProjects;
