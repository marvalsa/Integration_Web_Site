// test_conexiones.js
require('dotenv').config();
const { Pool } = require('pg');
const axios = require('axios');

class ZohoConnectionTester {
    constructor() {
        // Configurar conexión a PostgreSQL
        this.pool = new Pool({
            host: process.env.PG_HOST,
            database: process.env.PG_DATABASE,
            user: process.env.PG_USER,
            password: process.env.PG_PASSWORD,
            port: process.env.PG_PORT,
            ssl: process.env.PG_SSL === 'true' ? { rejectUnauthorized: false } : false
        });

        // Credenciales Zoho
        this.zohoConfig = {
            clientId: process.env.ZOHO_CLIENT_ID,
            clientSecret: process.env.ZOHO_CLIENT_SECRET,
            refreshToken: process.env.ZOHO_REFRESH_TOKEN,
            baseURL: 'https://www.zohoapis.com/crm/v2'
        };
    }

    async testPostgresConnection() {
        const client = await this.pool.connect();
        try {
            const res = await client.query('SELECT NOW() AS current_time');
            console.log('✅ PostgreSQL conectado. Hora actual:', res.rows[0].current_time);
            return true;
        } catch (error) {
            console.error('❌ Error PostgreSQL:', error.message);
            throw error;
        } finally {
            client.release();
        }
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

            if (!response.data.access_token) {
                throw new Error('No se recibió access token');
            }

            console.log('✅ Token Zoho obtenido. Expira en:', response.data.expires_in, 'segundos');
            return response.data.access_token;
        } catch (error) {
            console.error('❌ Error Zoho Auth:', error.response?.data || error.message);
            throw error;
        }
    }

    async testZohoCrmConnection(accessToken) {
        try {
            const query = `
                SELECT 
                    id 
                FROM 
                    Proyectos_Inmobiliarios 
                WHERE 
                    id is not null 
                LIMIT 0,200`;

            console.log('\n🔍 Ejecutando consulta COQL:');
            console.log('----------------------------------------');
            console.log(query.trim());
            console.log('----------------------------------------');

            const response = await axios.post(
                `${this.zohoConfig.baseURL}/coql`,
                { select_query: query },
                {
                    headers: {
                        Authorization: `Zoho-oauthtoken ${accessToken}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            const results = response.data.data || [];
            console.log('✅ Resultados COQL:', results);
            
            return {
                status: response.status,
                count: results.length,
                data: results
            };
        } catch (error) {
            console.error('❌ Error COQL:', error.response?.data || error.message);
            throw error;
        }
    }

    async fullConnectionTest() {
        try {
            console.log('\n=== Iniciando pruebas de conexión ===');
            
            // 1. Probar PostgreSQL
            await this.testPostgresConnection();
            
            // 2. Obtener token Zoho
            const accessToken = await this.getZohoAccessToken();
            
            // 3. Probar Zoho CRM
            const coqlResult = await this.testZohoCrmConnection(accessToken);
            
            console.log('\n=== Resumen final ===');
            console.log('PostgreSQL: ✔️ Conectado');
            console.log('Zoho CRM:   ✔️ Conectado');
            console.log('Proyectos:  🏗️', coqlResult.count, 'proyectos encontrados');
            
            return true;
        } catch (error) {
            console.error('\n=== Pruebas fallidas ===');
            throw error;
        } finally {
            await this.pool.end();
        }
    }
}

// Ejecutar pruebas
(async () => {
    try {
        const tester = new ZohoConnectionTester();
        await tester.fullConnectionTest();
        console.log('\n✨ Todas las pruebas completadas exitosamente');
    } catch (error) {
        console.error('\n🚨 Algunas pruebas fallaron:', error.message);
        process.exit(1);
    }
})();