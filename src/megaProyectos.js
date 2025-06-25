require('dotenv').config();
const { Pool } = require('pg');
const axios = require('axios');


// Nombre de clase: ZohoToPostgresSync está bien si es un nombre genérico,
// pero MegaProyectosSync sería más descriptivo si esta clase *solo* maneja eso.
class ZohoToPostgresSync {
    constructor() {
        // Configuración del Pool: Parece estándar y correcto.
        this.pool = new Pool({
            host: process.env.PG_HOST,
            database: process.env.PG_DATABASE,
            user: process.env.PG_USER,
            password: process.env.PG_PASSWORD,
            port: process.env.PG_PORT || 5432,
            ssl: process.env.PG_SSL === 'true' ? { rejectUnauthorized: false } : false
        });

        // Configuración de Zoho: Parece estándar y correcto.
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
            // Llamada a Zoho para refrescar token: URL y parámetros son correctos.
            const response = await axios.post( // <--- Falta el cuerpo de la llamada (POST) pero los parámetros están bien
                 'https://accounts.zoho.com/oauth/v2/token',
                 null, // Body es null para refresh token grant
                 {
                     params: {
                         refresh_token: this.zohoConfig.refreshToken,
                         client_id: this.zohoConfig.clientId,
                         client_secret: this.zohoConfig.clientSecret,
                         grant_type: 'refresh_token'
                     }
                 }
            );
            // Respuesta esperada: response.data debe contener access_token.
            const token = response.data.access_token;
            if (!token) throw new Error('Access token no recibido'); // Buena validación.
            console.log('✅ Token obtenido para Mega Proyectos');
            return token;
        } catch (error) {
            // Manejo de error: Loguea y relanza, correcto para detener el proceso si falla.
            console.error('❌ Error al obtener token para Mega Proyectos:', error.response?.data || error.message);
            throw error;
        }
    }

    // --- Paso 2: Obtener Datos de Mega Proyectos (Paginado) ---
    async getZohoProjectData(accessToken, offset = 0) {
        // Query COQL: Define los campos a obtener.
        const query = {
            select_query: `
                SELECT
                    id, Name, Direccion_MP, Slogan_comercial, Descripcion,
                    Record_Image, Latitud_MP, Longitud_MP
                FROM Mega_Proyectos
                WHERE Mega_proyecto_comercial = true
                LIMIT ${offset}, 200
            `
        }; // <--- Query COQL estaba como comentario /* ... */, asegurémonos que esté completa

        // *** ¡VERIFICACIÓN IMPORTANTE! ***
        // ¿Son estos *todos* los campos de `Mega_Proyectos` que necesitas
        // para la inserción en `insertMegaProjectIntoPostgres`?
        // Comparando con `insertMegaProjectIntoPostgres`:
        // - id -> OK
        // - Name -> OK (para `name`)
        // - Direccion_MP -> OK (para `address`)
        // - Slogan_comercial -> OK (para `slogan`)
        // - Descripcion -> OK (para `description`)
        // - Record_Image -> OK (para `gallery`)
        // - Latitud_MP -> OK (para `latitude`)
        // - Longitud_MP -> OK (para `longitude`)
       

        try {
            // Llamada a Zoho (COQL): URL, body (query), headers (token) son correctos.
             const response = await axios.post( // <--- Falta el cuerpo de la llamada (POST)
                 `${this.zohoConfig.baseURL}/coql`,
                 query, // El cuerpo es el objeto con select_query
                 {
                     headers: {
                         Authorization: `Zoho-oauthtoken ${accessToken}`,
                         'Content-Type': 'application/json'
                     }
                 }
             );
            // Respuesta esperada: response.data.data (array de proyectos) y response.data.info (paginación).
            const info = response.data.info;
            const data = response.data.data || []; // Buen default a array vacío.
            console.log(`✅ Recuperados ${data.length} Mega Proyectos de Zoho (offset ${offset})`);
            // Retorna los datos y la info de paginación. Correcto.
            return { data, more: info?.more_records === true, count: info?.count || 0 };
        } catch (error) {
            // Manejo de error: Loguea y relanza, correcto para detener el proceso si falla COQL.
            console.error('❌ Error al ejecutar COQL para Mega Proyectos:', error.response?.data || error.message);
            throw error;
        }
    }

    // --- Paso 3: Obtener Atributos (para un Mega Proyecto específico) ---
    async getAttributesFromZoho(accessToken, parentId) {
        try {
            // Llamada a Zoho (Search API): URL y headers correctos. GET es correcto.
            // Criterio `Parent_Id.id:equals:${parentId}` es correcto para subformularios/related lists.
            const response = await axios.get(
                `${this.zohoConfig.baseURL}/Atributos_Mega_Proyecto/search?criteria=Parent_Id.id:equals:${parentId}`,
                {
                    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
                    validateStatus: status => [200, 204].includes(status) // Maneja OK y No Content.
                }
            );

            // Manejo de Respuesta:
            // Caso 1: 204 No Content -> Devuelve null (Válido, sin atributos). Correcto.
            if (response.status === 204) {
                console.log(`ℹ️ Sin atributos (Zoho 204) para Mega Proyecto ID ${parentId}`);
                return null;
            }

            // Caso 2: 200 OK, pero sin datos -> Devuelve null (Válido, sin atributos). Correcto.
            const attributesData = response.data?.data;
            if (!attributesData || attributesData.length === 0) {
                 console.log(`ℹ️ Atributos vacíos (Zoho 200 OK, pero sin data) para Mega Proyecto ID ${parentId}`);
                 return null;
            }

            // Caso 3: 200 OK con datos -> Devuelve los datos. Correcto.
            console.log(`✅ Atributos recuperados para Mega Proyecto ID ${parentId}`);
            return attributesData;

        } catch (error) {
            // Manejo de error: Loguea y relanza. Correcto para detener si falla la *obtención*.
            console.error(`❌ Error CRÍTICO al intentar obtener atributos para Mega Proyecto ID ${parentId}:`, error.response?.data || error.message);
            throw error;
        }
    }

    // --- Paso 4: Insertar/Actualizar Mega Proyecto en PostgreSQL ---
    async insertMegaProjectIntoPostgres(project, accessToken) {
        if (!project || !project.id) {
            console.log('⚠️ Se intentó insertar un Mega Proyecto inválido o sin ID. Omitiendo.');
            return;
        }

        const client = await this.pool.connect();
        try {
            const attributes = await this.getAttributesFromZoho(accessToken, project.id);

            const insertQuery = `
                INSERT INTO public."Mega_Projects" (
                    id, name, address, slogan, description, "attributes",
                    gallery, latitude, longitude, is_public
                ) VALUES (
                    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
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

            const latitude = parseFloat(project.Latitud_MP) || 0;
            const longitude = parseFloat(project.Longitud_MP) || 0;
            
            let galleryJson = JSON.stringify([]);
            if (project.Record_Image && typeof project.Record_Image === 'string') {
                galleryJson = JSON.stringify(
                    project.Record_Image.split(',')
                        .map(item => item.trim())
                        .filter(Boolean)
                );
            }
            
            // CORRECCIÓN: Procesamiento de atributos
            let attributesJson = null;
            if (attributes && attributes.length > 0) {
                const attributeIds = attributes.map(attr => {
                    // Acceso seguro a Atributo.id
                    if (attr.Atributo && attr.Atributo.id) {
                        return attr.Atributo.id;
                    }
                    console.log(`⚠️ Atributo sin ID válido en registro: ${attr.id || 'sin ID'}`);
                    return null;
                }).filter(id => id !== null);  // Filtrar nulos
                
                attributesJson = attributeIds.length > 0 
                    ? JSON.stringify(attributeIds) 
                    : null;
            }

            const values = [
                project.id,
                project.Name || '',
                project.Direccion_MP || '',
                project.Slogan_comercial || '',
                project.Descripcion || '',
                attributesJson,  // JSON array de IDs o null
                galleryJson,
                latitude,
                longitude,
                false
            ];

            await client.query(insertQuery, values);
            console.log(`✅ Mega Proyecto insertado/actualizado (ID: ${project.id}): ${project.Name}`);

        } catch (error) {
            console.error(`❌ Error procesando Mega Proyecto ID ${project?.id} (${project?.Name}):`, error.message);
            throw error;
        } finally {
            client.release();
        }
    }

    // --- Paso 5: Orquestador Principal (`run`) ---
    async run() {
        let connectionClosed = false;
        let totalProcesados = 0;
        let totalInsertados = 0;
        let token; // Definir fuera para que esté disponible en finally si es necesario

        try {
            console.log('🚀 Iniciando sincronización de Mega Proyectos...');
            // 1. Verificar conexión a DB
            const client = await this.pool.connect(); // Intenta conectar
            console.log('✅ Conexión a PostgreSQL verificada para Mega Proyectos.');
            client.release(); // Libera la conexión de prueba

            // 2. Obtener Token (falla aquí, se detiene todo)
            token = await this.getZohoAccessToken();

            // 3. Bucle de Paginación
            let offset = 0;
            let more = true;
            while (more) {
                // Obtener lote de datos (falla aquí, se detiene todo)
                const { data: projects, more: hasMore } = await this.getZohoProjectData(token, offset);

                // Condición de salida del bucle (si no hay proyectos)
                if (!projects || projects.length === 0) {
                    console.log(`ℹ️ No se encontraron más Mega Proyectos en Zoho (offset: ${offset}). Finalizando bucle.`);
                    break; // Salir del while
                }

                console.log(`ℹ️ Procesando lote de ${projects.length} Mega Proyectos (offset: ${offset})...`);

                // 4. Procesar cada proyecto del lote
                for (const project of projects) {
                    totalProcesados++;
                    try {
                        // Intentar insertar/actualizar (puede fallar por atributos o DB)
                        await this.insertMegaProjectIntoPostgres(project, token);
                        totalInsertados++; // Contar solo si no hubo error
                        console.log(`🏁 Mega Proyecto ID: ${project.id} procesado con éxito.`);
                    } catch (insertError) {
                        // Manejo de error por proyecto:
                        // Opción Actual: Detener toda la sincronización. Correcto para tu requisito.
                        console.error(`🚨 Falló el procesamiento del Mega Proyecto ID: ${project?.id || 'ID desconocido'}. Deteniendo sincronización general.`);
                        throw insertError; // Propaga para activar el catch principal y detener 'run'.
                    }
                } // Fin for (procesamiento del lote)

                // Actualizar estado de paginación y offset
                more = hasMore;
                if (!more) {
                    console.log('ℹ️ No hay más registros de Mega Proyectos indicados por Zoho.');
                    // El bucle terminará en la siguiente iteración.
                }
                offset += 200; // Incrementar offset para la siguiente página

            } // Fin while (paginación)

            console.log(`✅ Sincronización de Mega Proyectos finalizada. ${totalInsertados} de ${totalProcesados} procesados exitosamente (o detenida por error si totalInsertados < totalProcesados).`);

        } catch (error) {
            // Captura errores críticos (conexión, token, COQL) o errores propagados de la inserción.
            console.error('🚨 ERROR CRÍTICO durante la sincronización de Mega Proyectos. El proceso se detuvo.', error);
            // Relanzar para que el script que llamó a run() (el IIFE) se entere. Correcto.
            throw error;

        } finally {
            // Cierre del pool: Se ejecuta siempre (éxito o error). Correcto y robusto.
            if (this.pool && !connectionClosed) {
                console.log('🔌 Cerrando pool de conexiones PostgreSQL para Mega Proyectos...');
                await this.pool.end().catch(err => console.error('❌ Error al cerrar pool PG para Mega Proyectos:', err));
                connectionClosed = true;
                console.log('🔌 Pool de conexiones PostgreSQL cerrado.');
            }
        }
    }
}

module.exports = ZohoToPostgresSync;

