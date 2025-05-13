require('dotenv').config();
const { Pool } = require('pg');
const axios = require('axios');
const logger = require('../logs/logger');

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
            logger.info('✅ Token obtenido para sincronización de Proyectos');
            return token;
        } catch (error) {
            logger.error('❌ Error al obtener token para Proyectos:', error.response?.data || error.message);
            throw error;
        }
    }

    async getZohoProjects(accessToken, offset = 0) {
        // *** COQL QUERY COMPLETA Y CORRECTA PARA Proyectos_Comerciales ***
        const coqlQueryObject = { // Cambié el nombre de la variable para evitar confusión con 'query' de SQL
            select_query: `
                SELECT
                    id, Name, Slogan, Direccion, Descripcion_corta, Descripcion_larga,
                    SIG, Sala_de_ventas.Name, Cantidad_SMMLV, Descripcion_descuento,
                    Precios_desde, Precios_hasta, Tipo_de_proyecto, Mega_Proyecto.id,
                    Estado, Proyecto_destacado, Area_construida_desde, Area_construida_hasta,
                    Habitaciones, Ba_os, Latitud, Longitud
                FROM Proyectos_Comerciales
                WHERE id is not null                
                LIMIT ${offset}, 200
            `
        };
        // NOTA: Asegúrate que el campo 'is_public' exista en tu módulo `Proyectos_Comerciales` en Zoho CRM.        

        try {
            // *** LLAMADA AXIOS COMPLETA ***
            const response = await axios.post(
                `${this.zohoConfig.baseURL}/coql`,
                coqlQueryObject, // El cuerpo de la petición es el objeto con la select_query
                {
                    headers: {
                        Authorization: `Zoho-oauthtoken ${accessToken}`,
                        'Content-Type': 'application/json'
                    }
                }
            );
            // Manejo de la respuesta:
            const info = response.data.info;
            const data = response.data.data || []; // Default a array vacío
            logger.info(`✅ Recuperados ${data.length} proyectos de Zoho (offset ${offset})`);
            return { data, more: info?.more_records === true, count: info?.count || 0 };
        } catch (error) {
            logger.error('❌ Error al ejecutar COQL para Proyectos:', error.response?.data || error.message);
            throw error;
        }
    }

    async getProjectAttributes(accessToken, parentId) {
        // *** LLAMADA AXIOS COMPLETA PARA OBTENER ATRIBUTOS ***
        // Asume que el módulo de atributos se llama 'Atributos' y el campo de relación es 'Parent_Id'
        try {
            const response = await axios.get(
                `${this.zohoConfig.baseURL}/Atributos/search?criteria=(Parent_Id.id:equals:${parentId})`,
                {
                    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
                    validateStatus: status => [200, 204].includes(status)
                }
            );

            if (response.status === 204) {
                logger.debug(`ℹ️ Sin atributos (Zoho 204) para proyecto ID ${parentId} (módulo Atributos)`);
                return null;
            }
            const attributesData = response.data?.data;
            if (!attributesData || attributesData.length === 0) {
                 logger.debug(`ℹ️ Atributos vacíos (Zoho 200 OK, pero sin data) para proyecto ID ${parentId} (módulo Atributos)`);
                 return null;
            }
            logger.debug(`✅ Atributos recuperados (${attributesData.length}) para proyecto ID ${parentId} (módulo Atributos)`);
            return attributesData;
        } catch (error) {
            logger.error(`❌ Error crítico al obtener atributos (módulo Atributos) para proyecto ID ${parentId}:`, error.response?.data || error.message);
            throw error;
        }
    }

    async insertProjectIntoPostgres(project, accessToken) {
        if (!project || !project.id) {
             logger.warn('⚠️ Se intentó insertar un proyecto inválido o sin ID. Omitiendo.');
             return;
        }

        const client = await this.pool.connect();
        try {
            const attributes = await this.getProjectAttributes(accessToken, project.id);

            // Query SQL: (Añadido updated_at para buena práctica)
            const insertQuery = `
                INSERT INTO public."Projects" (
                    hc, name, slogan, address, small_description, long_description, sic,
                    sales_room_name, salary_minimum_count, discount_description, price_from_general,
                    price_up_general, "type", mega_project_id, status, highlighted, built_area,
                    private_area, rooms, bathrooms, latitude, longitude, is_public, "attributes"
                ) VALUES (
                    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24
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
                    "type" = EXCLUDED.type, 
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
                    "attributes" = EXCLUDED.attributes;
                   
            `;

            const hcValue = project.id;
            const megaProjectId = project['Mega_Proyecto.id'] || null;
            const latitude = parseFloat(project.Latitud) || 0;
            const longitude = parseFloat(project.Longitud) || 0;
            const builtArea = parseFloat(project.Area_construida_desde) || 0;
            // IMPORTANTE: Verifica la fuente de 'privateArea'.
            // Si 'Area_privada' es un campo distinto en Zoho, selecciónalo en getZohoProjects y úsalo aquí.
            // Ejemplo: const privateArea = parseFloat(project.Area_privada_Zoho) || 0;
            const privateArea = parseFloat(project.Area_construida_hasta) || 0;
            const roomsValue = Array.isArray(project.Habitaciones)
                               ? Math.max(0, ...project.Habitaciones.map(n => parseInt(n, 10)).filter(Number.isFinite))
                               : parseInt(project.Habitaciones, 10) || 0;
            const bathroomsValue = Array.isArray(project['Ba_os'])
                               ? Math.max(0, ...project['Ba_os'].map(n => parseInt(n, 10)).filter(Number.isFinite))
                               : parseInt(project['Ba_os'], 10) || 0;
            const attributesJson = attributes ? JSON.stringify(attributes) : null;

            // Los valores deben coincidir con los placeholders de la query (sin incluir CURRENT_TIMESTAMP explícitamente aquí)
            const values = [
                hcValue, 
                project.Name || '', 
                project.Slogan || '', 
                project.Direccion || '',
                project.Descripcion_corta || '', 
                project.Descripcion_larga || '', 
                project.SIG || '',
                project['Sala_de_ventas.Name'] || '', 
                parseInt(project.Cantidad_SMMLV, 10) || 0,
                project.Descripcion_descuento || '', 
                parseFloat(project.Precios_desde) || 0,
                parseFloat(project.Precios_hasta) || 0, 
                project.Tipo_de_proyecto || '',
                megaProjectId, 
                project.Estado ? JSON.stringify(project.Estado) : null,
                project.Proyecto_destacado || false, 
                builtArea, 
                privateArea,
                roomsValue, 
                bathroomsValue, 
                latitude, 
                longitude,
                false, // Depende de que 'is_public' se obtenga de Zoho module o se establezca manualmente
                attributesJson
            ];

            await client.query(insertQuery, values);
            logger.info(`✅ Proyecto insertado/actualizado (HC: ${hcValue}): ${project.Name}`);

        } catch (error) {
            logger.error(`❌ Error crítico procesando proyecto HC ${project?.id} (${project?.Name}):`, error.message);
            throw error;
        } finally {
            client.release();
        }
    }

    async getTypologiesFromZoho(accessToken, parentId) {
        // *** LLAMADA AXIOS COMPLETA PARA OBTENER TIPOLOGÍAS ***
        // Asume que el módulo de tipologías se llama 'Tipologias' y el campo de relación es 'Parent_Id'
        try {
            const response = await axios.get(
                `${this.zohoConfig.baseURL}/Tipologias/search?criteria=(Parent_Id.id:equals:${parentId})`,
                {
                    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
                    validateStatus: status => [200, 204].includes(status)
                }
            );

            if (response.status === 204 || !response.data?.data || response.data.data.length === 0) {
                logger.debug(`ℹ️ Sin tipologías (Zoho 204 o sin data) para proyecto ID ${parentId} (módulo Tipologias)`);
                return []; // Devuelve array vacío si no hay tipologías
            }
            const typologiesData = response.data.data;
            logger.debug(`✅ Tipologías recuperadas (${typologiesData.length}) para proyecto ID ${parentId} (módulo Tipologias)`);
            return typologiesData;
        } catch (error) {
            logger.error(`❌ Error crítico al obtener tipologías (módulo Tipologias) del proyecto ID ${parentId}:`, error.response?.data || error.message);
            throw error;
        }
    }

    async insertTypologies(projectHc, projectIdZoho, typologies) {
        if (!typologies || typologies.length === 0) {
             logger.debug(`ℹ️ No hay tipologías para insertar para proyecto HC ${projectHc}`);
             return;
        }

        const client = await this.pool.connect();
        let currentTypologyName = null;

        try {
            logger.info(`ℹ️ Iniciando inserción/actualización de ${typologies.length} tipologías para proyecto HC ${projectHc}...`);
            for (const t of typologies) {
                if (!t.id) {
                    logger.warn(`⚠️ Tipología sin ID encontrada para proyecto HC ${projectHc}. Omitiendo.`);
                    continue;
                }
                currentTypologyName = t.Nombre || t.id;

                // Query SQL: (Añadido updated_at)
                const insertQuery = `
                    INSERT INTO public."Typologies" (
                        id, project_id, "name", description, price_from, price_up,
                        rooms, bathrooms, built_area, private_area, plans, gallery
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                    ON CONFLICT (id) DO UPDATE SET
                        project_id = EXCLUDED.project_id, 
                        "name" = EXCLUDED.name, 
                        description = EXCLUDED.description,
                        price_from = EXCLUDED.price_from, 
                        price_up = EXCLUDED.price_up, 
                        rooms = EXCLUDED.rooms,
                        bathrooms = EXCLUDED.bathrooms, 
                        built_area = EXCLUDED.built_area,
                        private_area = EXCLUDED.private_area,
                        plans = EXCLUDED.plans,
                        gallery = EXCLUDED.gallery;

                `;

                // Verifica los nombres de campo en Zoho para tipologías:
                // t.Nombre, t.Descripci_n (¿con tilde?), t.Precio_desde, t.Habitaciones, t.Ba_os, t.Area_construida, t.Area_privada
                const builtAreaTyp = parseFloat(t.Area_construida) || 0;
                const privateAreaTyp = parseFloat(t.Area_privada) || 0;

                // Valores para la query (sin incluir CURRENT_TIMESTAMP explícitamente)
                const values = [
                    t.id, 
                    projectHc, 
                    t.Nombre || '', 
                    t.Descripci_n || '', // ¡Verifica t.Descripci_n!
                    parseFloat(t.Precio_desde) || 0,
                    0, // price_up - ¿Este valor es siempre 0 o debe venir de Zoho?
                    parseInt(t.Habitaciones, 10) || 0, 
                    parseInt(t.Ba_os, 10) || 0,
                    builtAreaTyp, 
                    privateAreaTyp,
                    null, // plans
                    null // gallery
                ];

                await client.query(insertQuery, values);
                logger.debug(`✅ Tipología ${t.id} (${t.Nombre}) insertada/actualizada para proyecto HC ${projectHc}`);
            }
            logger.info(`✅ ${typologies.length} tipologías procesadas para proyecto HC ${projectHc}`);

        } catch (error) {
            logger.error(`❌ Error crítico al insertar/actualizar tipología '${currentTypologyName}' para proyecto HC ${projectHc}:`, error.message);
            throw error;
        } finally {
            client.release();
        }
    }

    async run() {
        let connectionClosed = false;
        let totalProyectosProcesados = 0;
        let totalProyectosFallidos = 0;
        let token;

        try {
            logger.info('🚀 Iniciando sincronización de Proyectos Comerciales y Tipologías...');
            const client = await this.pool.connect();
            logger.info('✅ Conexión a PostgreSQL verificada para Proyectos.');
            client.release();
            token = await this.getZohoAccessToken();

            let offset = 0;
            let more = true;

            while (more) {
                const { data: projects, more: hasMore } = await this.getZohoProjects(token, offset);
                if (!projects || projects.length === 0) {
                     logger.info(`ℹ️ No se encontraron más Proyectos en Zoho (offset: ${offset}). Finalizando bucle.`);
                     break;
                }

                logger.info(`ℹ️ Procesando lote de ${projects.length} Proyectos (offset: ${offset})...`);

                for (const project of projects) {
                    totalProyectosProcesados++;
                    try {
                        if (!project || !project.id) {
                            logger.warn(`⚠️ Proyecto inválido o sin ID en lote de Zoho (offset: ${offset}). Omitiendo.`);
                            totalProyectosFallidos++;
                            continue;
                        }
                        logger.debug(`⏳ Procesando Proyecto HC: ${project.id} (${project.Name})...`);
                        await this.insertProjectIntoPostgres(project, token);
                        const typologies = await this.getTypologiesFromZoho(token, project.id);
                        await this.insertTypologies(project.id, project.id, typologies); // projectIdZoho no se usa en insertTypologies
                        logger.debug(`🏁 Proyecto HC: ${project.id} (${project.Name}) procesado con éxito.`);
                    } catch (projectError) {
                        totalProyectosFallidos++;
                        logger.error(`🚨 Falló el procesamiento completo del Proyecto HC: ${project?.id || 'ID desconocido'}. Deteniendo sincronización general.`);
                        throw projectError;
                    }
                }

                more = hasMore;
                if (!more) {
                    logger.info('ℹ️ No hay más registros de Proyectos indicados por Zoho.');
                }
                offset += 200;
            }

            logger.info('✅ Sincronización de Proyectos y Tipologías finalizada.');
            logger.info(`📊 Resumen: ${totalProyectosProcesados} proyectos intentados, ${totalProyectosFallidos} fallidos.`);
            if (totalProyectosFallidos > 0) {
                 logger.warn(`⚠️ La sincronización finalizó, pero ${totalProyectosFallidos} proyectos encontraron errores (deteniendo el proceso).`);
            } else {
                 logger.info("🎉 Todos los proyectos se procesaron exitosamente.");
            }
        } catch (error) {
            logger.error('🚨 ERROR CRÍTICO durante la sincronización de Proyectos/Tipologías. El proceso se detuvo.', error);
            throw error;
        } finally {
            if (this.pool && !connectionClosed) {
                logger.info('🔌 Cerrando pool de conexiones PostgreSQL para Proyectos...');
                await this.pool.end().catch(err => logger.error('❌ Error al cerrar pool PG para Proyectos:', err));
                connectionClosed = true;
                logger.info('🔌 Pool de conexiones PostgreSQL cerrado.');
            }
        }
    }
}

module.exports = ZohoToPostgresSyncProjects;

if (require.main === module) {
    const logger = require('../logs/logger');
    const ZohoToPostgresSyncProjects = require('./projects');

    logger.info("Ejecutando ZohoToPostgresSyncProjects directamente como script...");
    const sync = new ZohoToPostgresSyncProjects();

    sync.run()
        .then(() => {
            logger.info("Sincronización de Proyectos y Tipologías (ejecución directa) finalizada exitosamente.");
            process.exit(0);
        })
        .catch(error => {
            logger.error("--------------------------------------------------------------------");
            logger.error("ERROR FATAL en la ejecución directa de ZohoToPostgresSyncProjects:");
            logger.error(error);
            logger.error("--------------------------------------------------------------------");
            process.exit(1);
        });
}