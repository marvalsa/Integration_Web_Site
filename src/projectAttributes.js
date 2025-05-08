require('dotenv').config();
const { Pool } = require('pg');
const axios = require('axios');
const logger = require('../logs/logger');

class ProjectAttributesSync {
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
            logger.info('✅ Token obtenido para atributos');
            return token;
        } catch (error) {
            logger.error('❌ Error al obtener token para atributos:', error.response?.data || error.message);
            throw error;
        }
    }

    async getZohoAttributes(accessToken) {
        const query = {
            select_query: `select id, Nombre_atributo from Parametros where Tipo ='Atributo' limit 0,200`
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

            return response.data.data || [];
        } catch (error) {
            logger.error('❌ Error al obtener atributos desde Zoho:', error.response?.data || error.message);
            throw error;
        }
    }

    async insertAttributesIntoPostgres(attributes) {
        const client = await this.pool.connect();
        try {
            for (const attr of attributes) {
                await client.query(
                    `INSERT INTO public."Project_Attributes" (name)
                     VALUES ($1)
                     ON CONFLICT DO NOTHING`,
                    [attr.Nombre_atributo]
                );
                logger.info(`✅ Insertado atributo: ${attr.Nombre_atributo}`);
            }
        } catch (error) {
            logger.error('❌ Error al insertar atributos:', error.message);
        } finally {
            client.release();
        }
    }

    async run() {
        try {
            logger.info('🚀 Iniciando sincronización de atributos...');
            await this.pool.query('SELECT 1'); // Test DB

            const token = await this.getZohoAccessToken();
            const attributes = await this.getZohoAttributes(token);
            await this.insertAttributesIntoPostgres(attributes);

            logger.info(`✅ Sincronización de atributos finalizada. Total: ${attributes.length}`);
        } catch (error) {
            logger.error('🚨 Error en sincronización de atributos:', error.message);
        } finally {
            await this.pool.end();
        }
    }
}

module.exports = ProjectAttributesSync;

// Ejecutar directamente si se llama como script
if (require.main === module) {
    const ProjectAttributesSync = require('./projectAttributes');
    const sync = new ProjectAttributesSync();
    sync.run();
}
