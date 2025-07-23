require('dotenv').config();
const { Pool } = require('pg');
const axios = require('axios');

class ProjectStatesSync {
    
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

    // --- Paso 1: Obtener Token ---
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
            console.log('✅ Token obtenido para sincronización de Estados de Proyecto.');
            return token;
        } catch (error) {
            console.error('❌ Error al obtener token para Estados de Proyecto:', error.response?.data || error.message);
            throw error;
        }
    }

    // --- Paso 2: Obtener Nombres de Estados de Zoho (CON PAGINACIÓN) ---
    async getZohoProjectStates(accessToken) {
        let allStates = [];
        let hasMoreRecords = true;
        let page = 1;
        const limit = 200;

        console.log("ℹ️ Obteniendo estados de proyecto desde Zoho (con paginación)...");
        
        while (hasMoreRecords) {
            const query = {
                // Seleccionamos solo el campo 'Estado' y paginamos los resultados
                select_query: `SELECT Estado FROM Proyectos_Comerciales WHERE Estado is not null limit ${(page - 1) * limit}, ${limit}`
            };

            try {
                console.log(`  > Solicitando página ${page} de estados...`);
                const response = await axios.post(`${this.zohoConfig.baseURL}/coql`, query, {
                    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` }
                });
                
                const data = response.data.data || [];
                if (data.length > 0) {
                    // Extraemos solo el nombre del estado de cada registro
                    const stateNames = data.map(item => item.Estado).filter(Boolean);
                    allStates = allStates.concat(stateNames);
                }

                hasMoreRecords = response.data.info?.more_records || false;
                if (hasMoreRecords) {
                    page++;
                }
            } catch (error) {
                console.error(`❌ Error al obtener la página ${page} de estados desde Zoho:`, error.response?.data || error.message);
                throw error;
            }
        }

        console.log(`✅ ${allStates.length} registros de estado recuperados de Zoho en total.`);
        return allStates;
    }

    // --- Paso 3: Truncar e Insertar Estados en PostgreSQL (MODIFICADO) ---
    async syncStatesWithPostgres(stateNames) {
        if (!stateNames || stateNames.length === 0) {
            console.log("ℹ️ No hay estados para procesar desde Zoho.");
            return { processedCount: 0 };
        }
        
        // Obtener una lista de nombres de estado únicos
        const uniqueStateNames = [...new Set(stateNames)];
        console.log(`ℹ️ Se encontraron ${uniqueStateNames.length} estados únicos.`);        

        const client = await this.pool.connect();
        let processedCount = 0;

        try {
            await client.query('BEGIN');

            console.log('ℹ️ Limpiando la tabla "Project_Status" (TRUNCATE)...');
            await client.query('TRUNCATE TABLE public."Project_Status" RESTART IDENTITY CASCADE;');
            console.log('✅ Tabla "Project_Status" limpiada.');

            // ID inicial como BigInt para mantener la consistencia
            let currentId = 1000000000000000001n; 

            for (const stateName of uniqueStateNames) {
                console.log(`- Procesando estado: "${stateName}"`);
                
                const insertQuery = `
                    INSERT INTO public."Project_Status" (id, name)
                    VALUES ($1, $2);
                `;                
                
                // === AJUSTE PRINCIPAL: Se inserta el texto directamente, sin JSON.stringify ===
                await client.query(insertQuery, [currentId.toString(), stateName]);

                console.log(`  ✅ Insertado con ID ${currentId} -> "${stateName}"`);
                processedCount++;
                currentId++; // Incrementar el ID para el siguiente estado
            }

            await client.query('COMMIT');
            
            console.log(`✅ Sincronización completada. ${processedCount} estados únicos insertados.`);
            return { processedCount };

        } catch (error) {            
            await client.query('ROLLBACK');
            console.error(`❌ Error durante la sincronización con PostgreSQL. La transacción ha sido revertida.`, error);
            throw error;
        } finally {
            client.release();
        }
    }
    
    // --- Método principal que orquesta todo el proceso ---
    async run() {
        try {
            console.log('🚀 Iniciando sincronización de Estados de Proyecto...');
            
            const token = await this.getZohoAccessToken();
            const statesFromZoho = await this.getZohoProjectStates(token);
            const result = await this.syncStatesWithPostgres(statesFromZoho);
            
            console.log(`✅ Sincronización de Estados de Proyecto finalizada. ${result.processedCount} estados procesados.`);

        } catch (error) {
            console.error('🚨 ERROR CRÍTICO durante la sincronización de Estados de Proyecto. El proceso se detendrá.', error.message);
            throw error;
        } finally {
            if (this.pool) {
                console.log('🔌 Cerrando pool de conexiones PostgreSQL para Estados de Proyecto...');
                await this.pool.end();
                console.log('🔌 Pool de conexiones PostgreSQL cerrado.');
            }
        }
    }
}

module.exports = ProjectStatesSync;