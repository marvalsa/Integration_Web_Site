// cities.js

require("dotenv").config();
const axios = require("axios");
const { crearReporteDeTarea } = require('./reportBuilder'); // <<< 1. IMPORTAR NUESTRO CONSTRUCTOR

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
        console.log(`  > Solicitando página ${page}...`);
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

  // <<< 2. AJUSTAMOS LA FIRMA Y LA LÓGICA DE `insertCitiesIntoPostgres`
  // Ahora recibe el objeto de reporte y lo modifica directamente.
  async insertCitiesIntoPostgres(cities, reporte) {
    if (!cities || cities.length === 0) {
      console.log("ℹ️ No hay ciudades para insertar o actualizar.");
      return; // No hay nada que hacer
    }

    const citiesMap = new Map();
    for (const city of cities) {
      if (city["Ciudad.id"]) {
        citiesMap.set(city["Ciudad.id"].toString(), city);
      }
    }
    const uniqueCities = Array.from(citiesMap.values());
    console.log(
      `ℹ️ Se encontraron ${uniqueCities.length} ciudades únicas para procesar.`
    );
    reporte.metricas.procesados = uniqueCities.length;

    const client = await this.pool.connect();
    try {
      for (const city of uniqueCities) {
        const cityId = city["Ciudad.id"]?.toString();
        const fullCityName = city["Ciudad.Name"];

        if (!cityId || !fullCityName) {
          reporte.metricas.fallidos++;
          reporte.erroresDetallados.push({
            referencia: JSON.stringify(city),
            motivo: `Registro de ciudad inválido, faltan 'id' o 'name'.`
          });
          continue;
        }

        const cityName = fullCityName.split("/")[0].trim();
        if (!cityName) {
          reporte.metricas.fallidos++;
          reporte.erroresDetallados.push({
            referencia: `ID: ${cityId}`,
            motivo: `Nombre de ciudad vacío después de limpiar: "${fullCityName}"`
          });
          continue;
        }

        const newCityName = cityName.charAt(0).toUpperCase() + cityName.slice(1).toLowerCase();

        try {
          const upsertQuery = `
            INSERT INTO public."Cities" (id, "name", is_public)
            VALUES ($1, $2, $3)
            ON CONFLICT (id) DO UPDATE SET
              "name" = EXCLUDED."name",
              is_public = EXCLUDED.is_public;
          `;
          const res = await client.query(upsertQuery, [
            cityId,
            newCityName,
            false,
          ]);

          if (res.rowCount > 0) {
            reporte.metricas.exitosos++;
          }
        } catch (dbError) {
          reporte.metricas.fallidos++;
          reporte.erroresDetallados.push({
            referencia: `Ciudad ID: ${cityId}`,
            nombre: newCityName,
            motivo: `Error en Base de Datos: ${dbError.message}`
          });
        }
      }
    } finally {
      client.release();
    }

    console.log(
      `✅ Procesamiento de ciudades finalizado. Exitosos: ${reporte.metricas.exitosos}, Fallidos: ${reporte.metricas.fallidos}.`
    );
  }

  // <<< 3. `run()` USA EL NUEVO CONSTRUCTOR DE REPORTES
  async run() {
    // Creamos el reporte desde el constructor centralizado
    const reporte = crearReporteDeTarea("Sincronización de Ciudades");

    try {
      console.log(`🚀 Iniciando tarea: ${reporte.tarea}...`);
      const token = await this.getZohoAccessToken();
      const citiesFromZoho = await this.getZohoCities(token);

      // Llenamos la métrica inicial
      reporte.metricas.obtenidos = citiesFromZoho.length;

      // Pasamos el reporte a la función de inserción para que lo llene
      await this.insertCitiesIntoPostgres(citiesFromZoho, reporte);
      
      // Determinamos el estado final basado en las métricas
      reporte.estado = (reporte.metricas.fallidos > 0) 
        ? 'finalizado_con_errores' 
        : 'exitoso';
      
      console.log(`✅ Tarea '${reporte.tarea}' finalizada con estado: ${reporte.estado}`);

    } catch (error) {
      console.error(`🚨 ERROR CRÍTICO en '${reporte.tarea}'. La tarea se detuvo.`, error);
      reporte.estado = 'error_critico';
      reporte.erroresDetallados.push({ 
        motivo: 'Error general en la ejecución de la tarea', 
        detalle: error.message 
      });
    }

    return reporte; // Devolvemos el reporte estandarizado y en español
  }
}

module.exports = CitiesSync;