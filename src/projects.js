// src/projects.js
require("dotenv").config();
const axios = require("axios");
const { crearReporteDeTarea } = require("./reportBuilder");

class ZohoToPostgresSyncProjects {
  constructor(dbPool) {
    if (!dbPool) {
      throw new Error("Se requiere una instancia del pool de PostgreSQL.");
    }
    this.pool = dbPool;
    this.zohoConfig = {
      clientId: process.env.ZOHO_CLIENT_ID,
      clientSecret: process.env.ZOHO_CLIENT_SECRET,
      refreshToken: process.env.ZOHO_REFRESH_TOKEN,
      baseURL: "https://www.zohoapis.com/crm/v7",
    };
  }
  //Obtener token zoho crm
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

  //Obtener Proyectos Comerciales de CRM
  async getZohoProjects(accessToken, offset = 0) {
    const coqlQueryObject = {
      select_query: `
                SELECT id, Name, Slogan, Direccion, Descripcion_corta, Descripcion_larga, SIG, Sala_de_ventas.Name, Cantidad_SMMLV, Descripcion_descuento, Precios_desde, Precios_hasta, Tipo_de_proyecto, Mega_Proyecto.id, Estado, Proyecto_destacado, Area_construida_desde, Area_construida_hasta, Habitaciones, Ba_os, Latitud, Longitud, Ciudad.Name, Sala_de_ventas.id, Slug, Precio_en_SMMLV, bonus_ref FROM Proyectos_Comerciales 
                WHERE (((((((((((((((((((((id is not null) and Name is not null) and Slogan is not null) and Direccion is not null) and Descripcion_corta is not null) 
                  and Sala_de_ventas.Name is not null) and Cantidad_SMMLV is not null) and Precios_desde is not null) and Precios_hasta is not null) 
                  and Tipo_de_proyecto is not null) and Estado is not null) and Proyecto_destacado is not null) and Area_construida_desde is not null) 
                  and Area_construida_hasta is not null) and Habitaciones is not null) and Ba_os is not null) and Latitud is not null) and Longitud is not null) and Sala_de_ventas.id is not null) 
                  and Slug is not null) and Precio_en_SMMLV is not null)
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

  //Obtener estado del proyecto
  async getStatusObjectFromDb(stateName, client) {
    if (!stateName || typeof stateName !== "string") {
      return null;
    }
    const normalizedStateName = stateName.trim();
    const query = `
      SELECT id, name
      FROM public."Project_Status"
      WHERE LOWER(name) = LOWER($1)
      LIMIT 1;
    `;

    try {
      const result = await client.query(query, [normalizedStateName]);
      if (result.rows.length > 0) {
        const row = result.rows[0];
        return {
          id: row.id.toString(),
          name: row.name,
        };
      } else {
        console.warn(
          `⚠️ Estado no encontrado en la DB: "${stateName}". Se guardará como nulo.`
        );
        return null;
      }
    } catch (error) {
      console.error(
        `❌ Error al buscar el estado "${stateName}" en la base de datos:`,
        error
      );
      return null;
    }
  }

  //Obtener proyectos relacionados
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

  //Obtener atributos por proyecto
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
        return [];
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

  //Obtener detalles de sala de ventas
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

  // =========================================================================
  // == FUNCIÓN DE PROYECTOS ==
  // =========================================================================
  async insertProjectIntoPostgres(project, accessToken) {
    if (!project?.id) {
      console.warn(
        "⚠️ Se intentó insertar un proyecto inválido o sin ID. Omitiendo."
      );
      return { success: false, hc: null, errorType: "invalid_data" };
    }

    const client = await this.pool.connect();
    const hcValue = project.id.toString();

    try {
      const [salesRoomDetails, attributeIdsArray, relatedProjectIds] =
        await Promise.all([
          this.getSalesRoomDetails(accessToken, project["Sala_de_ventas.id"]),
          this.getProjectAttributes(accessToken, hcValue),
          this.getRelatedProjectIds(accessToken, hcValue),
        ]);

      // === CONSULTA SQL ===
      const insertQuery = `
        INSERT INTO public."Projects" (
            hc, "name", slug, slogan, address, city, small_description, long_description,
            seo_title, seo_meta_description, sic, sales_room_address, sales_room_schedule_attention,
            sales_room_latitude, sales_room_longitude, salary_minimum_count, delivery_time, deposit,
            discount_description, bonus_ref, price_from_general, price_up_general, "attributes",
            gallery, urban_plans, work_progress_images, tour_360, "type", status, highlighted,
            built_area, private_area, rooms, bathrooms, relation_projects, latitude, longitude,
            is_public, mega_project_id
        ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
            $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37, $38, $39
        )
        ON CONFLICT (hc) DO UPDATE SET
            "name" = EXCLUDED.name, slug = EXCLUDED.slug, slogan = EXCLUDED.slogan, address = EXCLUDED.address,
            city = EXCLUDED.city, small_description = EXCLUDED.small_description, long_description = EXCLUDED.long_description,
            seo_title = CASE 
                WHEN public."Projects".seo_title IS NOT NULL 
                THEN public."Projects".seo_title 
                ELSE EXCLUDED.seo_title 
            END,
            seo_meta_description = CASE 
                WHEN public."Projects".seo_meta_description IS NOT NULL 
                THEN public."Projects".seo_meta_description 
                ELSE EXCLUDED.seo_meta_description 
            END,
            sic = EXCLUDED.sic,
            sales_room_address = EXCLUDED.sales_room_address, sales_room_schedule_attention = EXCLUDED.sales_room_schedule_attention,
            sales_room_latitude = EXCLUDED.sales_room_latitude, sales_room_longitude = EXCLUDED.sales_room_longitude,
            salary_minimum_count = EXCLUDED.salary_minimum_count, delivery_time = EXCLUDED.delivery_time,
            deposit = EXCLUDED.deposit, discount_description = EXCLUDED.discount_description,
            bonus_ref = EXCLUDED.bonus_ref,
            price_from_general = EXCLUDED.price_from_general, price_up_general = EXCLUDED.price_up_general,
            "attributes" = EXCLUDED.attributes,
            gallery = CASE                       
                        WHEN jsonb_typeof(public."Projects".gallery) = 'array' AND jsonb_array_length(public."Projects".gallery) > 0 
                        THEN public."Projects".gallery 
                        ELSE EXCLUDED.gallery 
                      END,
            urban_plans = CASE                           
                            WHEN jsonb_typeof(public."Projects".urban_plans) = 'array' AND jsonb_array_length(public."Projects".urban_plans) > 0
                            THEN public."Projects".urban_plans 
                            ELSE EXCLUDED.urban_plans
                          END,
            work_progress_images = CASE                           
                            WHEN jsonb_typeof(public."Projects".work_progress_images) = 'array' AND jsonb_array_length(public."Projects".work_progress_images) > 0
                            THEN public."Projects".work_progress_images 
                            ELSE EXCLUDED.work_progress_images
                          END,
            tour_360 = CASE 
                            WHEN public."Projects".tour_360 IS NOT NULL 
                            THEN public."Projects".tour_360 
                            ELSE EXCLUDED.tour_360
                          END,
            "type" = EXCLUDED.type, status = EXCLUDED.status, highlighted = EXCLUDED.highlighted,
            built_area = EXCLUDED.built_area, private_area = EXCLUDED.private_area, rooms = EXCLUDED.rooms,
            bathrooms = EXCLUDED.bathrooms, relation_projects = EXCLUDED.relation_projects,
            latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude,            
            is_public = CASE 
                WHEN public."Projects".is_public IS NOT NULL 
                THEN public."Projects".is_public 
                ELSE EXCLUDED.is_public
            END,
            mega_project_id = EXCLUDED.mega_project_id;            
      `;

      // --- Preparación de datos ---
      const statusObject = await this.getStatusObjectFromDb(
        project.Estado,
        client
      );
      const statusForDb = statusObject
        ? JSON.stringify([statusObject.id])
        : "[]";
      const attributesJson = JSON.stringify(attributeIdsArray);
      const relatedProjectsJson = JSON.stringify(relatedProjectIds);

      const fullCityName = project["Ciudad.Name"];
      let cityName = "";
      if (fullCityName && typeof fullCityName === "string") {
        const cityNameParts = fullCityName.split("/");
        if (cityNameParts.length > 0) {
          const firstPart = cityNameParts[0].trim();
          cityName =
            firstPart.charAt(0).toUpperCase() +
            firstPart.slice(1).toLowerCase();
        }
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

      const salaryMinimumCount =
        project.Precio_en_SMMLV === true
          ? parseInt(project.Cantidad_SMMLV, 10) || 0
          : 0;

      // Ajuste de nombre de proyecto con ortografia [19/08/25]
      const nameProject = (project.Name || "")
        .toLowerCase()
        .split(" ")
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");

      // === ARRAY DE VALORES COMPLETO ===
      const values = [
        /* $1  hc */ hcValue,
        /* $2  name */ nameProject,
        /* $3  slug */ project.Slug || "",
        /* $4  slogan */ project.Slogan || "",
        /* $5  address */ project.Direccion || "",
        /* $6  city */ cityName,
        /* $7  small_description */ project.Descripcion_corta || "",
        /* $8  long_description */ project.Descripcion_larga || "",
        /* $9  seo_title */ null, // <-- Validar de que este campo exista en Zoho
        /* $10 seo_meta_description */ null, // <-- Validar de que este campo exista en Zoho
        /* $11 sic */ project.SIG || "",
        /* $12 sales_room_address */ salesRoomDetails?.Direccion || "",
        /* $13 sales_room_schedule_attention */ salesRoomDetails?.Horario || "",
        /* $14 sales_room_latitude */ (
          salesRoomDetails?.Latitud_SV || "0"
        ).toString(),
        /* $15 sales_room_longitude */ (
          salesRoomDetails?.Longitud_SV || "0"
        ).toString(),
        /* $16 salary_minimum_count */ salaryMinimumCount,
        /* $17 delivery_time */ 0, // Se calcula después
        /* $18 deposit */ 0, // Se calcula después
        /* $19 discount_description */ project.Descripcion_descuento || null,
        /* $20 bonus_ref */ project.bonus_ref || null,
        /* $21 price_from_general */ parseInt(project.Precios_desde, 10) || 0,
        /* $22 price_up_general */ parseInt(project.Precios_hasta, 10) || 0,
        /* $23 attributes */ attributesJson,
        /* $24 gallery */ "[]", // JSONB vacío
        /* $25 urban_plans */ "[]", // JSONB vacío
        /* $26 work_progress_images */ "[]", // JSONB vacío
        /* $27 tour_360 */ null, // <-- Validar de que este campo exista en Zoho
        /* $28 type */ project.Tipo_de_proyecto || "",
        /* $29 status */ statusForDb,
        /* $30 highlighted */ project.Proyecto_destacado || false,
        /* $31 built_area */ parseFloat(project.Area_construida_desde) || 0,
        /* $32 private_area */ parseFloat(project.Area_construida_hasta) || 0,
        /* $33 rooms */ roomsValue,
        /* $34 bathrooms */ bathroomsValue,
        /* $35 relation_projects */ relatedProjectsJson,
        /* $36 latitude */ (parseFloat(project.Latitud) || "0").toString(),
        /* $37 longitude */ (parseFloat(project.Longitud) || "0").toString(),
        /* $38 is_public */ false, // Valor por defecto
        /* $39 mega_project_id */ project["Mega_Proyecto.id"]
          ? project["Mega_Proyecto.id"].toString()
          : null,
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

  //Obtener Tipologias de proyectos
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

  // =========================================================================
  // == FUNCIÓN DE TIPOLOGÍAS (VERSIÓN MODIFICADA SIN ON CONFLICT) ==
  // =========================================================================
  async insertTypologies(projectHc, typologies) {
    if (!typologies || typologies.length === 0)
      return { success: true, processedIds: new Set() };

    const client = await this.pool.connect();
    const processedIds = new Set();

    try {
      for (const t of typologies) {
        if (!t.id || !t.Nombre) continue;

        const availableUnits = parseInt(t.Und_Disponibles, 10);
        if (isNaN(availableUnits) || availableUnits < 1) {
          console.log(
            `ℹ️ Omitiendo tipología "${t.Nombre}" (Proyecto ${projectHc}) por no tener unidades disponibles.`
          );
          continue;
        }
        // Paso 1: Verificar si la tipología ya existe para este proyecto y nombre
        const checkQuery = `
          SELECT id FROM public."Typologies" WHERE project_id = $1 AND "name" = $2 LIMIT 1;
        `;
        const checkResult = await client.query(checkQuery, [
          projectHc.toString(),
          t.Nombre,
        ]);

        const galleryData = "[]";
        const plansData = "";

        if (checkResult.rows.length > 0) {
          // --- Si EXISTE, la ACTUALIZAMOS ---
          const updateQuery = `
            UPDATE public."Typologies" SET
              id = $1,
              description = $2,
              price_from = $3,
              price_up = $4,
              rooms = $5,
              bathrooms = $6,
              built_area = $7,
              private_area = $8,
              min_separation = $9,
              min_deposit = $10,
              delivery_time = $11,
              available_count = $12,
              gallery = CASE                       
                        WHEN jsonb_typeof(public."Typologies".gallery) = 'array' AND jsonb_array_length(public."Typologies".gallery) > 0 
                        THEN public."Typologies".gallery 
                        ELSE $13
                      END,
              "plans" = CASE
                        WHEN "plans" IS NOT NULL
                        THEN "plans"
                        ELSE $14
                      END             
            WHERE project_id = $15 AND "name" = $16;
          `;
          const values = [
            /* $1 id */ t.id.toString(),
            /* $2 description */ t.Descripci_n || "",
            /* $3 price_from */ parseInt(t.Precio_desde, 10) || 0,
            /* $4 price_up */ parseInt(t.Precio_hasta, 10) || 0,
            /* $5 rooms */ parseInt(t.Habitaciones, 10) || 0,
            /* $6 bathrooms */ parseInt(t.Ba_os, 10) || 0,
            /* $7 built_area */ parseFloat(t.Area_construida) || 0,
            /* $8 private_area */ parseFloat(t.Area_privada) || 0,
            /* $9 min_separation */ parseInt(t.Separacion, 10) || 0,
            /* $10 min_deposit */ parseInt(t.Cuota_inicial1, 10) || 0,
            /* $11 delivery_time */ parseInt(t.Plazo_en_meses, 10) || 0,
            /* $12 available_count */ availableUnits,
            /* $13 gallery */ galleryData,
            /* $14 plans */ plansData,
            /* $15 project_id (WHERE) */ projectHc.toString(),
            /* $16 name (WHERE) */ t.Nombre || "",
          ];
          await client.query(updateQuery, values);
        } else {
          // --- Si NO EXISTE, la INSERTAMOS ---
          const insertQuery = `
            INSERT INTO public."Typologies" (
                id, project_id, "name", description, price_from, price_up, rooms, bathrooms,
                built_area, private_area, min_separation, min_deposit, delivery_time,
                available_count, gallery, "plans"
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16);
          `;
          const values = [
            /* $1 id */ t.id.toString(),
            /* $2 project_id */ projectHc.toString(),
            /* $3 name */ t.Nombre || "",
            /* $4 description */ t.Descripci_n || "",
            /* $5 price_from */ parseInt(t.Precio_desde, 10) || 0,
            /* $6 price_up */ parseInt(t.Precio_hasta, 10) || 0,
            /* $7 rooms */ parseInt(t.Habitaciones, 10) || 0,
            /* $8 bathrooms */ parseInt(t.Ba_os, 10) || 0,
            /* $9 built_area */ parseFloat(t.Area_construida) || 0,
            /* $10 private_area */ parseFloat(t.Area_privada) || 0,
            /* $11 min_separation */ parseInt(t.Separacion, 10) || 0,
            /* $12 min_deposit */ parseInt(t.Cuota_inicial1, 10) || 0,
            /* $13 delivery_time */ parseInt(t.Plazo_en_meses, 10) || 0,
            /* $14 available_count */ availableUnits,
            /* $15 gallery */ galleryData,
            /* $16 plans */ plansData,
          ];
          await client.query(insertQuery, values);
        }

        processedIds.add(t.id.toString());
      }
      return { success: true, processedIds };
    } catch (error) {
      console.error(
        `❌ Error insertando/actualizando tipologías para proyecto ${projectHc}:`,
        error.message
      );
      // Añadimos más detalle para depuración
      if (error.stack) {
        console.error(error.stack);
      }
      return { success: false, processedIds: new Set() };
    } finally {
      client.release();
    }
  }

  //Actualiza datos del proyecto basados en sus tipologías
  async syncProjectData(projectId, typologies) {
    if (!projectId || typologies.length === 0) return; // No hacer nada si no hay tipologías
    const projectIdStr = projectId.toString();

    // Calcular valores mínimos a partir de las tipologías
    const minDeliveryTime = Math.min(
      ...typologies.map((t) => parseInt(t.Plazo_en_meses, 10) || Infinity)
    );
    const minDeposit = Math.min(
      ...typologies.map((t) => parseInt(t.Cuota_inicial1, 10) || Infinity)
    );

    const client = await this.pool.connect();
    try {
      const updateQuery = `
                UPDATE public."Projects"
                SET delivery_time = $1, deposit = $2
                WHERE hc = $3;
            `;
      await client.query(updateQuery, [
        minDeliveryTime !== Infinity ? minDeliveryTime : 0,
        minDeposit !== Infinity ? minDeposit : 0,
        projectIdStr,
      ]);
    } catch (error) {
      console.error(
        `❌ Error al actualizar datos del proyecto ${projectIdStr}:`,
        error
      );
    } finally {
      client.release();
    }
  }

  // --- MÉTODO 'RUN' LÓGICA DE SINCRONIZACIÓN COMPLETA ---
  async run() {
    const reporte = {
      ...crearReporteDeTarea("Sincronización de Proyectos y Tipologías"),
      metricas: {
        proyectos: {
          obtenidos: 0,
          procesados: 0,
          exitosos: 0,
          fallidos: 0,
          eliminados: 0,
        },
        tipologias: { obtenidas: 0, procesadas: 0, eliminadas: 0 },
      },
    };

    let client; // Definimos client fuera del try para usarlo en el finally

    try {
      console.log(`🚀 Iniciando tarea: ${reporte.tarea}...`);
      const token = await this.getZohoAccessToken();

      // --- FASE 1: RECOPILAR TODOS LOS IDs ACTIVOS DE ZOHO ---
      const allActiveZohoProjectIds = new Set();
      const allActiveZohoTypologyIds = new Set();
      let offset = 0;
      let more = true;

      console.log("🔍 Fase 1: Recopilando todos los IDs activos desde Zoho...");
      while (more) {
        const { data: projectsFromZoho, more: hasMore } =
          await this.getZohoProjects(token, offset);
        if (!projectsFromZoho || projectsFromZoho.length === 0) break;

        for (const project of projectsFromZoho) {
          allActiveZohoProjectIds.add(project.id.toString());
          const typologies = await this.getTypologiesFromZoho(
            token,
            project.id
          );
          reporte.metricas.tipologias.obtenidas += typologies.length;
          for (const typo of typologies) {
            allActiveZohoTypologyIds.add(typo.id.toString());
          }
        }
        more = hasMore;
        offset += 200;
      }
      console.log(
        `✅ IDs recopilados: ${allActiveZohoProjectIds.size} proyectos y ${allActiveZohoTypologyIds.size} tipologías.`
      );

      // --- FASE 2: PROCESAR (INSERTAR/ACTUALIZAR) REGISTROS ---
      console.log("🔄 Fase 2: Sincronizando (Insertar/Actualizar) datos...");
      offset = 0;
      more = true;
      while (more) {
        const { data: projectsFromZoho, more: hasMore } =
          await this.getZohoProjects(token, offset);
        if (!projectsFromZoho || projectsFromZoho.length === 0) break;

        reporte.metricas.proyectos.obtenidos += projectsFromZoho.length;

        for (const project of projectsFromZoho) {
          reporte.metricas.proyectos.procesados++;
          const insertResult = await this.insertProjectIntoPostgres(
            project,
            token
          );

          if (insertResult.success) {
            reporte.metricas.proyectos.exitosos++;
            const typologies = await this.getTypologiesFromZoho(
              token,
              insertResult.hc
            );

            if (typologies && typologies.length > 0) {
              const typoResult = await this.insertTypologies(
                insertResult.hc,
                typologies
              );
              reporte.metricas.tipologias.procesadas +=
                typoResult.processedIds.size;
              await this.syncProjectData(insertResult.hc, typologies);
            }
          } else {
            reporte.metricas.proyectos.fallidos++;
            reporte.erroresDetallados.push({
              referencia: `Proyecto HC: ${project.id}`,
              motivo: insertResult.message || insertResult.errorType,
            });
          }
        }
        more = hasMore;
        offset += 200;
      }

      // --- FASE 3: ELIMINAR REGISTROS OBSOLETOS ("SWEEP") ---
      console.log(
        "🧹 Fase 3: Eliminando registros obsoletos de la base de datos..."
      );
      client = await this.pool.connect();

      // Eliminar tipologías obsoletas
      const deleteTypologiesQuery = `DELETE FROM public."Typologies" WHERE id NOT IN (${Array.from(
        allActiveZohoTypologyIds
      )
        .map((id) => `'${id}'`)
        .join(",")})`;
      if (allActiveZohoTypologyIds.size > 0) {
        const deleteTypoResult = await client.query(deleteTypologiesQuery);
        reporte.metricas.tipologias.eliminadas = deleteTypoResult.rowCount;
        console.log(
          `✅ ${deleteTypoResult.rowCount} tipologías obsoletas eliminadas.`
        );
      } else {
        // Si no viene ninguna tipología de Zoho, borrarlas todas.
        const deleteAllTypologiesResult = await client.query(
          'DELETE FROM public."Typologies"'
        );
        reporte.metricas.tipologias.eliminadas =
          deleteAllTypologiesResult.rowCount;
        console.log(
          `⚠️ No se encontraron tipologías activas en Zoho. Se eliminaron ${deleteAllTypologiesResult.rowCount} tipologías.`
        );
      }

      // Eliminar proyectos obsoletos
      const deleteProjectsQuery = `DELETE FROM public."Projects" WHERE hc NOT IN (${Array.from(
        allActiveZohoProjectIds
      )
        .map((id) => `'${id}'`)
        .join(",")})`;
      if (allActiveZohoProjectIds.size > 0) {
        const deleteProjectResult = await client.query(deleteProjectsQuery);
        reporte.metricas.proyectos.eliminados = deleteProjectResult.rowCount;
        console.log(
          `✅ ${deleteProjectResult.rowCount} proyectos obsoletos eliminados.`
        );
      } else {
        // Si no viene ningún proyecto, borrarlos todos (cuidado con esto).
        const deleteAllProjectsResult = await client.query(
          'DELETE FROM public."Projects"'
        );
        reporte.metricas.proyectos.eliminados =
          deleteAllProjectsResult.rowCount;
        console.log(
          `⚠️ No se encontraron proyectos activos en Zoho. Se eliminaron ${deleteAllProjectsResult.rowCount} proyectos.`
        );
      }

      reporte.estado =
        reporte.metricas.proyectos.fallidos > 0
          ? "finalizado_con_errores"
          : "exitoso";
      console.log(
        `✅ Tarea '${reporte.tarea}' finalizada con estado: ${reporte.estado}`
      );
    } catch (errorGeneral) {
      console.error(
        `🚨 ERROR CRÍTICO en '${reporte.tarea}'. El proceso se detuvo.`,
        errorGeneral
      );
      reporte.estado = "error_critico";
      reporte.erroresDetallados.push({
        motivo: "Error general en la ejecución de la tarea",
        detalle: errorGeneral.message,
      });
    } finally {
      if (client) client.release();
    }

    return reporte;
  }
}

module.exports = ZohoToPostgresSyncProjects;
