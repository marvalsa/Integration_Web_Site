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

    // --- Paso 1: Obtener Token (Sin cambios) ---
    async getZohoAccessToken() {
        try {
            const response = await axios.post(
                'https://accounts.zoho.com/oauth/v2/token', null, {
                params: {
                    refresh_token: this.zohoConfig.refreshToken,
                    client_id: this.zohoConfig.clientId,
                    client_secret: this.zohoConfig.clientSecret,
                    grant_type: 'refresh_token'
                }}
            );
            const token = response.data.access_token;
            if (!token) throw new Error('Access token no recibido');
            console.log('✅ Token obtenido para Mega Proyectos');
            return token;
        } catch (error) {
            console.error('❌ Error al obtener token para Mega Proyectos:', error.response?.data || error.message);
            throw error;
        }
    }

    // --- Paso 2: Obtener Datos de Mega Proyectos (Sin cambios) ---
    async getZohoProjectData(accessToken, offset = 0) {
        const query = {
            select_query: `
                SELECT
                    id, Name, Direccion_MP, Slogan_comercial, Descripcion,
                    Record_Image, Latitud_MP, Longitud_MP
                FROM Mega_Proyectos
                WHERE Mega_proyecto_comercial = true
                LIMIT ${offset}, 200
            `
        };
        try {
            const response = await axios.post(`${this.zohoConfig.baseURL}/coql`, query, {
                headers: {
                    Authorization: `Zoho-oauthtoken ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            });
            const info = response.data.info;
            const data = response.data.data || [];
            console.log(`✅ Recuperados ${data.length} Mega Proyectos de Zoho (offset ${offset})`);
            return { data, more: info?.more_records === true, count: info?.count || 0 };
        } catch (error) {
            console.error('❌ Error al ejecutar COQL para Mega Proyectos:', error.response?.data || error.message);
            throw error;
        }
    }

    // --- Paso 3: Obtener Atributos (Sin cambios) ---
    async getAttributesFromZoho(accessToken, parentId) {
         try {
            const response = await axios.get(
                `${this.zohoConfig.baseURL}/Atributos_Mega_Proyecto/search?criteria=Parent_Id.id:equals:${parentId}`, {
                headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
                validateStatus: status => [200, 204].includes(status)
            });
            if (response.status === 204 || !response.data?.data) {
                return null;
            }
            return response.data.data;
        } catch (error) {
            console.error(`❌ Error CRÍTICO al intentar obtener atributos para Mega Proyecto ID ${parentId}:`, error.response?.data || error.message);
            throw error;
        }
    }

    // --- Paso 4: Insertar/Actualizar Mega Proyecto (MODIFICADO) ---
    async insertMegaProjectIntoPostgres(project, accessToken) {
        if (!project || !project.id) {
            console.log('⚠️ Se intentó insertar un Mega Proyecto inválido o sin ID. Omitiendo.');
            return;
        }

        const client = await this.pool.connect();
        try {
            const attributesData = await this.getAttributesFromZoho(accessToken, project.id);

            const insertQuery = `
                INSERT INTO public."Mega_Projects" (
                    id, name, address, slogan, description, "attributes",
                    gallery, latitude, longitude, is_public
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
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

            // Preparar los atributos como un string separado por comas
            let attributesAsText = null;
            if (attributesData && attributesData.length > 0) {
                const attributeIds = attributesData.map(attr => attr.Atributo?.id).filter(Boolean);
                if (attributeIds.length > 0) {
                    attributesAsText = attributeIds.join(',');
                }
            }
            
            // Los demás campos se toman directamente o con un valor por defecto
            const values = [
                project.id,
                project.Name || '',
                project.Direccion_MP || null,                
                project.Slogan_comercial || null,
                project.Descripcion || null,
                attributesAsText, // Atributos como "id1,id2,id3"
                project.Record_Image || null, // Galería como "url1,url2,url3"
                parseFloat(project.Latitud_MP) || 0,
                parseFloat(project.Longitud_MP) || 0,
                true // Se establece is_public a true por defecto
            ];

            await client.query(insertQuery, values);
            console.log(`✅ Mega Proyecto insertado/actualizado (ID: ${project.id}): ${project.Name}`);

        } catch (error) {
            console.error(`❌ Error procesando Mega Proyecto ID ${project?.id} (${project?.Name}):`, error.message);
        } finally {
            client.release();
        }
    }

    // --- Paso 5: Método principal (Sin cambios) ---
    async run() {
        try {
            console.log('🚀 Iniciando sincronización de Mega Proyectos...');
            const token = await this.getZohoAccessToken();

            let offset = 0;
            let more = true;
            while (more) {
                const { data: projects, more: hasMore } = await this.getZohoProjectData(token, offset);
                if (!projects || projects.length === 0) break;

                // Usamos Promise.all para procesar los proyectos de cada página en paralelo
                const processingPromises = projects.map(project => this.insertMegaProjectIntoPostgres(project, token));
                await Promise.all(processingPromises);

                more = hasMore;
                offset += 200;
            }
            console.log(`✅ Sincronización de Mega Proyectos finalizada.`);
        } catch (error) {
            console.error('🚨 ERROR CRÍTICO durante la sincronización de Mega Proyectos. El proceso se detuvo.', error);
        } finally {
            if (this.pool) {
                await this.pool.end();
                console.log('🔌 Pool de conexiones PostgreSQL para Mega Proyectos cerrado.');
            }
        }
    }
}

module.exports = ZohoToPostgresSync;