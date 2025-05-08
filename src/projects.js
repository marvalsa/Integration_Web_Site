require('dotenv').config();
const { Pool } = require('pg');
const axios = require('axios');
const logger = require('../logs/logger');
let contador = 1;

class ZohoToPostgresSyncProjects {
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

            logger.info('✅ Token obtenido correctamente');
            return token;
        } catch (error) {
            logger.error('❌ Error al obtener token:', error.response?.data || error.message);
            throw error;
        }
    }

    async getZohoProjects(accessToken, offset = 0) {
        const query = {
            select_query: `
                SELECT id, Name, Slogan, Direccion, Descripcion_corta, Descripcion_larga, SIG, Sala_de_ventas.Name, 
                       Cantidad_SMMLV, Descripcion_descuento, Precios_desde, Precios_hasta, Tipo_de_proyecto, 
                       Mega_Proyecto.id, Estado, Proyecto_destacado, Area_construida_desde, Area_construida_hasta,
                       Habitaciones, Ba_os, Latitud, Longitud
                FROM Proyectos_Comerciales 
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

            logger.info(`✅ Recuperados ${data.length} proyectos en offset ${offset}`);
            return {
                data,
                more: info?.more_records === true,
                count: info?.count || 0
            };
        } catch (error) {
            logger.error('❌ Error al ejecutar COQL para proyectos:', error.response?.data || error.message);
            throw error;
        }
    }

    async getProjectAttributes(accessToken, parentId) {
        try {
            const response = await axios.get(
                `${this.zohoConfig.baseURL}/Atributos/search?criteria=Parent_Id.id:equals:${parentId}`,
                {
                    headers: {
                        Authorization: `Zoho-oauthtoken ${accessToken}`
                    },
                    validateStatus: status => [200, 204].includes(status)
                }
            );

            if (response.status === 204) {
                logger.info(`ℹ️ Sin atributos para proyecto ID ${parentId}`);
                return null;
            }

            logger.info(`✅ Atributos recuperados para proyecto ID ${parentId}`);
            return response.data.data || null;
        } catch (error) {
            logger.error(`❌ Error al obtener atributos para proyecto ID ${parentId}:`, error.response?.data || error.message);
            return null;
        }
    }
    
    async insertProjectIntoPostgres(project, accessToken) {
        const client = await this.pool.connect();
        try {
            const attributes = await this.getProjectAttributes(accessToken, project.id);

            const insertQuery = `
                INSERT INTO public."Projects" (
                    hc, name, slogan, address, small_description, long_description, sic,
                    sales_room_name, salary_minimum_count, discount_description, price_from_general,
                    price_up_general, "type", mega_project_id, status, highlighted, built_area,
                    private_area, rooms, bathrooms, latitude, longitude, is_public, "attributes"
                ) VALUES (
                    $1, $2, $3, $4, $5, $6, $7,
                    $8, $9, $10, $11,
                    $12, $13, $14, $15, $16, $17,
                    $18, $19, $20, $21, $22, $23, $24
                )
                ON CONFLICT (hc) DO UPDATE SET
                    name = EXCLUDED.name,
                    slogan = EXCLUDED.slogan,
                    address = EXCLUDED.address,
                    small_description = EXCLUDED.small_description,
                    long_description = EXCLUDED.long_description,
                    sic = EXCLUDED.sic,
                    sales_room_name = EXCLUDED.sales_room_name,
                    salary_minimum_count = EXCLUDED.salary_minimum_count,
                    discount_description = EXCLUDED.discount_description,
                    price_from_general = EXCLUDED.price_from_general,
                    price_up_general = EXCLUDED.price_up_general,
                    "type" = EXCLUDED."type",
                    mega_project_id = EXCLUDED.mega_project_id,
                    status = EXCLUDED.status,
                    highlighted = EXCLUDED.highlighted,
                    built_area = EXCLUDED.built_area,
                    private_area = EXCLUDED.private_area,
                    rooms = EXCLUDED.rooms,
                    bathrooms = EXCLUDED.bathrooms,
                    latitude = EXCLUDED.latitude,
                    longitude = EXCLUDED.longitude,
                    is_public = EXCLUDED.is_public,
                    "attributes" = EXCLUDED."attributes";
            `;
            
            // Obtener el valor máximo de Habitaciones y Ba_os
            const maxHabitaciones = Array.isArray(project.Habitaciones) ? Math.max(...project.Habitaciones) : project.Habitaciones || 0;
            const maxBa_os = Array.isArray(project['Ba_os']) ? Math.max(...project['Ba_os']) : project['Ba_os'] || 0;
            // Redondear áreas
            const builtArea = Math.round(project.Area_construida_desde || 0);
            const builtAreaHasta = Math.round(project.Area_construida_hasta || 0);
            // Latitudes y longitudes
            const latitude = !isNaN(parseFloat(project.Latitud)) ? Math.round(parseFloat(project.Latitud)) : 0;
            const longitude = !isNaN(parseFloat(project.Longitud)) ? Math.round(parseFloat(project.Longitud)) : 0;
            // Asignar el contador como ID
            const dynamicId = String(contador++).padStart(10, '0'); // Forzar la conversión a BigInt

            const values = [
                dynamicId,
                project.Name || '',
                project.Slogan || '',
                project.Direccion || '',
                project.Descripcion_corta || '',
                project.Descripcion_larga || '',
                project.SIG || '',
                project['Sala_de_ventas.Name'] || '',
                project.Cantidad_SMMLV || 0,
                project.Descripcion_descuento || '',
                project.Precios_desde || 0,
                project.Precios_hasta || 0,
                project.Tipo_de_proyecto || '',
                12334, // MegaProyecto ID
                project.Estado ? JSON.stringify(project.Estado) : null,
                project.Proyecto_destacado || false,
                builtArea,
                builtAreaHasta,
                maxHabitaciones, // Solo el número mayor de Habitaciones
                maxBa_os, // Solo el número mayor de Ba_os
                latitude,
                longitude,
                project.is_public || false,
                attributes ? JSON.stringify(attributes) : null
            ];

            await client.query(insertQuery, values);
            logger.info(`✅ Proyecto insertado/actualizado: ${project.Name}`);
        } catch (error) {
            logger.error(`❌ Error al insertar proyecto ID ${project.id}:`, error.message);
        } finally {
            client.release();
        }
    }

    async getTypologiesFromZoho(accessToken, parentId) {
        try {
            const response = await axios.get(
                `${this.zohoConfig.baseURL}/Tipologias/search?criteria=Parent_Id.id:equals:${parentId}`,
                {
                    headers: {
                        Authorization: `Zoho-oauthtoken ${accessToken}`
                    },
                    validateStatus: status => [200, 204].includes(status)
                }
            );

            if (response.status === 204 || !response.data.data) {
                logger.info(`ℹ️ Sin tipologías para proyecto ID ${parentId}`);
                return [];
            }

            logger.info(`✅ Tipologías recuperadas para proyecto ID ${parentId}`);
            return response.data.data;
        } catch (error) {
            logger.error(`❌ Error al obtener tipologías del proyecto ID ${parentId}:`, error.response?.data || error.message);
            return [];
        }
    }

    async insertTypologies(projectId, typologies) {
        if (!typologies || typologies.length === 0) return;

        const client = await this.pool.connect();
        try {
            for (const t of typologies) {
                const insertQuery = `
                    INSERT INTO public."Typologies" (
                        project_id, "name", description, price_from, price_up, rooms, bathrooms, built_area , private_area
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                    ON CONFLICT DO NOTHING;
                `;
                //Areas
                const builtAreaTyp = Math.round(t.Area_construida || 0);
                const builtAreaprivadaTyp = Math.round(t.Area_privada || 0);
                
                const values = [
                    1, // project_id
                    t.Nombre || '',
                    t.Descripci_n || '',
                    t.Precio_desde || 0,
                    0,
                    t.Habitaciones || 0,
                    t.Ba_os || 0,
                    builtAreaTyp || 0,
                    builtAreaprivadaTyp || 0
                ];

                await client.query(insertQuery, values);
            }
            logger.info(`✅ Tipologías insertadas para proyecto ID ${projectId}`);
        } catch (error) {
            logger.error(`❌ Error al insertar tipologías para proyecto ID ${projectId}:`, error.message);
            logger.error(`Project_id ${projectId}:`, error.message);
        } finally {
            client.release();
        }
    }

    async run() {
        try {
            const accessToken = await this.getZohoAccessToken();
            let offset = 0;
            let more = true;
    
            while (more) {
                const { data, more: hasMore } = await this.getZohoProjects(accessToken, offset);
                for (const project of data) {
                    await this.insertProjectIntoPostgres(project, accessToken);
                    const typologies = await this.getTypologiesFromZoho(accessToken, project.id);
                    await this.insertTypologies(project.id, typologies);
                }
                offset += 200;
                more = hasMore;
            }
    
            logger.info('🎉 Sincronización completa de proyectos y tipologías.');
        } catch (error) {
            logger.error('❌ Error en sincronización general:', error.message);
        }
    }
    
    // async syncProjects() {
    //     const accessToken = await this.getZohoAccessToken();
    //     let offset = 0;
    //     let more = true;
    
    //     while (more) {
    //         const { data, more: moreRecords } = await this.getZohoProjects(accessToken, offset);
    //         for (const project of data) {
    //             await this.insertProjectIntoPostgres(project, accessToken);
    
    //             // Tipologías asociadas
    //             const typologies = await this.getTypologiesFromZoho(accessToken, project.id);
    //             await this.insertTypologies(project.id, typologies);
    //         }
    //         offset += 200;
    //         more = moreRecords;
    //     }
    // }
    // async run() {
    //     await this.syncProjects();
    // }
    
}

module.exports = ZohoToPostgresSyncProjects;

if (require.main === module) {
    const sync = new ZohoToPostgresSyncProjects();
    sync.run();
}
