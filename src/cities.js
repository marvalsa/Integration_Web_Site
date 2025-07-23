require('dotenv').config();
const { Pool } = require('pg');
const axios = require('axios');

class CitiesSync {
    
    constructor() {
        this.pool = new Pool({
            host: process.env.PG_HOST,
            database: process.env.PG_DATABASE,
            user: process.env.PG_USER,
            password: process.env.PG_PASSWORD,
            port: process.env.PG_PORT || 5432,
            ssl: process.env.PG_SSL === 'true' ? { rejectUnauthorized: false } : false
        });

        this.zohoConfig = {
            clientId: process.env.ZOHO_CLIENT_ID,
            clientSecret: process.env.ZOHO_CLIENT_SECRET,
            refreshToken: process.env.ZOHO_REFRESH_TOKEN,
            baseURL: 'https://www.zohoapis.com/crm/v2'
        };
    }
    
    async getZohoAccessToken() {
        try {
            const response = await axios.post('https://accounts.zoho.com/oauth/v2/token', null, {
                params: {
                    refresh_token: this.zohoConfig.refreshToken,
                    client_id: this.zohoConfig.clientId,
                    client_secret: this.zohoConfig.clientSecret,
                    grant_type: 'refresh_token'
                }
            });
            const token = response.data.access_token;
            if (!token) throw new Error('Access token no recibido de Zoho');
            console.log('✅ Token obtenido para sincronización de Ciudades');
            return token;
        } catch (error) {
            console.error('❌ Error al obtener token para Ciudades:', error.response?.data || error.message);
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
                select_query: `SELECT Ciudad.Name, Ciudad.id FROM Proyectos_Comerciales WHERE Ciudad is not null limit ${(page - 1) * limit}, ${limit}`
            };

            try {
                console.log(`  > Solicitando página ${page}...`);
                const response = await axios.post(`${this.zohoConfig.baseURL}/coql`, query, {
                    headers: { Authorization: `Zoho-oauthtoken ${accessToken}`, 'Content-Type': 'application/json' }
                });
                
                const data = response.data.data || [];
                if (data.length > 0) {
                    allCities = allCities.concat(data);
                }

                hasMoreRecords = response.data.info?.more_records || false;
                
                if (hasMoreRecords) {
                    page++;
                }

            } catch (error) {
                console.error(`❌ Error al obtener la página ${page} de ciudades desde Zoho:`, error.response?.data || error.message);
                throw error;
            }
        }
        
        console.log(`✅ ${allCities.length} registros de ciudad recuperados de Zoho en total.`);
        return allCities;
    }
    
    async insertCitiesIntoPostgres(cities) {
        if (!cities || cities.length === 0) {
            console.log("ℹ️ No hay ciudades para insertar o actualizar.");
            return;
        }
        
        const citiesMap = new Map();
        for (const city of cities) {            
            if (city['Ciudad.id']) { 
                 citiesMap.set(city['Ciudad.id'], city);
            }
        }
        const uniqueCities = Array.from(citiesMap.values());
        console.log(`ℹ️ Se encontraron ${uniqueCities.length} ciudades únicas para procesar.`);        

        const client = await this.pool.connect();
        
        try {
            console.log(`ℹ️ Iniciando procesamiento de ${uniqueCities.length} ciudades en PostgreSQL...`);
            let processedCount = 0;
            let errorCount = 0;
            
            for (const city of uniqueCities) {                
                // AJUSTE: Asegurar que el ID se maneje como string para consistencia
                const cityId = city['Ciudad.id'].toString();
                const fullCityName = city['Ciudad.Name'];

                if (!cityId || !fullCityName) {
                    console.warn(`⚠️ Registro de ciudad inválido: ${JSON.stringify(city)}. Omitiendo.`);
                    errorCount++;
                    continue;
                }
                
                // === AJUSTE PRINCIPAL: Tomar solo la primera parte del nombre y estandarizarlo ===
                const cityName = fullCityName.split('/')[0].trim().toUpperCase();

                if (!cityName) {
                    console.warn(`⚠️ Nombre de ciudad vacío después de limpiar: "${fullCityName}". Omitiendo.`);
                    errorCount++;
                    continue;
                }
                
                try {
                    const upsertQuery = `
                        INSERT INTO public."Cities" (id, "name", is_public)
                        VALUES ($1, $2, $3)
                        ON CONFLICT (id) DO UPDATE SET
                            "name" = EXCLUDED."name",
                            is_public = EXCLUDED.is_public;                           
                    `;
                                        
                    const res = await client.query(upsertQuery, [cityId, cityName, true]);
                    if (res.rowCount > 0) {
                        processedCount++;
                    }

                } catch (dbError) {
                    if (dbError.code === '23505' && dbError.constraint === 'Cities_name_key') {
                        console.error(`  ❌ Error de Unicidad para Ciudad ID ${cityId}: El nombre '${cityName}' ya está en uso por otra ciudad con un ID diferente. Omitiendo.`);
                        errorCount++;
                    } else {
                        console.error(`  ❌ Error en BD al procesar Ciudad ID ${cityId} ('${cityName}'):`, dbError.message);
                        errorCount++;
                    }
                }
            }
            console.log(`✅ Procesamiento finalizado. ${processedCount} ciudades insertadas/actualizadas, ${errorCount} errores manejados.`);
            
        } catch (error) {
            console.error(`❌ Error crítico durante el procesamiento de ciudades en PostgreSQL:`, error);
            throw error;
        } finally {
            client.release();
        }
    }
    
    async run() {
        try {
            console.log('🚀 Iniciando sincronización de Ciudades...');
            
            const token = await this.getZohoAccessToken();
            const citiesFromZoho = await this.getZohoCities(token);
            await this.insertCitiesIntoPostgres(citiesFromZoho);
            
            console.log('✅ Sincronización de Ciudades finalizada con éxito.');

        } catch (error) {
            console.error('🚨 ERROR CRÍTICO durante la sincronización de Ciudades. El proceso se detendrá.');
        } finally {
            if (this.pool) {
                console.log('🔌 Cerrando pool de conexiones PostgreSQL para Ciudades...');
                await this.pool.end();
                console.log('🔌 Pool de conexiones PostgreSQL cerrado.');
            }
        }
    }
}

module.exports = CitiesSync;