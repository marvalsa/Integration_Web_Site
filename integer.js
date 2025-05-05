require('dotenv').config();
const { Pool } = require('pg');
const axios = require('axios');

class ZohoToPostgresSync {
    constructor() {
        this.pool = new Pool({
            host: process.env.PG_HOST,
            database: process.env.PG_DATABASE,
            user: process.env.PG_USER,
            password: process.env.PG_PASSWORD,
            port: process.env.PG_PORT,
            ssl: process.env.PG_SSL === 'true' ? { rejectUnauthorized: false } : false
        });

        this.zohoConfig = {
            clientId: process.env.ZOHO_CLIENT_ID,
            clientSecret: process.env.ZOHO_CLIENT_SECRET,
            refreshToken: process.env.ZOHO_REFRESH_TOKEN,
            baseURL: 'https://www.zohoapis.com/crm/v2'
        };
    }

    // Paso 1: Obtener token de Zoho CRM
    async getZohoAccessToken() {
        try {
            const response = await axios.post(
                'https://accounts.zoho.com/oauth/v2/token',
                null,
                {
                    params: {
                        refresh_token: this.zohoConfig.refreshToken,
                        client_id: this.zohoConfig.clientId,
                        client_secret: this.zohoConfig.clientSecret,
                        grant_type: 'refresh_token'
                    }
                }
            );

            if (!response.data.access_token) {
                throw new Error('Access token no recibido');
            }

            console.log('✅ Token obtenido correctamente');
            return response.data.access_token;
        } catch (error) {
            console.error('❌ Error al obtener token:', error.response?.data || error.message);
            throw error;
        }
    }

    // Paso 2: Ejecutar consulta COQL para obtener el proyecto
    async getZohoProjectData(accessToken) {
        const query = {
            select_query: `
            SELECT id, Name, ID_Proyecto, Tipo_Proyecto, Inmuebles_desde, Areas_desde, Direcci_n_de_proyecto, Ciudad_de_proyecto.Name, Descripci_n_tipo_documento, Especificacion_Proy 
            FROM Proyectos_Inmobiliarios 
            WHERE (((
                ID_Proyecto = '002470701000'
                and id is not null)
                and Name is not null)
                and Tipo_Proyecto is not null              
            ) 
            LIMIT 0,200
    `
            };

        try {
            const response = await axios.post(
                `${this.zohoConfig.baseURL}/coql`,
                query,
                {
                    headers: {
                        Authorization: `Zoho-oauthtoken ${accessToken}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            const data = response.data.data;
            if (!Array.isArray(data) || data.length === 0) {
                throw new Error('No se encontraron proyectos');
            }

            console.log(`✅ ${data.length} proyecto(s) recuperado(s)`);
            return data;
        } catch (error) {
            console.error('❌ Error al ejecutar COQL:', error.response?.data || error.message);
            throw error;
        }
    }

    // Paso 3: Insertar proyecto en tabla PostgreSQL
    async insertProjectIntoPostgres(project) {
        const client = await this.pool.connect();
        try {
            const insertQuery = `
                INSERT INTO public.project (
                    hc, name, slug, images, town_planning, address,
                    description, price_from, price_up, built_area,
                    private_area, type, status, features
                ) VALUES (
                    $1, $2, $3, null, null, $4,
                    $5, $6, null, $7,
                    null, $8, $9, null
                )
                ON CONFLICT (hc) DO UPDATE SET
                    name = EXCLUDED.name,
                    slug = EXCLUDED.slug,
                    address = EXCLUDED.address,
                    description = EXCLUDED.description,
                    price_from = EXCLUDED.price_from,
                    built_area = EXCLUDED.built_area,
                    type = EXCLUDED.type,
                    status = EXCLUDED.status;
            `;

            const address = `${project['Ciudad_de_proyecto.Name']} - ${project['Direcci_n_de_proyecto']}`;

            const values = [
                project.ID_Proyecto,
                project.Name,
                project.Tipo_Proyecto,
                address,
                project['Descripci_n_tipo_documento'],
                project.Inmuebles_desde,
                project.Areas_desde,
                project.Especificacion_Proy,
                project.Estado || 'Activo' // por si no viene, default
            ];

            await client.query(insertQuery, values);
            console.log(`✅ Proyecto ${project.ID_Proyecto} insertado`);
        } catch (error) {
            console.error('❌ Error al insertar en PostgreSQL:', error.message);
        } finally {
            client.release();
        }
    }

    // Paso Final: Flujo completo
    async run() {
        try {
            console.log('\n🚀 Iniciando sincronización...');
            
            // 1. Conexión a PostgreSQL
            const pgTest = await this.pool.query('SELECT 1');
            if (!pgTest) throw new Error('Conexión PostgreSQL fallida');

            // 2. Token de Zoho
            const token = await this.getZohoAccessToken();

            // 3. Obtener datos de proyectos
            const projects = await this.getZohoProjectData(token);

            // 4. Insertar en PostgreSQL
            for (const project of projects) {
                await this.insertProjectIntoPostgres(project);
            }

            console.log('\n✅ Sincronización finalizada correctamente');
        } catch (error) {
            console.error('\n🚨 Error en la sincronización:', error.message);
        } finally {
            await this.pool.end();
        }
    }
}

// Ejecutar
(async () => {
    const sync = new ZohoToPostgresSync();
    await sync.run();
})();
