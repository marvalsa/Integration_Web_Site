require('dotenv').config();
const { Pool } = require('pg');
const axios = require('axios');
const logger = require('./logs/logger');

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

    // (getZohoAccessToken - sin cambios, está bien)
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

    // (getZohoProjects - sin cambios, está bien)
    async getZohoProjects(accessToken, offset = 0) {
        const coqlQueryObject = {
            select_query: `
                SELECT
                    id, Name, Slogan, Direccion, Descripcion_corta, Descripcion_larga,
                    SIG, Sala_de_ventas.Name, Cantidad_SMMLV, Descripcion_descuento,
                    Precios_desde, Precios_hasta, Tipo_de_proyecto, Mega_Proyecto.id,
                    Estado, Proyecto_destacado, Area_construida_desde, Area_construida_hasta,
                    Habitaciones, Ba_os, Latitud, Longitud, Ciudad.id
                FROM Proyectos_Comerciales
                WHERE id is not null                
                LIMIT ${offset}, 200
            `
        };

        try {
            const response = await axios.post(
                `${this.zohoConfig.baseURL}/coql`,
                coqlQueryObject,
                {
                    headers: {
                        Authorization: `Zoho-oauthtoken ${accessToken}`,
                        'Content-Type': 'application/json'
                    }
                }
            );
            const info = response.data.info;
            const data = response.data.data || [];
            logger.info(`✅ Recuperados ${data.length} proyectos de Zoho (offset ${offset})`);
            return { data, more: info?.more_records === true, count: info?.count || 0 };
        } catch (error) {
            logger.error('❌ Error al ejecutar COQL para Proyectos:', error.response?.data || error.message);
            throw error;
        }
    }

    // (getProjectAttributes - sin cambios, está bien)
    async getProjectAttributes(accessToken, parentId) {
        try {
            const response = await axios.get(
                `${this.zohoConfig.baseURL}/Atributos/search?criteria=(Parent_Id.id:equals:${parentId})`,
                {
                    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
                    validateStatus: status => [200, 204].includes(status)
                }
            );

            if (response.status === 204) {
                logger.debug(`ℹ️ Sin atributos (Zoho 204) para proyecto ID ${parentId}`);
                return null;
            }
            
            const attributesData = response.data?.data;
            if (!attributesData || attributesData.length === 0) {
                logger.debug(`ℹ️ Atributos vacíos para proyecto ID ${parentId}`);
                return null;
            }
            
            const attributeIds = attributesData.map(attribute => {
                if (attribute.Atributo && attribute.Atributo.id) {
                    return attribute.Atributo.id;
                }
                logger.warn(`⚠️ Atributo sin ID en registro: ${attribute.id}`);
                return null;
            }).filter(id => id !== null);

            logger.debug(`✅ IDs de atributos recuperados: ${attributeIds.length}`);
            return attributeIds;

        } catch (error) {
            logger.error(`❌ Error al obtener atributos:`, error.response?.data || error.message);
            throw error;
        }
    }

    async insertProjectIntoPostgres(project, accessToken) {
        // (el resto de la función es igual hasta la preparación de datos)
        if (!project || !project.id) {
            logger.warn('⚠️ Se intentó insertar un proyecto inválido o sin ID. Omitiendo.');
            return { success: false, hc: null, errorType: 'invalid_data' };
        }

        const client = await this.pool.connect();
        const hcValue = project.id;

        try {
            const attributeIdsArray = await this.getProjectAttributes(accessToken, project.id);

            const insertQuery = `
                INSERT INTO public."Projects" (
                    hc, name, slogan, address, small_description, long_description, sic,
                    sales_room_name, salary_minimum_count, discount_description, price_from_general,
                    price_up_general, "type", mega_project_id, status, highlighted, built_area,
                    private_area, rooms, bathrooms, latitude, longitude, is_public, "attributes", city
                ) VALUES (
                    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25
                )
                ON CONFLICT (hc) DO UPDATE SET
                    name = EXCLUDED.name, slogan = EXCLUDED.slogan, address = EXCLUDED.address,
                    small_description = EXCLUDED.small_description, long_description = EXCLUDED.long_description,
                    sic = EXCLUDED.sic, sales_room_name = EXCLUDED.sales_room_name,
                    salary_minimum_count = EXCLUDED.salary_minimum_count, discount_description = EXCLUDED.discount_description,
                    price_from_general = EXCLUDED.price_from_general, price_up_general = EXCLUDED.price_up_general,
                    "type" = EXCLUDED.type, mega_project_id = EXCLUDED.mega_project_id, status = EXCLUDED.status,
                    highlighted = EXCLUDED.highlighted, built_area = EXCLUDED.built_area, private_area = EXCLUDED.private_area,
                    rooms = EXCLUDED.rooms, bathrooms = EXCLUDED.bathrooms, latitude = EXCLUDED.latitude,
                    longitude = EXCLUDED.longitude, is_public = EXCLUDED.is_public, "attributes" = EXCLUDED.attributes,
                    city = EXCLUDED.city;
            `;

            // --- Preparación de datos (CON CORRECCIONES Y MEJORAS) ---

            // <<< MEJORA: Usar encadenamiento opcional `?.` para Mega_Proyecto.id también, por si viene nulo.
            const megaProjectId = project['Mega_Proyecto.id'] || null;
            
            // <<< CORRECCIÓN PRINCIPAL: Acceder a 'Ciudad.id' como una clave de string.
            const cityId = project['Ciudad.id'] || null;

            const latitude = parseFloat(project.Latitud) || 0;
            const longitude = parseFloat(project.Longitud) || 0;
            const builtArea = parseFloat(project.Area_construida_desde) || 0;
            const privateArea = parseFloat(project.Area_construida_hasta) || 0;
            const roomsValue = Array.isArray(project.Habitaciones)
                            ? Math.max(0, ...project.Habitaciones.map(n => parseInt(n, 10)).filter(Number.isFinite))
                            : parseInt(project.Habitaciones, 10) || 0;
            const bathroomsValue = Array.isArray(project['Ba_os'])
                            ? Math.max(0, ...project['Ba_os'].map(n => parseInt(n, 10)).filter(Number.isFinite))
                            : parseInt(project['Ba_os'], 10) || 0;
            
            const attributesJson = attributeIdsArray ? JSON.stringify(attributeIdsArray) : null;

            // Lógica para 'status' (sin cambios, ya estaba bien)
            const statusMap = {
                'sobre planos': '1000000000000000001',
                'en construccion': '1000000000000000002',
                'lanzamiento ': '1000000000000000003',
                'entrega inmediata': '1000000000000000004'
            };
            let statusForDb = null;
            const statusFromZoho = project.Estado;
            if (statusFromZoho && typeof statusFromZoho === 'string') {
                const normalizedStatus = statusFromZoho.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
                const statusId = statusMap[normalizedStatus];
                if (statusId) {
                    statusForDb = JSON.stringify([statusId]);
                }
            }

            const values = [
                hcValue, project.Name || '', project.Slogan || '', project.Direccion || '',
                project.Descripcion_corta || '', project.Descripcion_larga || '', project.SIG || '',
                project['Sala_de_ventas.Name'] || '', parseInt(project.Cantidad_SMMLV, 10) || 0,
                project.Descripcion_descuento || '', parseFloat(project.Precios_desde) || 0,
                parseFloat(project.Precios_hasta) || 0, project.Tipo_de_proyecto || '',
                megaProjectId,
                statusForDb,
                project.Proyecto_destacado || false, builtArea, privateArea,
                roomsValue, bathroomsValue, latitude, longitude,
                false, attributesJson,
                cityId // <<< CORRECCIÓN: Usar la variable `cityId` preparada
            ];

            await client.query(insertQuery, values);
            logger.info(`✅ Proyecto insertado/actualizado (HC: ${hcValue}): ${project.Name}`);
            return { success: true, hc: hcValue };

        } catch (error) {
            // <<< MEJORA: Añadir una comprobación de FK para la ciudad también.
            if (error.code === '23503' && error.constraint === 'Projects_city_fkey') {
                logger.warn(`⚠️ OMITIENDO Proyecto HC ${hcValue} (${project?.Name}) debido a violación de FK 'Projects_city_fkey'. La ciudad con id '${project['Ciudad.id']}' no existe en la tabla "Cities".`);
                return { success: false, hc: hcValue, errorType: 'foreign_key_violation', constraint: 'Projects_city_fkey', value: project['Ciudad.id'] };
            }
            if (error.code === '23503' && error.constraint === 'Projects_mega_project_id_fkey') {
                logger.warn(`⚠️ OMITIENDO Proyecto HC ${hcValue} (${project?.Name}) debido a violación de FK 'Projects_mega_project_id_fkey'. El mega_project_id '${project['Mega_Proyecto.id']}' no existe en "Mega_Projects".`);
                return { success: false, hc: hcValue, errorType: 'foreign_key_violation', constraint: 'Projects_mega_project_id_fkey', value: project['Mega_Proyecto.id'] };
            } else if (error.code === '23505' && error.constraint === 'Projects_pkey') {
                logger.warn(`⚠️ OMITIENDO Proyecto HC ${hcValue} (${project?.Name}) debido a violación de PK 'Projects_pkey'. Este HC ya existe y la lógica ON CONFLICT debería haberlo manejado. Revisar. Error: ${error.message}`);
                return { success: false, hc: hcValue, errorType: 'primary_key_violation', constraint: 'Projects_pkey' };
            }
            // <<< MEJORA: Loguear el error original completo en el catch final para más detalles.
            logger.error(`❌ Error procesando proyecto HC ${hcValue} (${project?.Name}):`, error);
            return { success: false, hc: hcValue, errorType: 'other_db_error', message: error.message };
        } finally {
            client.release();
        }
    }
    
    // (getTypologiesFromZoho - sin cambios, está bien)
    async getTypologiesFromZoho(accessToken, parentId) {
        // ...código sin cambios...
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
                return [];
            }
            const typologiesData = response.data.data;
            logger.debug(`✅ Tipologías recuperadas (${typologiesData.length}) para proyecto ID ${parentId} (módulo Tipologias)`);
            return typologiesData;
        } catch (error) {
            logger.error(`❌ Error crítico al obtener tipologías (módulo Tipologias) del proyecto ID ${parentId}:`, error.response?.data || error.message);
            throw error;
        }
    }

    // (insertTypologies - sin cambios, está bien)
    async insertTypologies(projectHc, projectIdZoho, typologies) {
        // ...código sin cambios...
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

                const builtAreaTyp = parseFloat(t.Area_construida) || 0;
                const privateAreaTyp = parseFloat(t.Area_privada) || 0;

                const values = [
                    t.id, 
                    projectHc, 
                    t.Nombre || '', 
                    t.Descripci_n || '',
                    parseFloat(t.Precio_desde) || 0,
                    0, 
                    parseInt(t.Habitaciones, 10) || 0, 
                    parseInt(t.Ba_os, 10) || 0,
                    builtAreaTyp, 
                    privateAreaTyp,
                    null, 
                    null 
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

    // (run - sin cambios, está bien)
    async run() {
        // ...código sin cambios...
        let connectionClosed = false;
        let totalProyectosZoho = 0;
        let proyectosProcesadosConExito = 0;
        const proyectosFallidosDetalles = [];
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
                const { data: projectsFromZoho, more: hasMore, count } = await this.getZohoProjects(token, offset);
                if (offset === 0 && count) {
                    logger.info(`ℹ️ Zoho reporta un total aproximado de ${count} proyectos.`);
                }

                if (!projectsFromZoho || projectsFromZoho.length === 0) {
                    logger.info(`ℹ️ No se encontraron más Proyectos en Zoho (offset: ${offset}). Finalizando bucle de obtención.`);
                    break;
                }
                
                totalProyectosZoho += projectsFromZoho.length;
                logger.info(`ℹ️ Procesando lote de ${projectsFromZoho.length} Proyectos de Zoho (offset: ${offset})...`);

                for (const project of projectsFromZoho) {
                    try {
                        if (!project || !project.id) {
                            logger.warn(`⚠️ Proyecto inválido o sin ID en lote de Zoho (offset: ${offset}). Omitiendo.`);
                            proyectosFallidosDetalles.push({
                                hc: project?.id || 'ID Desconocido',
                                name: project?.Name || 'Nombre Desconocido',
                                reason: 'Datos inválidos o sin ID desde Zoho.',
                                details: 'El objeto del proyecto estaba malformado o le faltaba el ID.'
                            });
                            continue;
                        }

                        logger.debug(`⏳ Procesando Proyecto HC: ${project.id} (${project.Name})...`);
                        
                        const insertResult = await this.insertProjectIntoPostgres(project, token);

                        if (insertResult.success) {
                            const typologies = await this.getTypologiesFromZoho(token, project.id);
                            if (typologies && typologies.length > 0) {
                                await this.insertTypologies(project.id, project.id, typologies);
                            }
                            logger.debug(`🏁 Proyecto HC: ${project.id} (${project.Name}) y sus tipologías procesados con éxito.`);
                            proyectosProcesadosConExito++;
                        } else {
                            logger.warn(`🚨 Proyecto HC: ${project.id} (${project.Name}) NO fue procesado en DB. Razón: ${insertResult.errorType}. Ver logs anteriores.`);
                            proyectosFallidosDetalles.push({
                                hc: project.id,
                                name: project.Name,
                                reason: `Fallo al insertar/actualizar en DB: ${insertResult.errorType}`,
                                details: insertResult.constraint ? `Constraint: ${insertResult.constraint}, Valor: ${insertResult.value}` : insertResult.message || 'Error desconocido en DB'
                            });
                        }

                    } catch (errorInternoAlProcesarProyecto) {
                        logger.error(`🚨 Error INESPERADO procesando el ciclo del Proyecto HC: ${project?.id || 'ID desconocido'}. Este proyecto se marcará como fallido. Error: ${errorInternoAlProcesarProyecto.message}`);
                        proyectosFallidosDetalles.push({
                            hc: project?.id || 'ID Desconocido',
                            name: project?.Name || 'Nombre Desconocido',
                            reason: 'Error inesperado durante el procesamiento del proyecto (ej. tipologías).',
                            details: errorInternoAlProcesarProyecto.stack
                        });
                    }
                }

                more = hasMore;
                if (!more) {
                    logger.info('ℹ️ No hay más registros de Proyectos indicados por Zoho.');
                }
                offset += 200;
            }

            logger.info('✅ Sincronización de Proyectos y Tipologías finalizada.');
            logger.info('------------------- RESUMEN DE SINCRONIZACIÓN -------------------');
            logger.info(`📊 Total de proyectos recuperados de Zoho: ${totalProyectosZoho}`);
            logger.info(`✅ Proyectos procesados con éxito (insertados/actualizados en DB): ${proyectosProcesadosConExito}`);
            logger.info(`❌ Proyectos con errores (omitidos o con fallos): ${proyectosFallidosDetalles.length}`);

            if (proyectosFallidosDetalles.length > 0) {
                logger.warn("⚠️ Detalles de los proyectos con errores:");
                proyectosFallidosDetalles.forEach(fallo => {
                    logger.warn(`  - HC: ${fallo.hc}, Nombre: ${fallo.name}, Razón: ${fallo.reason}${fallo.details ? `, Detalles: ${fallo.details}` : ''}`);
                });
                logger.warn("--------------------------------------------------------------------");
            } else if (totalProyectosZoho > 0) {
                logger.info("🎉 Todos los proyectos de Zoho se procesaron exitosamente.");
            } else {
                logger.info("ℹ️ No se encontraron proyectos en Zoho para procesar.");
            }
            logger.info('--------------------------------------------------------------------');

        } catch (errorGeneral) {
            logger.error('🚨 ERROR CRÍTICO GENERAL durante la sincronización de Proyectos/Tipologías. El proceso se detuvo.', errorGeneral);
            throw errorGeneral;
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

// (Bloque para ejecución directa sin cambios)
if (require.main === module) {
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