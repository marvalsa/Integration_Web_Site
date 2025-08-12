require("dotenv").config();
const { Pool } = require("pg");
const axios = require("axios");

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
      if (!token) throw new Error("Token de acceso no recibido");
      console.log("✅ Token de acceso obtenido para la sincronización.");
      return token;
    } catch (error) {
      console.error(
        "❌ Error al obtener el token de acceso de Zoho:",
        error.response?.data || error.message
      );
      throw error;
    }
  }

  //Obtener Proyectos Comerciales de CRM
  async getZohoProjects(accessToken, offset = 0) {
    const coqlQueryObject = {
      select_query: `
                SELECT id, Name, Slogan, Direccion, Descripcion_corta, Descripcion_larga, SIG, Sala_de_ventas.Name, Cantidad_SMMLV, Descripcion_descuento, Precios_desde, Precios_hasta, Tipo_de_proyecto, Mega_Proyecto.id, Estado, Proyecto_destacado, Area_construida_desde, Area_construida_hasta, Habitaciones, Ba_os, Latitud, Longitud, Ciudad.Name, Sala_de_ventas.id, Slug, Precio_en_SMMLV FROM Proyectos_Comerciales 
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
        `✅ Obtenidos ${data.length} proyectos de Zoho (página con offset ${offset})`
      );
      return {
        data,
        more: info?.more_records === true,
        count: info?.count || 0,
      };
    } catch (error) {
      console.error(
        "❌ Error al ejecutar la consulta COQL para Proyectos:",
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
          `⚠️ Estado no encontrado en la Base de Datos: "${stateName}". Se guardará como nulo.`
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
        `❌ Error al obtener atributos para el proyecto ${parentId}:`,
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
        `❌ Error al obtener detalles de la Sala de Ventas con ID ${salesRoomId}:`,
        error.response?.data || error.message
      );
      return null;
    }
  }

  // =========================================================================
  // == FUNCIÓN PRINCIPAL DE PROYECTOS ==
  // =========================================================================
  async insertProjectIntoPostgres(project, accessToken) {
    if (!project?.id) {
      console.warn("⚠️ Se omitió un proyecto porque no tenía ID.");
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

      const insertQuery = `
        INSERT INTO public."Projects" (
            hc, "name", slug, slogan, address, city, small_description, long_description,
            seo_title, seo_meta_description, sic, sales_room_address, sales_room_schedule_attention,
            sales_room_latitude, sales_room_longitude, salary_minimum_count, delivery_time, deposit,
            discount_description, bonus_ref, price_from_general, price_up_general, "attributes",
            gallery, urban_plans, work_progress_images, tour_360, "type", status, highlighted,
            built_area, private_area, rooms, bathrooms, relation_projects, latitude, longitude, mega_project_id, is_public
        ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
            $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37, $38, $39
        )
        ON CONFLICT (hc) DO UPDATE SET
            "name" = EXCLUDED.name, slug = EXCLUDED.slug, slogan = EXCLUDED.slogan, address = EXCLUDED.address,
            city = EXCLUDED.city, small_description = EXCLUDED.small_description, long_description = EXCLUDED.long_description,
            seo_title = EXCLUDED.seo_title, seo_meta_description = EXCLUDED.seo_meta_description, sic = EXCLUDED.sic,
            sales_room_address = EXCLUDED.sales_room_address, sales_room_schedule_attention = EXCLUDED.sales_room_schedule_attention,
            sales_room_latitude = EXCLUDED.sales_room_latitude, sales_room_longitude = EXCLUDED.sales_room_longitude,
            salary_minimum_count = EXcluded.salary_minimum_count, delivery_time = EXCLUDED.delivery_time,
            deposit = EXCLUDED.deposit, discount_description = EXCLUDED.discount_description, bonus_ref = EXCLUDED.bonus_ref,
            price_from_general = EXCLUDED.price_from_general, price_up_general = EXCLUDED.price_up_general,
            "attributes" = EXCLUDED.attributes,
            gallery = CASE 
                        WHEN public."Projects".gallery IS NOT NULL AND jsonb_array_length(public."Projects".gallery) > 0 
                        THEN public."Projects".gallery 
                        ELSE EXCLUDED.gallery 
                      END,
            urban_plans = CASE 
                            WHEN public."Projects".urban_plans IS NOT NULL AND jsonb_array_length(public."Projects".urban_plans) > 0
                            THEN public."Projects".urban_plans 
                            ELSE EXCLUDED.urban_plans
                          END,
            work_progress_images = EXCLUDED.work_progress_images, tour_360 = EXCLUDED.tour_360,
            "type" = EXCLUDED.type, status = EXCLUDED.status, highlighted = EXCLUDED.highlighted,
            built_area = EXCLUDED.built_area, private_area = EXCLUDED.private_area, rooms = EXCLUDED.rooms,
            bathrooms = EXCLUDED.bathrooms, relation_projects = EXCLUDED.relation_projects,
            latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude,
            mega_project_id = EXCLUDED.mega_project_id, 
            is_public = CASE 
                WHEN public."Projects".is_public IS NOT NULL 
                THEN public."Projects".is_public 
                ELSE EXCLUDED.is_public
            END;
      `;
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

      const values = [
        hcValue,
        project.Name || "",
        project.Slug || "",
        project.Slogan || "",
        project.Direccion || "",
        cityName,
        project.Descripcion_corta || "",
        project.Descripcion_larga || "",
        project.SEO_Title || null,
        project.SEO_Meta_Description || null,
        project.SIG || "",
        salesRoomDetails?.Direccion || "",
        salesRoomDetails?.Horario || "",
        (salesRoomDetails?.Latitud_SV || "0").toString(),
        (salesRoomDetails?.Longitud_SV || "0").toString(),
        salaryMinimumCount,
        0,
        0,
        project.Descripcion_descuento || null,
        project.Bonus_Ref || null,
        parseInt(project.Precios_desde, 10) || 0,
        parseInt(project.Precios_hasta, 10) || 0,
        attributesJson,
        "[]",
        "[]",
        "[]",
        project.Tour_360 || null,
        project.Tipo_de_proyecto || "",
        statusForDb,
        project.Proyecto_destacado || false,
        parseFloat(project.Area_construida_desde) || 0,
        parseFloat(project.Area_construida_hasta) || 0,
        roomsValue,
        bathroomsValue,
        relatedProjectsJson,
        (parseFloat(project.Latitud) || "0").toString(),
        (parseFloat(project.Longitud) || "0").toString(),
        project["Mega_Proyecto.id"]
          ? project["Mega_Proyecto.id"].toString()
          : null,
        false,
      ];

      await client.query(insertQuery, values);
      console.log(
        `✅ Proyecto insertado/actualizado (HC: ${hcValue}): ${project.Name}`
      );
      return { success: true, hc: hcValue };
    } catch (error) {
      console.error(
        `❌ Error procesando el proyecto HC ${hcValue} (${project?.Name}):`,
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
        `❌ Error al obtener las tipologías del proyecto ${parentId}:`,
        error.response?.data || error.message
      );
      throw error;
    }
  }

  // =========================================================================
  // == FUNCIÓN DE SINCRONIZACIÓN MANUAL ==
  // =========================================================================
  async syncTypologies(projectHc, typologiesFromZoho) {
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");

      // 1. Obtener datos de ambas fuentes y normalizar los nombres con .trim()
      const dbResult = await client.query(
        'SELECT id, "name", gallery FROM public."Typologies" WHERE project_id = $1',
        [projectHc]
      );

      // ***** CAMBIO 1: Aplicar .trim() al crear el Map de la DB *****
      const dbTypologiesMap = new Map(
        dbResult.rows.map((t) => [
          t.name.trim(), // Normalizamos el nombre de la DB
          { id: t.id, gallery: t.gallery },
        ])
      );

      // ***** CAMBIO 2: Aplicar .trim() al crear el Map de Zoho *****
      const zohoTypologiesMap = new Map(
        typologiesFromZoho.map((t) => [
          t.Nombre.trim(), // Normalizamos el nombre de Zoho
          t,
        ])
      );

      // 2. Eliminar tipologías obsoletas
      const namesToDelete = [...dbTypologiesMap.keys()].filter(
        (dbName) => !zohoTypologiesMap.has(dbName)
      );
      if (namesToDelete.length > 0) {
        console.log(
          `🗑️  Proyecto ${projectHc}: Se eliminarán ${
            namesToDelete.length
          } tipologías obsoletas: ${namesToDelete.join(", ")}`
        );
        await client.query(
          'DELETE FROM public."Typologies" WHERE project_id = $1 AND name = ANY($2::text[])',
          [projectHc, namesToDelete]
        );
      }

      // 3. Iterar sobre las tipologías de Zoho para decidir si insertar o actualizar
      for (const t of typologiesFromZoho) {
        if (!t.id || !t.Nombre) continue;

        const trimmedName = t.Nombre.trim(); // Usamos el nombre "limpio" para la lógica
        if (!trimmedName) continue; // Si el nombre queda vacío después del trim, lo ignoramos

        const availableUnits = parseInt(t.Und_Disponibles, 10);
        if (isNaN(availableUnits) || availableUnits < 1) {
          console.log(
            `ℹ️ Omitiendo tipología "${trimmedName}" (proyecto ${projectHc}) por no tener unidades disponibles.`
          );
          continue;
        }

        const existingTypology = dbTypologiesMap.get(trimmedName); // Buscamos por el nombre "limpio"
        // Valida si existen las typologies en DB - CMR
        if (existingTypology) {
          // --- ACTUALIZAR ---
          let galleryValueToUpdate = "[]";
          if (
            Array.isArray(existingTypology.gallery) &&
            existingTypology.gallery.length > 0
          ) {
            galleryValueToUpdate = JSON.stringify(existingTypology.gallery);
          }

          const updateQuery = `
              UPDATE public."Typologies" SET
                id = $1, description = $2, price_from = $3, price_up = $4, rooms = $5, bathrooms = $6,
                built_area = $7, private_area = $8, min_separation = $9, min_deposit = $10,
                delivery_time = $11, available_count = $12, "plans" = $13,
                gallery = $14 
              WHERE project_id = $15 AND "name" = $16;
            `;

          await client.query(updateQuery, [
            t.id.toString(),
            t.Descripci_n || "",
            parseInt(t.Precio_desde, 10) || 0,
            0,
            parseInt(t.Habitaciones, 10) || 0,
            parseInt(t.Ba_os, 10) || 0,
            parseFloat(t.Area_construida) || 0,
            parseFloat(t.Area_privada) || 0,
            parseInt(t.Separacion, 10) || 0,
            parseInt(t.Cuota_inicial1, 10) || 0,
            parseInt(t.Plazo_en_meses, 10) || 0,
            availableUnits,
            "",
            galleryValueToUpdate, // $14
            projectHc, // $15
            trimmedName, // $16: Usamos el nombre limpio para encontrar la fila
          ]);
        } else {
          // --- INSERTAR ---
          const insertQuery = `
              INSERT INTO public."Typologies" (
                id, project_id, "name", description, price_from, price_up, rooms, bathrooms,
                built_area, private_area, min_separation, min_deposit, delivery_time,
                available_count, gallery, "plans"
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16);
            `;
          await client.query(insertQuery, [
            t.id.toString(),
            projectHc,
            trimmedName, // Guardamos el nombre limpio en la DB
            t.Descripci_n || "",
            parseInt(t.Precio_desde, 10) || 0,
            0,
            parseInt(t.Habitaciones, 10) || 0,
            parseInt(t.Ba_os, 10) || 0,
            parseFloat(t.Area_construida) || 0,
            parseFloat(t.Area_privada) || 0,
            parseInt(t.Separacion, 10) || 0,
            parseInt(t.Cuota_inicial1, 10) || 0,
            parseInt(t.Plazo_en_meses, 10) || 0,
            availableUnits,
            "[]",
            "",
          ]);
        }
      }

      await client.query("COMMIT");
      console.log(
        `✅ Tipologías del proyecto ${projectHc} sincronizadas correctamente (Insertar/Actualizar/Eliminar).`
      );
    } catch (error) {
      await client.query("ROLLBACK");
      console.error(
        `❌ Error fatal sincronizando tipologías para el proyecto ${projectHc}. La transacción fue revertida.`,
        error
      );
    } finally {
      client.release();
    }
  }

  //Actualiza datos del proyecto basados en sus tipologías
  async syncProjectData(projectId, typologies) {
    const availableTypologies = typologies.filter(
      (t) => (parseInt(t.Und_Disponibles, 10) || 0) > 0
    );

    if (!projectId || availableTypologies.length === 0) {
      const client = await this.pool.connect();
      try {
        const updateQuery =
          'UPDATE public."Projects" SET delivery_time = 0, deposit = 0 WHERE hc = $1;';
        await client.query(updateQuery, [projectId.toString()]);
      } catch (error) {
        console.error(
          `❌ Error al resetear los datos agregados del proyecto ${projectId}:`,
          error
        );
      } finally {
        client.release();
      }
      return;
    }

    const projectIdStr = projectId.toString();
    const minDeliveryTime = Math.min(
      ...availableTypologies.map(
        (t) => parseInt(t.Plazo_en_meses, 10) || Infinity
      )
    );
    const minDeposit = Math.min(
      ...availableTypologies.map(
        (t) => parseInt(t.Cuota_inicial1, 10) || Infinity
      )
    );

    const client = await this.pool.connect();
    try {
      const updateQuery =
        'UPDATE public."Projects" SET delivery_time = $1, deposit = $2 WHERE hc = $3;';
      await client.query(updateQuery, [
        minDeliveryTime !== Infinity ? minDeliveryTime : 0,
        minDeposit !== Infinity ? minDeposit : 0,
        projectIdStr,
      ]);
    } catch (error) {
      console.error(
        `❌ Error al actualizar los datos agregados del proyecto ${projectIdStr}:`,
        error
      );
    } finally {
      client.release();
    }
  }

  // Inicar sincronizacion de data
  async run() {
    try {
      console.log(
        "🚀 Iniciando la sincronización de Proyectos y Tipologías..."
      );
      const token = await this.getZohoAccessToken();

      let offset = 0;
      let more = true;
      while (more) {
        const { data: projectsFromZoho, more: hasMore } =
          await this.getZohoProjects(token, offset);
        if (!projectsFromZoho || projectsFromZoho.length === 0) {
          console.log(
            "ℹ️ No se encontraron más proyectos en Zoho. Finalizando bucle."
          );
          break;
        }

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

            await this.syncProjectData(insertResult.hc, typologies);
            await this.syncTypologies(insertResult.hc, typologies);
          } else {
            console.error(
              `🚨 Falló el procesamiento del proyecto HC: ${project.id}. Razón: ${insertResult.message}. Omitiendo sus tipologías.`
            );
          }
        }
        more = hasMore;
        offset += 200;
      }
      console.log("✅ Sincronización completada con éxito.");
    } catch (errorGeneral) {
      console.error(
        "🚨 ERROR CRÍTICO EN LA EJECUCIÓN GENERAL. El proceso se detuvo.",
        errorGeneral
      );
    } finally {
      if (this.pool) {
        console.log("🔌 Cerrando todas las conexiones a la base de datos...");
        await this.pool.end();
      }
    }
  }
}

module.exports = ZohoToPostgresSyncProjects;
