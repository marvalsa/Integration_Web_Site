require('dotenv').config();
const { Pool } = require('pg');
const axios = require('axios');
const logger = require('../logs/logger');

class ZohoToPostgresSync {
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

    // 🔐 Obtener token de acceso de Zoho
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

            const token = response.data.access_token;
            if (!token) throw new Error('Access token no recibido');

            logger.info('✅ Token obtenido correctamente');
            return token;
        } catch (error) {
            logger.error('❌ Error al obtener token:', error.response?.data || error.message);
            throw error;
        }
    }

    // 📥 Obtener Mega Proyectos desde Zoho
    async getZohoProjectData(accessToken, offset = 0) {
        const query = {
            select_query: `
                SELECT id, Name, Direccion_MP, Slogan_comercial, Descripcion, Record_Image, Latitud_MP, Longitud_MP 
                FROM Mega_Proyectos 
                WHERE id is not null 
                LIMIT ${offset}, 200
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

            const info = response.data.info;
            const data = response.data.data || [];

            logger.info(`✅ Recuperados ${data.length} registros en offset ${offset}`);
            return {
                data,
                more: info?.more_records === true,
                count: info?.count || 0
            };
        } catch (error) {
            logger.error('❌ Error al ejecutar COQL:', error.response?.data || error.message);
            throw error;
        }
    }

    // 🧩 Obtener los atributos del subformulario Atributos_Mega_Proyecto
    async getAttributesFromZoho(accessToken, parentId) {
        try {
            const response = await axios.get(
                `${this.zohoConfig.baseURL}/Atributos_Mega_Proyecto/search?criteria=Parent_Id.id:equals:${parentId}`,
                {
                    headers: {
                        Authorization: `Zoho-oauthtoken ${accessToken}`
                    },
                    validateStatus: status => [200, 204].includes(status) // Permite controlar respuesta 204
                }
            );

            if (response.status === 204) {
                logger.info(`ℹ️ Sin atributos para proyecto ID ${parentId}`);
                return null; // No hay datos
            }

            logger.info(`✅ Atributos recuperados para proyecto ID ${parentId}`);
            return response.data.data || null;

        } catch (error) {
            logger.error(`❌ Error al obtener atributos para ID ${parentId}:`, error.response?.data || error.message);
            return null; // Continúa con null si hay error
        }
    }

    // 📤 Insertar Mega Proyecto en PostgreSQL
    async insertMegaProjectIntoPostgres(project, accessToken) {
        const client = await this.pool.connect();
        try {
            // Obtener atributos antes de insertar
            const attributes = await this.getAttributesFromZoho(accessToken, project.id);

            const insertQuery = `
                INSERT INTO public."Mega_Projects" (
                    name, address, slogan, description, "attributes",
                    gallery, latitude, longitude, is_public
                ) VALUES (
                    $1, $2, $3, $4, $5,
                    $6, $7, $8, $9
                )
                ON CONFLICT (id) DO UPDATE SET
                    name = EXCLUDED.name,
                    address = EXCLUDED.address,
                    slogan = EXCLUDED.slogan,
                    description = EXCLUDED.description,
                    "attributes" = EXCLUDED."attributes",
                    gallery = EXCLUDED.gallery,
                    latitude = EXCLUDED.latitude,
                    longitude = EXCLUDED.longitude,
                    is_public = EXCLUDED.is_public;
            `;

            const latitude = Math.round(parseFloat(project.Latitud_MP || 0));
            const longitude = Math.round(parseFloat(project.Longitud_MP || 0));

            const values = [
                project.Name,
                project.Direccion_MP,
                project.Slogan_comercial || '',
                project.Descripcion || '',
                attributes ? JSON.stringify(attributes) : null,
                JSON.stringify(project.Record_Image?.split(',') || []),
                latitude,
                longitude,
                project.Es_Publico || false
            ];

            await client.query(insertQuery, values);
            logger.info(`✅ Mega Proyecto insertado/actualizado: ${project.Name}`);
        } catch (error) {
            logger.error('❌ Error al insertar en Mega_Projects:', error.message);
        } finally {
            client.release();
        }
    }

    // 🏃 Ejecutar el proceso de sincronización completo
    async run() {
        try {
            logger.info('🚀 Iniciando sincronización...');
            const pgTest = await this.pool.query('SELECT 1');
            if (!pgTest) throw new Error('Conexión PostgreSQL fallida');

            const token = await this.getZohoAccessToken();

            let offset = 0;
            let totalInsertados = 0;

            while (true) {
                const { data: projects, more } = await this.getZohoProjectData(token, offset);
                if (projects.length === 0) break;

                for (const project of projects) {
                    await this.insertMegaProjectIntoPostgres(project, token);
                    totalInsertados++;
                }

                if (!more) break;
                offset += 200;
            }

            logger.info(`✅ Sincronización finalizada. Total insertados: ${totalInsertados}`);
        } catch (error) {
            logger.error('🚨 Error en la sincronización:', error.message);
        } finally {
            await this.pool.end();
        }
    }
}

module.exports = ZohoToPostgresSync;

// Ejecutar directamente si se llama como script
if (require.main === module) {
    const sync = new ZohoToPostgresSync();
    sync.run();
}
